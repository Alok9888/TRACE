package devPilot.backend.services.embedding;

import org.springframework.ai.embedding.EmbeddingModel;
import org.springframework.ai.embedding.EmbeddingResponse;
import org.springframework.ai.embedding.EmbeddingRequest;
import org.springframework.ai.embedding.Embedding;
import org.springframework.ai.embedding.EmbeddingResponseMetadata;
import org.springframework.ai.document.Document;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.JdbcTemplate;

import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.core.JsonToken;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.io.InputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.zip.GZIPInputStream;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Cloudflare Workers AI embedding service for @cf/baai/bge-small-en-v1.5 (384 dims).
 * Uses a single shared HTTP/2 HttpClient, batch size 64, separate LRU query & chunk caches,
 * fast query timeouts, and strict error propagation (no zero vectors).
 */
@ConditionalOnProperty(name = "embedding.provider", havingValue = "cloudflare", matchIfMissing = true)
public class CloudflareEmbeddingService implements EmbeddingModel {

    private static final Logger log = LoggerFactory.getLogger(CloudflareEmbeddingService.class);
    private static final String CLOUDFLARE_ACCOUNT_ID = "cdf43a252db0973fb702921884aec43b";
    private static final String MODEL_NAME = "@cf/baai/bge-small-en-v1.5";
    private static final String EMBEDDING_ENDPOINT = "/ai/run/" + MODEL_NAME;
    private static final URI EMBEDDING_URI = URI.create(
            "https://api.cloudflare.com/client/v4/accounts/" + CLOUDFLARE_ACCOUNT_ID + EMBEDDING_ENDPOINT);
    private static final int MODEL_DIMENSIONS = 384;
    private static final int EMBEDDING_BATCH_SIZE = 64;
    private static final int MAX_CONCURRENT_BATCH_CALLS = 3;
    private static final long[] INDEX_RETRY_BACKOFF_MS = {1500L, 3000L, 6000L};
    private static final long[] QUERY_RETRY_BACKOFF_MS = {400L, 1200L};
    private static final Duration INDEX_HTTP_TIMEOUT = Duration.ofSeconds(45);
    private static final Duration QUERY_HTTP_TIMEOUT = Duration.ofSeconds(8);
    private static final long CACHE_TTL_MS = TimeUnit.MINUTES.toMillis(30);
    private static final int MAX_QUERY_CACHE_ENTRIES = 1000;
    private static final int MAX_CHUNK_CACHE_ENTRIES = 3000;
    private static final Pattern HTTP_STATUS_PATTERN = Pattern.compile("HTTP\\s+(\\d{3})");
    private static final ObjectMapper OBJECT_MAPPER = new ObjectMapper();

    // Shared singleton HTTP/2 HttpClient (multiplexes concurrent batches over warm TLS connections)
    private static final HttpClient HTTP_CLIENT = HttpClient.newBuilder()
            .version(HttpClient.Version.HTTP_2)
            .connectTimeout(Duration.ofSeconds(5))
            .build();

    private static final ExecutorService BATCH_EXECUTOR = Executors.newVirtualThreadPerTaskExecutor();

    private final String authHeader;
    @SuppressWarnings("unused")
    private final JdbcTemplate jdbcTemplate;

    // Separate bounded LRU TTL caches so bulk repo indexing never evicts hot RAG query embeddings
    private final Map<String, CachedEmbedding> queryEmbeddingCache = createLruCache(MAX_QUERY_CACHE_ENTRIES);
    private final Map<String, CachedEmbedding> chunkEmbeddingCache = createLruCache(MAX_CHUNK_CACHE_ENTRIES);

    // Metrics tracking
    private final AtomicLong apiCallCount = new AtomicLong(0);
    private final AtomicLong cacheHitCount = new AtomicLong(0);
    private final AtomicLong cacheMissCount = new AtomicLong(0);
    private final ThreadLocal<AtomicInteger> retryCount = ThreadLocal.withInitial(() -> new AtomicInteger(0));

    private static Map<String, CachedEmbedding> createLruCache(int maxEntries) {
        return Collections.synchronizedMap(new LinkedHashMap<>(Math.min(maxEntries, 256), 0.75f, true) {
            @Override
            protected boolean removeEldestEntry(Map.Entry<String, CachedEmbedding> eldest) {
                return size() > maxEntries;
            }
        });
    }

    public CloudflareEmbeddingService(JdbcTemplate jdbcTemplate) {
        String token = System.getenv("CLOUDFLARE_API_TOKEN");
        this.authHeader = "Bearer " + token;
        this.jdbcTemplate = jdbcTemplate;
        log.info("CloudflareEmbeddingService initialized: model={} dims={} batchSize={} accountIdLen={}",
                MODEL_NAME, MODEL_DIMENSIONS, EMBEDDING_BATCH_SIZE, CLOUDFLARE_ACCOUNT_ID.length());
    }

    public long getApiCallCount() {
        return apiCallCount.get();
    }

    public long getCacheHitCount() {
        return cacheHitCount.get();
    }

    public long getCacheMissCount() {
        return cacheMissCount.get();
    }

    public double getCacheHitRate() {
        long hits = cacheHitCount.get();
        long total = hits + cacheMissCount.get();
        return total == 0 ? 0.0 : (hits * 100.0) / total;
    }

    @Override
    public EmbeddingResponse call(EmbeddingRequest embeddingRequest) {
        List<String> texts = embeddingRequest.getInstructions();
        long startTime = System.currentTimeMillis();
        AtomicInteger totalRetries = new AtomicInteger(0);

        float[][] resolved = new float[texts.size()][];
        List<Integer> missIndices = new ArrayList<>();
        List<String> missTexts = new ArrayList<>();
        int localHits = 0;

        for (int i = 0; i < texts.size(); i++) {
            String text = texts.get(i);
            float[] cached = getFromCache(chunkEmbeddingCache, text);
            if (cached == null) {
                cached = getFromCache(queryEmbeddingCache, normalizeQuery(text));
            }
            if (cached != null) {
                resolved[i] = cached;
                localHits++;
                cacheHitCount.incrementAndGet();
            } else {
                missIndices.add(i);
                missTexts.add(text);
                cacheMissCount.incrementAndGet();
            }
        }

        int batchesSent = 0;
        if (!missTexts.isEmpty()) {
            List<int[]> ranges = new ArrayList<>();
            for (int i = 0; i < missTexts.size(); i += EMBEDDING_BATCH_SIZE) {
                ranges.add(new int[]{i, Math.min(i + EMBEDDING_BATCH_SIZE, missTexts.size())});
            }
            batchesSent = ranges.size();

            if (ranges.size() == 1) {
                processBatchRange(missTexts, missIndices, resolved, ranges.get(0)[0], ranges.get(0)[1], totalRetries);
            } else {
                Semaphore batchSem = new Semaphore(MAX_CONCURRENT_BATCH_CALLS);
                List<CompletableFuture<Void>> futures = new ArrayList<>(ranges.size());
                for (int[] range : ranges) {
                    futures.add(CompletableFuture.runAsync(() -> {
                        try {
                            batchSem.acquire();
                        } catch (InterruptedException ie) {
                            Thread.currentThread().interrupt();
                            throw new RuntimeException("Interrupted waiting for embedding concurrency permit", ie);
                        }
                        try {
                            processBatchRange(missTexts, missIndices, resolved, range[0], range[1], totalRetries);
                        } finally {
                            batchSem.release();
                        }
                    }, BATCH_EXECUTOR));
                }
                for (CompletableFuture<Void> f : futures) {
                    f.join();
                }
            }
        }

        List<Embedding> embeddings = new ArrayList<>(texts.size());
        for (int i = 0; i < resolved.length; i++) {
            embeddings.add(new Embedding(resolved[i], i));
        }

        long totalTime = System.currentTimeMillis() - startTime;
        log.info("[EMBED-TIMING] model={} texts={} batchSize={} cfCalls={} totalCfCalls={} cacheHits={} cacheMisses={} cacheHitRate={}% timeMs={} retries={}",
                MODEL_NAME, texts.size(), EMBEDDING_BATCH_SIZE, batchesSent, apiCallCount.get(),
                localHits, missTexts.size(), String.format(Locale.ROOT, "%.1f", getCacheHitRate()),
                totalTime, totalRetries.get());

        EmbeddingResponseMetadata metadata = new EmbeddingResponseMetadata();
        metadata.setModel(MODEL_NAME);
        return new EmbeddingResponse(embeddings, metadata);
    }

    private void processBatchRange(
            List<String> missTexts,
            List<Integer> missIndices,
            float[][] resolved,
            int start,
            int end,
            AtomicInteger totalRetries) {
        List<String> batch = missTexts.subList(start, end);
        retryCount.get().set(0);
        List<float[]> batchEmbeddings = embedBatchWithRetry(batch, INDEX_HTTP_TIMEOUT, INDEX_RETRY_BACKOFF_MS);
        totalRetries.addAndGet(retryCount.get().get());

        if (batchEmbeddings.size() != batch.size()) {
            throw new RuntimeException("Cloudflare embedding count mismatch: expected "
                    + batch.size() + " got " + batchEmbeddings.size());
        }

        for (int j = 0; j < batchEmbeddings.size(); j++) {
            float[] vector = batchEmbeddings.get(j);
            if (vector == null || vector.length != MODEL_DIMENSIONS || isAllZero(vector)) {
                throw new RuntimeException("Invalid or zero embedding vector returned at index " + (start + j));
            }
            int origIndex = missIndices.get(start + j);
            resolved[origIndex] = vector;
            putInCache(chunkEmbeddingCache, batch.get(j), vector);
        }
    }

    /**
     * Embed a batch with retry logic for HTTP 429, 5xx, and transient network errors.
     * Non-retryable 4xx (e.g. 400, 401, 403, 422) fail immediately.
     * NEVER returns null or zero vectors; always throws on failure.
     */
    private List<float[]> embedBatchWithRetry(List<String> batch, Duration timeout, long[] backoffMs) {
        RuntimeException lastError = null;
        int maxRetries = backoffMs.length;
        for (int attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                return callCloudflareAPI(batch, timeout);
            } catch (RuntimeException e) {
                lastError = e;
                int status = extractHttpStatus(e);

                // 4xx other than 429 (e.g., 400, 401, 403, 404, 422) are non-retryable -> fail immediately
                if (status >= 400 && status < 500 && status != 429) {
                    log.error("[EMBED] non-retryable HTTP {} error, failing batch of {}: {}",
                            status, batch.size(), e.getMessage());
                    throw e;
                }

                // 429, 5xx, or transient network error (status == 0) -> retry with backoff
                if (attempt < maxRetries) {
                    long delay = backoffMs[attempt];
                    retryCount.get().incrementAndGet();
                    log.warn("[EMBED] HTTP {} error (attempt {}/{}), retrying batch of {} in {}ms: {}",
                            status, attempt + 1, maxRetries + 1, batch.size(), delay, e.getMessage());
                    try {
                        Thread.sleep(delay);
                    } catch (InterruptedException ie) {
                        Thread.currentThread().interrupt();
                        throw new RuntimeException("Interrupted during embedding retry", ie);
                    }
                } else {
                    log.error("[EMBED] batch of {} failed after {} retries (HTTP {}): {}",
                            batch.size(), attempt, status, e.getMessage());
                    throw e;
                }
            }
        }
        throw lastError != null ? lastError : new RuntimeException("Cloudflare embedding failed after retries");
    }

    private List<float[]> callCloudflareAPI(List<String> texts, Duration timeout) {
        try {
            apiCallCount.incrementAndGet();

            ObjectNode requestBody = OBJECT_MAPPER.createObjectNode();
            ArrayNode textArray = requestBody.putArray("text");
            for (String text : texts) {
                textArray.add(text);
            }

            HttpRequest request = HttpRequest.newBuilder()
                    .uri(EMBEDDING_URI)
                    .header("Authorization", authHeader)
                    .header("Content-Type", "application/json")
                    .header("Accept-Encoding", "gzip")
                    .POST(HttpRequest.BodyPublishers.ofString(requestBody.toString()))
                    .timeout(timeout)
                    .build();

            HttpResponse<InputStream> response = HTTP_CLIENT.send(request, HttpResponse.BodyHandlers.ofInputStream());
            boolean isGzip = "gzip".equalsIgnoreCase(response.headers().firstValue("Content-Encoding").orElse(""));

            try (InputStream rawStream = response.body();
                 InputStream bodyStream = isGzip ? new GZIPInputStream(rawStream) : rawStream) {
                if (response.statusCode() != 200) {
                    byte[] errBytes = bodyStream.readNBytes(2048);
                    throw new CloudflareApiException(response.statusCode(),
                            "HTTP " + response.statusCode() + ": " + new String(errBytes, StandardCharsets.UTF_8));
                }

                // Stream-parse JSON directly into float[384] arrays (zero DOM DoubleNode/ArrayNode heap churn)
                return parseEmbeddingsStreaming(bodyStream, texts.size());
            }
        } catch (CloudflareApiException e) {
            throw e;
        } catch (Exception e) {
            throw new RuntimeException("Cloudflare embedding API call failed: " + e.getMessage(), e);
        }
    }

    private static List<float[]> parseEmbeddingsStreaming(InputStream bodyStream, int expectedCount) throws Exception {
        try (JsonParser parser = OBJECT_MAPPER.getFactory().createParser(bodyStream)) {
            if (parser.nextToken() != JsonToken.START_OBJECT) {
                throw new RuntimeException("Cloudflare embedding API error - invalid JSON root");
            }
            List<float[]> embeddings = null;
            boolean sawResult = false;
            while (parser.nextToken() != JsonToken.END_OBJECT) {
                String fieldName = parser.currentName();
                JsonToken valueToken = parser.nextToken();
                if ("result".equals(fieldName) && valueToken == JsonToken.START_OBJECT) {
                    sawResult = true;
                    while (parser.nextToken() != JsonToken.END_OBJECT) {
                        String resultField = parser.currentName();
                        JsonToken resultVal = parser.nextToken();
                        if ("data".equals(resultField) && resultVal == JsonToken.START_ARRAY) {
                            embeddings = new ArrayList<>(expectedCount);
                            int vecIdx = 0;
                            while (parser.nextToken() != JsonToken.END_ARRAY) {
                                if (parser.currentToken() != JsonToken.START_ARRAY) {
                                    throw new RuntimeException("Unexpected embedding vector token at index " + vecIdx);
                                }
                                float[] vector = new float[MODEL_DIMENSIONS];
                                int dim = 0;
                                while (parser.nextToken() != JsonToken.END_ARRAY) {
                                    if (dim < MODEL_DIMENSIONS) {
                                        vector[dim] = parser.getFloatValue();
                                    }
                                    dim++;
                                }
                                if (dim != MODEL_DIMENSIONS) {
                                    throw new RuntimeException("Unexpected embedding vector dimension at index "
                                            + vecIdx + ": " + dim);
                                }
                                embeddings.add(vector);
                                vecIdx++;
                            }
                        } else {
                            parser.skipChildren();
                        }
                    }
                } else {
                    parser.skipChildren();
                }
            }
            if (!sawResult) {
                throw new RuntimeException("Cloudflare embedding API error - no result");
            }
            if (embeddings == null) {
                throw new RuntimeException("Cloudflare embedding API error - no data");
            }
            return embeddings;
        }
    }

    int extractHttpStatus(Throwable e) {
        for (Throwable current = e; current != null; current = current.getCause()) {
            if (current instanceof CloudflareApiException apiEx) {
                return apiEx.statusCode;
            }
            String msg = current.getMessage();
            if (msg != null) {
                Matcher matcher = HTTP_STATUS_PATTERN.matcher(msg);
                if (matcher.find()) {
                    try {
                        return Integer.parseInt(matcher.group(1));
                    } catch (NumberFormatException ignored) {
                    }
                }
            }
        }
        return 0; // Network/timeout error (retryable)
    }

    @Override
    public float[] embed(String text) {
        long startTime = System.currentTimeMillis();
        String normalized = normalizeQuery(text);
        float[] cached = getFromCache(queryEmbeddingCache, normalized);
        if (cached == null) {
            cached = getFromCache(chunkEmbeddingCache, text);
        }
        if (cached != null) {
            cacheHitCount.incrementAndGet();
            long timeMs = System.currentTimeMillis() - startTime;
            log.info("[QUERY-TIMING] queryTimeMs={} topK=5 cacheHit=true cacheHitRate={}%",
                    timeMs, String.format(Locale.ROOT, "%.1f", getCacheHitRate()));
            return cached;
        }

        cacheMissCount.incrementAndGet();
        retryCount.get().set(0);
        List<float[]> vectors = embedBatchWithRetry(List.of(text), QUERY_HTTP_TIMEOUT, QUERY_RETRY_BACKOFF_MS);
        if (vectors.isEmpty()) {
            throw new RuntimeException("Cloudflare embedding returned empty result for query");
        }
        float[] vector = vectors.get(0);
        if (vector == null || vector.length != MODEL_DIMENSIONS || isAllZero(vector)) {
            throw new RuntimeException("Invalid or zero embedding vector returned for query");
        }
        putInCache(queryEmbeddingCache, normalized, vector);
        long timeMs = System.currentTimeMillis() - startTime;
        log.info("[QUERY-TIMING] queryTimeMs={} topK=5 cacheHit=false cacheHitRate={}% retries={}",
                timeMs, String.format(Locale.ROOT, "%.1f", getCacheHitRate()), retryCount.get().get());
        return vector;
    }

    @Override
    public float[] embed(Document document) {
        return embed(document.getFormattedContent());
    }

    @Override
    public int dimensions() {
        return MODEL_DIMENSIONS;
    }

    /**
     * Content-hash LRU cache lookup for repeated queries and chunks (30-minute TTL, shared across workspaces).
     */
    public float[] getCachedEmbedding(String cacheKey) {
        if (cacheKey == null) {
            return null;
        }
        float[] hit = getFromCache(queryEmbeddingCache, normalizeQuery(cacheKey));
        if (hit != null) {
            return hit;
        }
        return getFromCache(chunkEmbeddingCache, cacheKey);
    }

    public void putCachedEmbedding(String cacheKey, float[] embedding) {
        if (cacheKey == null || embedding == null || embedding.length != MODEL_DIMENSIONS || isAllZero(embedding)) {
            return;
        }
        putInCache(queryEmbeddingCache, normalizeQuery(cacheKey), embedding);
    }

    private static float[] getFromCache(Map<String, CachedEmbedding> cache, String key) {
        if (key == null) {
            return null;
        }
        String hashedKey = sha256(key);
        CachedEmbedding cached = cache.get(hashedKey);
        if (cached != null) {
            if (System.currentTimeMillis() - cached.timestamp < CACHE_TTL_MS) {
                return cached.embedding;
            }
            cache.remove(hashedKey);
        }
        return null;
    }

    private static void putInCache(Map<String, CachedEmbedding> cache, String key, float[] embedding) {
        if (key == null || embedding == null || embedding.length != MODEL_DIMENSIONS || isAllZero(embedding)) {
            return;
        }
        cache.put(sha256(key), new CachedEmbedding(embedding, System.currentTimeMillis()));
    }

    private static String normalizeQuery(String text) {
        if (text == null) {
            return null;
        }
        return text.trim().replaceAll("\\s+", " ").toLowerCase(Locale.ROOT);
    }

    private static String sha256(String text) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            return HexFormat.of().formatHex(md.digest(text.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception e) {
            return text;
        }
    }

    private static boolean isAllZero(float[] vector) {
        for (float v : vector) {
            if (v != 0.0f) {
                return false;
            }
        }
        return true;
    }

    private static final class CloudflareApiException extends RuntimeException {
        final int statusCode;

        CloudflareApiException(int statusCode, String message) {
            super(message);
            this.statusCode = statusCode;
        }
    }

    private static class CachedEmbedding {
        final float[] embedding;
        final long timestamp;

        CachedEmbedding(float[] embedding, long timestamp) {
            this.embedding = embedding;
            this.timestamp = timestamp;
        }
    }
}
