package trace.backend.services;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import trace.backend.dto.ChatMessageResponse;
import trace.backend.dto.ChatSessionResponse;
import trace.backend.dto.CreateChatSessionRequest;
import trace.backend.entity.ChatMessage;
import trace.backend.entity.ChatSession;
import trace.backend.entity.IndexStatus;
import trace.backend.entity.MessageRole;
import trace.backend.entity.Repository;
import trace.backend.exceptions.BadRequestException;
import trace.backend.exceptions.NotFoundException;
import trace.backend.repository.ChatMessageRepository;
import trace.backend.repository.ChatSessionRepository;
import trace.backend.services.ai.ChatContextCache;
import trace.backend.services.ai.ChatGenerationConfig;
import trace.backend.services.ai.ChatStreamHandler;
import trace.backend.services.ai.ChatStreamContext;
import trace.backend.services.ai.CitationMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;

/**
 * Chat sessions and the RAG chat pipeline entry point.
 *
 * <p>{@link #streamReply} delegates the complete request lifecycle to a managed SSE task,
 * including session validation and user-message persistence, so the response opens immediately.
 * Retrieval and generation are implemented in dedicated classes under {@code service.ai}.
 */
@Service
@RequiredArgsConstructor
@Slf4j
public class ChatService {

    private final ChatSessionRepository chatSessionRepository;
    private final ChatMessageRepository chatMessageRepository;
    private final RepoService repoService;
    private final ChatStreamHandler chatStreamHandler;
    private final CitationMapper citationMapper;
    private final ChatContextCache chatContextCache;

    @Transactional
    public ChatSessionResponse createSession(UUID userId, CreateChatSessionRequest request) {
        Repository repo = repoService.requireOwned(request.repositoryId(), userId);
        if (repo.getIndexStatus() != IndexStatus.READY) {
            throw new BadRequestException("Repository must be indexed before chatting");
        }

        String title = request.title() != null && !request.title().isBlank()
                ? request.title()
                : "Chat with " + repo.getFullName();

        ChatSession session = ChatSession.builder()
                .userId(userId)
                .repositoryId(repo.getId())
                .title(title)
                .build();
        session = chatSessionRepository.save(session);
        return toSessionResponse(session);
    }

    @Transactional(readOnly = true)
    public List<ChatSessionResponse> listSessions(UUID userId, UUID repositoryId) {
        repoService.requireOwned(repositoryId, userId);
        return chatSessionRepository
                .findByUserIdAndRepositoryIdOrderByCreatedAtDesc(userId, repositoryId)
                .stream()
                .map(this::toSessionResponse)
                .toList();
    }

    @Transactional(readOnly = true)
    public List<ChatMessageResponse> getMessages(UUID userId, UUID sessionId) {
        ChatSession session = requireSession(userId, sessionId);
        return chatMessageRepository.findBySessionIdOrderByCreatedAtAsc(session.getId()).stream()
                .map(this::toMessageResponse)
                .toList();
    }

    @Transactional(readOnly = true)
    public ChatSession requireSession(UUID userId, UUID sessionId) {
        return chatSessionRepository.findByIdAndUserId(sessionId, userId)
                .orElseThrow(() -> new NotFoundException("Chat session not found"));
    }

    public SseEmitter streamReply(UUID userId, UUID sessionId, String userContent) {
        return streamReply(userId, sessionId, userContent, ChatGenerationConfig.defaults());
    }

    public SseEmitter streamReply(
            UUID userId,
            UUID sessionId,
            String userContent,
            ChatGenerationConfig config) {
        // Keep all database work inside the managed SSE task. Returning the emitter first
        // ensures lookup or pool delays cannot prevent the response from opening.
        return chatStreamHandler.stream(sessionId, userContent, config,
                () -> prepareStreamContext(userId, sessionId));
    }

    private ChatStreamContext prepareStreamContext(UUID userId, UUID sessionId) {
        ChatStreamContext cached = chatContextCache.get(userId, sessionId);
        if (cached != null) {
            return cached;
        }

        log.info("{} [CHAT] session+repo lookup start sessionId={}", Instant.now(), sessionId);
        ChatSessionRepository.SessionRepoSummary summary = chatSessionRepository
                .findSessionWithRepo(sessionId, userId)
                .orElseThrow(() -> new NotFoundException("Chat session not found"));

        if (summary.indexStatus() != IndexStatus.READY) {
            throw new BadRequestException("Repository is not ready for chat");
        }
        log.info("{} [CHAT] session+repo ready sessionId={} repositoryId={}",
                Instant.now(), sessionId, summary.repositoryId());

        String repoVersion = summary.treeSha() != null && !summary.treeSha().isBlank()
                ? summary.treeSha()
                : (summary.indexedAt() != null ? summary.indexedAt().toString() : "v0");

        ChatStreamContext context = new ChatStreamContext(
                userId,
                summary.sessionId(),
                summary.repositoryId(),
                summary.repositoryFullName(),
                repoVersion);
        chatContextCache.put(userId, sessionId, context);
        return context;
    }

    private ChatSessionResponse toSessionResponse(ChatSession session) {
        return new ChatSessionResponse(
                session.getId(),
                session.getRepositoryId(),
                session.getTitle(),
                session.getCreatedAt());
    }

    private ChatMessageResponse toMessageResponse(ChatMessage message) {
        return new ChatMessageResponse(
                message.getId(),
                message.getRole(),
                message.getContent(),
                citationMapper.fromJson(message.getCitations()),
                message.getCreatedAt());
    }
}
