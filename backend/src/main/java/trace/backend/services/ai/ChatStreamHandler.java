package trace.backend.services.ai;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Supplier;

import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.model.ChatModel;
import org.springframework.ai.google.genai.GoogleGenAiChatOptions;
import org.springframework.ai.openai.OpenAiChatOptions;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.task.AsyncTaskExecutor;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import trace.backend.dto.ChatMessageResponse;
import trace.backend.dto.CitationDto;
import trace.backend.entity.ChatMessage;
import trace.backend.entity.MessageRole;
import trace.backend.repository.ChatMessageRepository;
import lombok.extern.slf4j.Slf4j;

/** Owns the complete chat request and guarantees a terminal SSE event on every path. */
@Component
@Slf4j
public class ChatStreamHandler {

    private static final long EMBEDDING_TIMEOUT_SECONDS = 15;
    private static final long CHAT_TIMEOUT_SECONDS = 60;
    private static final long HEARTBEAT_INTERVAL_SECONDS = 4;
    private static final long QA_CACHE_TTL_MS = TimeUnit.MINUTES.toMillis(10);
    private static final int MAX_QA_CACHE_ENTRIES = 500;
    private static final long COOLDOWN_429_MS = TimeUnit.MINUTES.toMillis(5);
    private static final long COOLDOWN_503_MS = TimeUnit.SECONDS.toMillis(60);
    private static final long COOLDOWN_404_MS = TimeUnit.MINUTES.toMillis(30);

    private static final ScheduledExecutorService HEARTBEAT_SCHEDULER =
            Executors.newSingleThreadScheduledExecutor(r -> {
                Thread t = new Thread(r, "sse-heartbeat");
                t.setDaemon(true);
                return t;
            });

    // Bounded LRU cache (avoids full-cache .clear() eviction cliffs)
    private final Map<String, CachedQaAnswer> qaCache = Collections.synchronizedMap(
            new LinkedHashMap<>(256, 0.75f, true) {
                @Override
                protected boolean removeEldestEntry(Map.Entry<String, CachedQaAnswer> eldest) {
                    return size() > MAX_QA_CACHE_ENTRIES;
                }
            });

    // Per-model circuit breaker cooldown timestamps (epoch ms)
    private final ConcurrentHashMap<String, Long> modelCooldownUntil = new ConcurrentHashMap<>();

    private final ChatClient groqChatClient;
    private final ChatClient geminiFallbackChatClient;
    private final ChatMessageRepository chatMessageRepository;
    private final CitationMapper citationMapper;
    private final CodeContextRetriever codeContextRetriever;
    private final ChatPromptBuilder chatPromptBuilder;

    @Value("${app.groq.fast-model:llama-3.1-8b-instant}")
    private String configuredFastModel;

    @Value("${app.groq.chat.models:llama-3.3-70b-versatile,llama-3.1-8b-instant,openai/gpt-oss-20b,openai/gpt-oss-120b}")
    private String configuredGroqModels;

    @Value("${app.groq.reasoning-effort:low}")
    private String configuredReasoningEffort;

    @Value("${app.groq.max-tokens:1024}")
    private int configuredMaxTokens;

    @Autowired
    @Qualifier("chatExecutor")
    private AsyncTaskExecutor chatExecutor;

    @Autowired
    @Qualifier("ragExecutor")
    private AsyncTaskExecutor ragExecutor;

    @Autowired
    @Qualifier("ioExecutor")
    private AsyncTaskExecutor ioExecutor;

    @Autowired(required = false)
    private JdbcTemplate jdbcTemplate;

    public ChatStreamHandler(
            @Qualifier("openAiChatModel") ChatModel groqChatModel,
            @Qualifier("geminiFallbackChatModel") ChatModel geminiFallbackChatModel,
            ChatMessageRepository chatMessageRepository,
            CitationMapper citationMapper,
            CodeContextRetriever codeContextRetriever,
            ChatPromptBuilder chatPromptBuilder) {
        this.groqChatClient = ChatClient.builder(groqChatModel).build();
        this.geminiFallbackChatClient = ChatClient.builder(geminiFallbackChatModel).build();
        this.chatMessageRepository = chatMessageRepository;
        this.citationMapper = citationMapper;
        this.codeContextRetriever = codeContextRetriever;
        this.chatPromptBuilder = chatPromptBuilder;
    }

    public SseEmitter stream(
            UUID requestedSessionId,
            String question,
            Supplier<ChatStreamContext> contextSupplier) {
        return stream(requestedSessionId, question, ChatGenerationConfig.defaults(), contextSupplier);
    }

    public SseEmitter stream(
            UUID requestedSessionId,
            String question,
            ChatGenerationConfig config,
            Supplier<ChatStreamContext> contextSupplier) {

        ChatGenerationConfig effectiveConfig = config != null ? config : ChatGenerationConfig.defaults();
        SseEmitter emitter = new SseEmitter(RagSettings.STREAM_TIMEOUT_MS);
        Object sseLock = new Object();
        AtomicBoolean terminalSent = new AtomicBoolean(false);
        AtomicBoolean cancelWorker = new AtomicBoolean(false);
        AtomicReference<Future<?>> workerTask = new AtomicReference<>();
        AtomicReference<String> stage = new AtomicReference<>("SESSION");
        log.info("{} [CHAT] received sessionId={} temp={} maxTokens={} topK={} threshold={} content={}",
                now(), requestedSessionId, effectiveConfig.temperature(), effectiveConfig.maxTokens(),
                effectiveConfig.topK(), effectiveConfig.similarityThreshold(), question);
        emitter.onTimeout(() -> {
            log.error("{} [SSE] timeout sessionId={} stage={}", now(), requestedSessionId, stage.get());
            sendError(emitter, sseLock, terminalSent, "Chat request timed out. Please try again.");
            cancelWorker.set(true);
            cancelTask(workerTask.get());
        });
        emitter.onError(error -> {
            log.error("{} [SSE] transport error sessionId={}", now(), requestedSessionId, error);
            sendError(emitter, sseLock, terminalSent, "The chat connection failed. Please try again.");
            cancelWorker.set(true);
            cancelTask(workerTask.get());
        });
        emitter.onCompletion(() -> {
            if (!terminalSent.get()) {
                cancelWorker.set(true);
                cancelTask(workerTask.get());
            }
        });

        try {
            // Open the SSE response before database lookup or RAG work begins.
            log.info("{} [SSE] sending stream-open sessionId={}", now(), requestedSessionId);
            safeSend(emitter, sseLock, SseEmitter.event().comment("connected"));
            Future<?> task = chatExecutor.submit(() -> runChat(
                    emitter, sseLock, terminalSent, stage, requestedSessionId, question, effectiveConfig, contextSupplier));
            workerTask.set(task);
            if (cancelWorker.get()) {
                cancelTask(task);
            }
        } catch (Exception error) {
            log.error("{} [CHAT] could not schedule sessionId={}", now(), requestedSessionId, error);
            sendError(emitter, sseLock, terminalSent, "Chat is busy. Please try again shortly.");
        }
        return emitter;
    }

    private void runChat(
            SseEmitter emitter,
            Object sseLock,
            AtomicBoolean terminalSent,
            AtomicReference<String> stage,
            UUID requestedSessionId,
            String question,
            ChatGenerationConfig config,
            Supplier<ChatStreamContext> contextSupplier) {
        UUID sessionId = requestedSessionId;
        long requestStartMs = System.currentTimeMillis();
        AtomicBoolean anyTokenSent = new AtomicBoolean(false);
        ScheduledFuture<?> heartbeat = HEARTBEAT_SCHEDULER.scheduleAtFixedRate(() -> {
            if (terminalSent.get() || anyTokenSent.get()) {
                return;
            }
            try {
                safeSend(emitter, sseLock, SseEmitter.event().comment("keepalive"));
            } catch (Exception ignored) {
                // Client disconnected or stream closed; main flow will clean up.
            }
        }, HEARTBEAT_INTERVAL_SECONDS, HEARTBEAT_INTERVAL_SECONDS, TimeUnit.SECONDS);

        try {
            stage.set("SESSION");
            ChatStreamContext streamContext = contextSupplier.get();
            long sessionMs = System.currentTimeMillis() - requestStartMs;
            sessionId = streamContext.sessionId();
            UUID finalSessionId = sessionId;

            ChatPromptBuilder.QueryTier queryTier = chatPromptBuilder.classifyQuery(question);

            UUID userMessageId = UUID.randomUUID();
            Instant userCreatedAt = Instant.now();
            ChatMessageResponse userResponse = new ChatMessageResponse(
                    userMessageId, MessageRole.USER, question, List.of(), userCreatedAt);

            // Check Q&A response cache immediately (0ms when ChatContextCache hits)
            String qaCacheKey = buildQaCacheKey(
                    streamContext.repositoryId(), streamContext.repositoryVersion(), question, config);
            CachedQaAnswer cachedAnswer = getCachedQaAnswer(qaCacheKey);
            if (cachedAnswer != null) {
                log.info("{} [CHAT] qaCacheHit=true tier={} sessionId={} repo={} savedEmbedAndLlm=true latencyMs={}",
                        now(), queryTier, sessionId, streamContext.repositoryId(), System.currentTimeMillis() - requestStartMs);
                heartbeat.cancel(false);
                UUID assistantId = UUID.randomUUID();
                Instant assistantCreatedAt = ensureAfter(userCreatedAt);
                String citationsJson = citationMapper.toJson(cachedAnswer.citations);

                // Emit all SSE events immediately and persist both rows in one async batched JDBC call
                safeSend(emitter, sseLock, SseEmitter.event().name("user_message").data(userResponse));
                anyTokenSent.set(true);
                safeSend(emitter, sseLock, SseEmitter.event().name("token").data(cachedAnswer.answer));
                safeSend(emitter, sseLock, SseEmitter.event().name("model").data(Map.of(
                        "model", cachedAnswer.model,
                        "provider", cachedAnswer.provider,
                        "fallback", cachedAnswer.usedFallback,
                        "cached", true)));
                safeSend(emitter, sseLock, SseEmitter.event().name("assistant_message").data(
                        new ChatMessageResponse(assistantId, MessageRole.ASSISTANT, cachedAnswer.answer,
                                cachedAnswer.citations, assistantCreatedAt)));
                sendDone(emitter, sseLock, terminalSent, sessionId);

                persistMessagesAsync(List.of(
                        new PendingMessage(userMessageId, finalSessionId, MessageRole.USER, question, null, userCreatedAt),
                        new PendingMessage(assistantId, finalSessionId, MessageRole.ASSISTANT, cachedAnswer.answer, citationsJson, assistantCreatedAt)
                ));
                return;
            }

            // Emit user_message immediately and persist it in the background while RAG retrieval runs in parallel
            persistMessagesAsync(List.of(
                    new PendingMessage(userMessageId, finalSessionId, MessageRole.USER, question, null, userCreatedAt)
            ));
            safeSend(emitter, sseLock, SseEmitter.event().name("user_message").data(userResponse));

            long ragStartMs = System.currentTimeMillis();
            RetrievedContext retrievedContext;
            if (queryTier == ChatPromptBuilder.QueryTier.TRIVIAL) {
                // Skip Cloudflare embedding + PgVector round-trip for simple greetings/acknowledgements
                retrievedContext = new RetrievedContext(List.of(), "");
            } else {
                stage.set("EMBED/VECTOR");
                int topK = config.customTopK()
                        ? config.topK()
                        : (queryTier == ChatPromptBuilder.QueryTier.SIMPLE ? Math.min(3, config.topK()) : config.topK());
                int tierContextChars = switch (queryTier) {
                    case SIMPLE -> 2200;
                    case STANDARD -> 3200;
                    default -> RagSettings.MAX_CONTEXT_CHARS;
                };
                int maxContextChars = config.customTopK()
                        ? Math.min(10_000, Math.max(tierContextChars, topK * 950))
                        : tierContextChars;
                double similarityThreshold = config.similarityThreshold();
                log.info("{} [EMBED] start tier={} topK={} maxChars={} threshold={} sessionId={}",
                        now(), queryTier, topK, maxContextChars, similarityThreshold, sessionId);
                Future<RetrievedContext> retrieval = ragExecutor.submit(
                        () -> codeContextRetriever.retrieve(
                                streamContext.userId(),
                                streamContext.repositoryId(),
                                question,
                                topK,
                                maxContextChars,
                                similarityThreshold));

                try {
                    retrievedContext = retrieval.get(EMBEDDING_TIMEOUT_SECONDS, TimeUnit.SECONDS);
                } catch (Exception error) {
                    retrieval.cancel(true);
                    throw error;
                }
            }
            long ragMs = System.currentTimeMillis() - ragStartMs;
            log.info("{} [VECTOR] done tier={} sessionId={} dims={} citations={} sessionMs={} ragMs={} elapsedMs={}",
                    now(), queryTier, sessionId, codeContextRetriever.embeddingDimensions(),
                    retrievedContext.citations().size(), sessionMs, ragMs, System.currentTimeMillis() - requestStartMs);

            String systemPrompt = chatPromptBuilder.systemPrompt(
                    streamContext.repositoryName(), queryTier, config.systemPrompt());
            String prompt = queryTier == ChatPromptBuilder.QueryTier.TRIVIAL
                    ? question
                    : (retrievedContext.citations().isEmpty()
                            ? "No relevant code chunks matched the current similarity threshold.\n\nUser question:\n" + question
                            : chatPromptBuilder.userPrompt(retrievedContext.contextText(), question));
            int estInputTokens = (systemPrompt.length() + prompt.length()) / 4;

            int targetMaxTokens;
            if (queryTier == ChatPromptBuilder.QueryTier.TRIVIAL) {
                targetMaxTokens = Math.min(120, config.maxTokens());
            } else if (config.customMaxTokens()) {
                targetMaxTokens = config.maxTokens();
            } else {
                int baseMax = Math.min(config.maxTokens(), configuredMaxTokens);
                targetMaxTokens = switch (queryTier) {
                    case SIMPLE -> Math.min(280, baseMax);
                    case STANDARD -> Math.min(600, baseMax);
                    default -> baseMax;
                };
            }
            double targetTemperature = config.temperature();

            stage.set("AI");
            List<String> triedModels = new ArrayList<>();
            String successfulModel = null;
            String successfulProvider = null;
            Throwable lastModelError = null;
            boolean sawQuotaFailure = false;

            StringBuilder fullReply = new StringBuilder();
            AtomicInteger tokenCount = new AtomicInteger(0);
            AtomicLong firstTokenMs = new AtomicLong(-1L);
            boolean noRelevantCode = queryTier != ChatPromptBuilder.QueryTier.TRIVIAL
                    && retrievedContext.citations().isEmpty();

            List<String> models = selectModelsForTier(queryTier);

            for (String model : models) {
                if (isModelInCooldown(model)) {
                    log.info("{} [AI] skipping cooled-down model={} sessionId={}", now(), model, sessionId);
                    continue;
                }
                triedModels.add(model);
                try {
                    String shortModel = shortModel(model);
                    log.info("{} [AI] provider=Groq tier={} model={} temp={} maxTokens={} sessionId={} estInputTokens={}",
                            now(), queryTier, shortModel, targetTemperature, targetMaxTokens, sessionId, estInputTokens);
                    long aiStartMs = System.currentTimeMillis();

                    OpenAiChatOptions.Builder optionsBuilder = OpenAiChatOptions.builder()
                            .model(model)
                            .temperature(targetTemperature)
                            .maxCompletionTokens(targetMaxTokens);
                    if (model.contains("gpt-oss") && configuredReasoningEffort != null && !configuredReasoningEffort.isBlank()) {
                        optionsBuilder.reasoningEffort(configuredReasoningEffort.trim());
                    }

                    groqChatClient.prompt()
                            .options(optionsBuilder)
                            .system(systemPrompt)
                            .user(prompt)
                            .stream()
                            .content()
                            .timeout(Duration.ofSeconds(CHAT_TIMEOUT_SECONDS))
                            .doOnNext(token -> emitToken(
                                    emitter, sseLock, heartbeat, fullReply, anyTokenSent, tokenCount, firstTokenMs,
                                    noRelevantCode, finalSessionId, requestStartMs, token))
                            .blockLast(Duration.ofSeconds(CHAT_TIMEOUT_SECONDS));

                    modelCooldownUntil.remove(model);
                    successfulModel = model;
                    successfulProvider = "Groq";
                    long aiMs = System.currentTimeMillis() - aiStartMs;
                    long totalMs = System.currentTimeMillis() - requestStartMs;
                    log.info("{} [AI] success provider=Groq tier={} model={} sessionId={} estInputTokens={} tokenCount={} sessionMs={} ragMs={} ttftMs={} aiMs={} totalMs={}",
                            now(), queryTier, shortModel, sessionId, estInputTokens, tokenCount.get(),
                            sessionMs, ragMs, firstTokenMs.get(), aiMs, totalMs);
                    break;
                } catch (Exception modelError) {
                    if (anyTokenSent.get() || modelError instanceof UncheckedIOException) {
                        throw modelError;
                    }
                    lastModelError = unwrap(modelError);
                    int status = httpStatus(lastModelError);
                    log.warn("{} [AI] provider=Groq model={} failed status={} sessionId={}", now(), model, status, sessionId, modelError);
                    if (status == 401) {
                        log.error("{} [AI] provider=Groq fatal 401 model={} - not trying fallback", now(), model);
                        throw new ProviderStreamException("GROQ_FATAL", model, triedModels, errorMessage(lastModelError), null, 0, lastModelError);
                    }
                    if (status == 429) {
                        sawQuotaFailure = true;
                        putModelCooldown(model, COOLDOWN_429_MS);
                    } else if (status == 503) {
                        putModelCooldown(model, COOLDOWN_503_MS);
                    } else if (status == 404) {
                        putModelCooldown(model, COOLDOWN_404_MS);
                    } else {
                        log.warn("{} [AI] provider=Groq model={} failed status={}, moving to Gemini fallback", now(), model, status, modelError);
                        break;
                    }
                }
            }
            if (successfulModel == null) {
                try {
                    String geminiModel = "gemini-2.5-flash";
                    triedModels.add(geminiModel);
                    log.info("{} [AI] provider=Gemini model={} temp={} maxTokens={} last-resort fallback sessionId={} estInputTokens={}",
                            now(), geminiModel, targetTemperature, targetMaxTokens, sessionId, estInputTokens);
                    long aiStartMs = System.currentTimeMillis();

                    GoogleGenAiChatOptions.Builder geminiOptions = GoogleGenAiChatOptions.builder()
                            .model(geminiModel)
                            .temperature(targetTemperature)
                            .maxOutputTokens(targetMaxTokens);

                    geminiFallbackChatClient.prompt()
                            .options(geminiOptions)
                            .system(systemPrompt)
                            .user(prompt)
                            .stream()
                            .content()
                            .timeout(Duration.ofSeconds(CHAT_TIMEOUT_SECONDS))
                            .doOnNext(token -> emitToken(
                                    emitter, sseLock, heartbeat, fullReply, anyTokenSent, tokenCount, firstTokenMs,
                                    noRelevantCode, finalSessionId, requestStartMs, token))
                            .blockLast(Duration.ofSeconds(CHAT_TIMEOUT_SECONDS));

                    successfulModel = geminiModel;
                    successfulProvider = "Gemini";
                    long aiMs = System.currentTimeMillis() - aiStartMs;
                    long totalMs = System.currentTimeMillis() - requestStartMs;
                    log.info("{} [AI] success provider=Gemini model={} sessionId={} estInputTokens={} tokenCount={} ttftMs={} aiMs={} totalMs={}",
                            now(), geminiModel, sessionId, estInputTokens, tokenCount.get(), firstTokenMs.get(), aiMs, totalMs);
                } catch (Exception fallbackError) {
                    if (anyTokenSent.get() || fallbackError instanceof UncheckedIOException) {
                        throw fallbackError;
                    }
                    lastModelError = unwrap(fallbackError);
                    int status = httpStatus(lastModelError);
                    String code = sawQuotaFailure || status == 429 ? "QUOTA_EXCEEDED"
                            : status == 503 ? "MODEL_OVERLOADED" : "AI_ERROR";
                    String message = sawQuotaFailure
                            ? "Groq models exhausted quota/availability and Gemini fallback failed: " + errorMessage(lastModelError)
                            : "All Groq models and Gemini fallback failed: " + errorMessage(lastModelError);
                    throw new ProviderStreamException(code, "gemini-2.5-flash", triedModels, message,
                            sawQuotaFailure || status == 429 ? "15h45m" : null,
                            sawQuotaFailure || status == 429 ? 56715 : 0, lastModelError);
                }
            }

            heartbeat.cancel(false);
            stage.set("SSE");
            if (fullReply.isEmpty()) {
                fullReply.append("I couldn't generate a reply. Please try again.");
                log.info("{} [SSE] sending fallback token sessionId={}", now(), sessionId);
                safeSend(emitter, sseLock, SseEmitter.event().name("token").data(fullReply.toString()));
            }

            boolean usedFallback = !"Groq".equals(successfulProvider) || !models.isEmpty() && !successfulModel.equals(models.get(0));
            String finalReplyText = fullReply.toString();
            List<CitationDto> finalCitations = List.copyOf(retrievedContext.citations());
            UUID assistantId = UUID.randomUUID();
            Instant assistantCreatedAt = ensureAfter(userCreatedAt);
            String citationsJson = citationMapper.toJson(finalCitations);

            if (anyTokenSent.get() && !finalReplyText.isEmpty()) {
                putCachedQaAnswer(qaCacheKey, new CachedQaAnswer(
                        finalReplyText,
                        finalCitations,
                        successfulModel,
                        successfulProvider,
                        usedFallback,
                        System.currentTimeMillis()));
            }
            safeSend(emitter, sseLock, SseEmitter.event().name("model").data(Map.of("model", successfulModel,
                    "provider", successfulProvider, "fallback", usedFallback)));
            log.info("{} [SSE] sending assistant_message sessionId={}", now(), sessionId);
            safeSend(emitter, sseLock, SseEmitter.event().name("assistant_message").data(
                    new ChatMessageResponse(assistantId, MessageRole.ASSISTANT, finalReplyText,
                            finalCitations, assistantCreatedAt)));
            sendDone(emitter, sseLock, terminalSent, sessionId);

            // Persist assistant reply asynchronously after closing the SSE stream so DB latency adds 0ms to user UX
            persistMessagesAsync(List.of(
                    new PendingMessage(assistantId, finalSessionId, MessageRole.ASSISTANT, finalReplyText, citationsJson, assistantCreatedAt)
            ));
        } catch (Exception error) {
            Throwable cause = error instanceof ExecutionException && error.getCause() != null
                    ? error.getCause() : error;
            log.error("{} [{}] error sessionId={} type={}", now(), stage.get(), sessionId,
                    cause.getClass().getSimpleName(), cause);
            if (cause instanceof ProviderStreamException providerError) {
                sendError(emitter, sseLock, terminalSent, providerError);
            } else {
                sendError(emitter, sseLock, terminalSent, errorMessage(cause));
            }
        } finally {
            heartbeat.cancel(false);
            if (!terminalSent.get()) {
                sendError(emitter, sseLock, terminalSent, "Chat ended without a terminal event. Please try again.");
            }
        }
    }

    private void emitToken(
            SseEmitter emitter,
            Object sseLock,
            ScheduledFuture<?> heartbeat,
            StringBuilder fullReply,
            AtomicBoolean anyTokenSent,
            AtomicInteger tokenCount,
            AtomicLong firstTokenMs,
            boolean noRelevantCode,
            UUID sessionId,
            long requestStartMs,
            String token) {
        if (token == null || token.isEmpty()) {
            return;
        }
        try {
            if (anyTokenSent.compareAndSet(false, true)) {
                heartbeat.cancel(false);
                firstTokenMs.set(System.currentTimeMillis() - requestStartMs);
                if (noRelevantCode) {
                    String noContextNotice = "No relevant code found, answering from general context.\n\n";
                    fullReply.append(noContextNotice);
                    safeSend(emitter, sseLock, SseEmitter.event().name("token").data(noContextNotice));
                }
            }
            fullReply.append(token);
            tokenCount.incrementAndGet();
            log.debug("{} [SSE] streaming token sessionId={} length={}", now(), sessionId, token.length());
            safeSend(emitter, sseLock, SseEmitter.event().name("token").data(token));
        } catch (IOException ioEx) {
            throw new UncheckedIOException("Failed to stream SSE token", ioEx);
        }
    }

    private static void safeSend(SseEmitter emitter, Object sseLock, SseEmitter.SseEventBuilder event) throws IOException {
        synchronized (sseLock) {
            emitter.send(event);
        }
    }

    private void sendDone(SseEmitter emitter, Object sseLock, AtomicBoolean terminalSent, UUID sessionId) throws Exception {
        if (!terminalSent.compareAndSet(false, true)) {
            return;
        }
        try {
            log.info("{} [SSE] sending done sessionId={}", now(), sessionId);
            synchronized (sseLock) {
                emitter.send(SseEmitter.event().name("done").data("[DONE]"));
                emitter.complete();
            }
            log.info("{} [SSE] sent assistant done sessionId={}", now(), sessionId);
        } catch (Exception error) {
            log.error("{} [SSE] failed to send done sessionId={}", now(), sessionId, error);
            emitter.completeWithError(error);
            throw error;
        }
    }

    private void sendError(SseEmitter emitter, Object sseLock, AtomicBoolean terminalSent, String message) {
        if (!terminalSent.compareAndSet(false, true)) {
            return;
        }
        String safeMessage = message == null || message.isBlank() ? "Chat failed. Please try again." : message;
        if (safeMessage.length() > 400) {
            safeMessage = safeMessage.substring(0, 400);
        }
        try {
            log.info("{} [SSE] sending error message={}", now(), safeMessage);
            synchronized (sseLock) {
                emitter.send(SseEmitter.event().name("error")
                        .data(Map.of("type", "error", "message", safeMessage), MediaType.APPLICATION_JSON));
                emitter.send(SseEmitter.event().name("done").data("[DONE]"));
                emitter.complete();
            }
            log.info("{} [SSE] sent error done message={}", now(), safeMessage);
        } catch (Exception sendError) {
            log.error("{} [SSE] failed to send terminal error", now(), sendError);
            emitter.completeWithError(sendError);
        }
    }

    private void sendError(SseEmitter emitter, Object sseLock, AtomicBoolean terminalSent, ProviderStreamException error) {
        if (!terminalSent.compareAndSet(false, true)) return;
        Map<String, Object> payload = new java.util.HashMap<>();
        payload.put("type", "error"); payload.put("code", error.code); payload.put("model", error.model);
        payload.put("triedModels", error.triedModels); payload.put("message", error.getMessage());
        if (error.retryAfter != null) payload.put("retryAfter", error.retryAfter);
        if (error.retryAfterSeconds > 0) payload.put("retryAfterSeconds", error.retryAfterSeconds);
        try {
            log.info("{} [SSE] sent assistant error code={} model={}", now(), error.code, error.model);
            synchronized (sseLock) {
                emitter.send(SseEmitter.event().name("error").data(payload, MediaType.APPLICATION_JSON));
                emitter.send(SseEmitter.event().name("done").data("[DONE]"));
                emitter.complete();
            }
        } catch (Exception sendError) { emitter.completeWithError(sendError); }
    }

    private List<String> selectModelsForTier(ChatPromptBuilder.QueryTier tier) {
        List<String> configured = Arrays.stream(configuredGroqModels.split(","))
                .map(String::trim)
                .filter(m -> !m.isEmpty())
                .toList();
        if (configured.isEmpty()) {
            configured = List.of("llama-3.3-70b-versatile", "llama-3.1-8b-instant", "openai/gpt-oss-20b");
        }
        String fastModel = (configuredFastModel == null || configuredFastModel.isBlank())
                ? "llama-3.1-8b-instant"
                : configuredFastModel.trim();

        List<String> ordered = new ArrayList<>();
        if (tier == ChatPromptBuilder.QueryTier.TRIVIAL || tier == ChatPromptBuilder.QueryTier.SIMPLE) {
            // Instant non-reasoning model first for sub-200ms TTFT on small/direct questions
            ordered.add(fastModel);
            for (String m : configured) {
                if (!m.equals(fastModel)) {
                    ordered.add(m);
                }
            }
            return ordered;
        }

        // For STANDARD / DEEP queries, prefer non-reasoning fast models ahead of reasoning gpt-oss models
        for (String m : configured) {
            if (!m.contains("gpt-oss")) {
                ordered.add(m);
            }
        }
        if (ordered.isEmpty()) {
            ordered.add("llama-3.3-70b-versatile");
        }
        for (String m : configured) {
            if (!ordered.contains(m)) {
                ordered.add(m);
            }
        }
        return ordered;
    }

    private boolean isModelInCooldown(String model) {
        Long until = modelCooldownUntil.get(model);
        if (until == null) {
            return false;
        }
        if (System.currentTimeMillis() < until) {
            return true;
        }
        modelCooldownUntil.remove(model, until);
        return false;
    }

    private void putModelCooldown(String model, long durationMs) {
        modelCooldownUntil.put(model, System.currentTimeMillis() + durationMs);
    }

    private void cancelTask(Future<?> task) {
        if (task != null) {
            task.cancel(true);
        }
    }

    private String errorMessage(Throwable error) {
        if (error instanceof TimeoutException) {
            return "Chat timed out while retrieving code or waiting for the AI provider. Please retry.";
        }
        String message = error.getMessage();
        return message == null || message.isBlank() ? error.getClass().getSimpleName() : message;
    }

    private static Throwable unwrap(Throwable error) {
        Throwable current = error;
        while (current.getCause() != null && current.getCause() != current) current = current.getCause();
        return current;
    }

    private static int httpStatus(Throwable error) {
        for (Throwable current = error; current != null; current = current.getCause()) {
            try {
                Object code = current.getClass().getMethod("code").invoke(current);
                if (code instanceof Number number) return number.intValue();
            } catch (ReflectiveOperationException ignored) { }
            try {
                Object status = current.getClass().getMethod("statusCode").invoke(current);
                if (status instanceof Number number) return number.intValue();
            } catch (ReflectiveOperationException ignored) { }
        }
        String message = String.valueOf(error.getMessage()).toLowerCase(Locale.ROOT);
        if (message.contains("429") || message.contains("quota_exceeded")) return 429;
        if (message.contains("503") || message.contains("model_overloaded")) return 503;
        if (message.contains("401")) return 401;
        if (message.contains("404")) return 404;
        if (message.contains("400")) return 400;
        return 0;
    }

    private static String shortModel(String model) {
        int separator = model.lastIndexOf('/');
        return separator >= 0 ? model.substring(separator + 1) : model;
    }

    private static final class ProviderStreamException extends RuntimeException {
        final String code, model, retryAfter;
        final List<String> triedModels;
        final long retryAfterSeconds;
        ProviderStreamException(String code, String model, List<String> triedModels, String message,
                String retryAfter, long retryAfterSeconds, Throwable cause) {
            super(message, cause); this.code = code; this.model = model; this.triedModels = List.copyOf(triedModels);
            this.retryAfter = retryAfter; this.retryAfterSeconds = retryAfterSeconds;
        }
    }

    private ChatMessageResponse toMessageResponse(ChatMessage message) {
        return new ChatMessageResponse(
                message.getId(), message.getRole(), message.getContent(),
                citationMapper.fromJson(message.getCitations()), message.getCreatedAt());
    }

    private static String now() {
        return Instant.now().toString();
    }

    private static String buildQaCacheKey(
            UUID repoId, String repoVersion, String question, ChatGenerationConfig config) {
        String normalized = question == null ? "" : question.trim().replaceAll("\\s+", " ").toLowerCase(Locale.ROOT);
        String cfg = config == null ? ChatGenerationConfig.defaults().cacheKeySegment() : config.cacheKeySegment();
        return repoId + ":" + (repoVersion == null ? "v0" : repoVersion) + ":" + cfg + ":" + normalized;
    }

    private CachedQaAnswer getCachedQaAnswer(String key) {
        CachedQaAnswer entry = qaCache.get(key);
        if (entry != null) {
            if (System.currentTimeMillis() - entry.timestamp < QA_CACHE_TTL_MS) {
                return entry;
            }
            qaCache.remove(key);
        }
        return null;
    }

    private void putCachedQaAnswer(String key, CachedQaAnswer value) {
        qaCache.put(key, value);
    }

    private static Instant ensureAfter(Instant earlier) {
        Instant now = Instant.now();
        return now.isAfter(earlier) ? now : earlier.plusMillis(1);
    }

    private void persistMessagesAsync(List<PendingMessage> messages) {
        if (messages == null || messages.isEmpty()) {
            return;
        }
        CompletableFuture.runAsync(() -> persistMessages(messages), ioExecutor);
    }

    private void persistMessages(List<PendingMessage> messages) {
        if (jdbcTemplate != null) {
            try {
                jdbcTemplate.batchUpdate(
                        "INSERT INTO chat_messages (id, session_id, role, content, citations, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                        messages,
                        messages.size(),
                        (ps, msg) -> {
                            ps.setObject(1, msg.id);
                            ps.setObject(2, msg.sessionId);
                            ps.setString(3, msg.role.name());
                            ps.setString(4, msg.content);
                            ps.setString(5, msg.citations);
                            ps.setTimestamp(6, Timestamp.from(msg.createdAt));
                        });
                return;
            } catch (Exception ex) {
                log.warn("Direct JDBC chat_messages batch insert failed, falling back to JPA: {}", ex.getMessage());
            }
        }
        try {
            List<ChatMessage> entities = messages.stream()
                    .map(msg -> ChatMessage.builder()
                            .sessionId(msg.sessionId)
                            .role(msg.role)
                            .content(msg.content)
                            .citations(msg.citations)
                            .createdAt(msg.createdAt)
                            .build())
                    .toList();
            chatMessageRepository.saveAll(entities);
        } catch (Exception ex) {
            log.error("Failed to persist chat messages asynchronously: {}", ex.getMessage(), ex);
        }
    }

    private record PendingMessage(
            UUID id,
            UUID sessionId,
            MessageRole role,
            String content,
            String citations,
            Instant createdAt) {}

    private record CachedQaAnswer(
            String answer,
            List<CitationDto> citations,
            String model,
            String provider,
            boolean usedFallback,
            long timestamp) {}
}
