package trace.backend.services.indexing;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executor;
import java.util.concurrent.Executors;
import java.util.concurrent.Semaphore;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

import org.springframework.ai.document.Document;
import org.springframework.ai.vectorstore.VectorStore;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.stereotype.Service;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;

/**
 * Shared, source-agnostic vector persistence stage.
 * Consumes chunked {@link Document}s from any ingestion adapter (GitHub repos, PDFs, etc.)
 * and flushes 64-chunk batches concurrently through the configured EmbeddingModel + PgVector store
 * with bounded concurrency and memory backpressure safe for -Xmx160m containers.
 */
@Service
@RequiredArgsConstructor
@Slf4j
public class VectorBatchPersister {

    public static final int VECTOR_BATCH_SIZE = 64;
    private static final int PARALLEL_EMBED_BATCHES = 3;
    private static final int MAX_DB_RETRIES = 1;
    private static final long BASE_RETRY_DELAY_MS = 1000L;
    private static final Executor FALLBACK_IO_EXECUTOR = Executors.newVirtualThreadPerTaskExecutor();

    private final VectorStore vectorStore;

    @Autowired(required = false)
    @Qualifier("ioExecutor")
    private Executor ioExecutor;

    @FunctionalInterface
    public interface ProgressListener {
        void onChunksEmbedded(int embeddedSoFar, int totalChunks);
    }

    public record PersistResult(int totalChunks, int embeddedChunks, boolean failed) {}

    /**
     * Splits {@code documents} into 64-chunk batches and embeds/writes them into PgVector
     * with bounded concurrency and transient DB retry + content-safety single-doc fallback.
     */
    public PersistResult persistAll(UUID sourceId, List<Document> documents, ProgressListener listener) {
        if (documents == null || documents.isEmpty()) {
            return new PersistResult(0, 0, false);
        }

        int total = documents.size();
        Semaphore embedSemaphore = new Semaphore(PARALLEL_EMBED_BATCHES);
        AtomicInteger embeddedCount = new AtomicInteger(0);
        AtomicBoolean anyFailed = new AtomicBoolean(false);
        Executor executor = ioExecutor != null ? ioExecutor : FALLBACK_IO_EXECUTOR;

        List<CompletableFuture<Void>> futures = new ArrayList<>((total + VECTOR_BATCH_SIZE - 1) / VECTOR_BATCH_SIZE);
        for (int start = 0; start < total; start += VECTOR_BATCH_SIZE) {
            int end = Math.min(start + VECTOR_BATCH_SIZE, total);
            List<Document> batch = new ArrayList<>(documents.subList(start, end));
            final int batchStart = start;
            final int batchEnd = end;

            futures.add(CompletableFuture.runAsync(() -> {
                boolean acquired = false;
                try {
                    embedSemaphore.acquire();
                    acquired = true;
                    boolean ok = addBatchWithRetry(batch, sourceId, batchStart, batchEnd);
                    if (!ok) {
                        anyFailed.set(true);
                    } else {
                        int done = embeddedCount.addAndGet(batch.size());
                        if (listener != null) {
                            listener.onChunksEmbedded(done, total);
                        }
                    }
                } catch (InterruptedException ie) {
                    Thread.currentThread().interrupt();
                    anyFailed.set(true);
                } finally {
                    if (acquired) {
                        embedSemaphore.release();
                    }
                }
            }, executor));
        }

        for (CompletableFuture<Void> future : futures) {
            try {
                future.join();
            } catch (Exception e) {
                log.error("{} [VECTOR_PERSIST] batch future failed sourceId={}: {}",
                        Instant.now(), sourceId, e.getMessage(), e);
                anyFailed.set(true);
            }
        }

        return new PersistResult(total, embeddedCount.get(), anyFailed.get());
    }

    public boolean addBatchWithRetry(List<Document> batch, UUID sourceId, int start, int end) {
        log.info("{} [INDEX] vector batch start sourceId={} chunks={}-{} batchSize={}",
                Instant.now(), sourceId, start, end, batch.size());

        for (int attempt = 0; attempt <= MAX_DB_RETRIES; attempt++) {
            try {
                vectorStore.add(batch);
                log.info("{} [INDEX] vector batch done sourceId={} chunks={}-{}", Instant.now(), sourceId, start, end);
                return true;
            } catch (RuntimeException e) {
                if (isUtf8NullByteError(e)) {
                    log.error("{} [EMBED] batch contains null bytes, skipping sourceId={}-{}: {}",
                            Instant.now(), sourceId, start, end, e.getMessage());
                    return false;
                }
                if (isContentSafetyError(e)) {
                    log.warn("{} [EMBED] content safety error detected, splitting batch sourceId={}-{}",
                            Instant.now(), sourceId, start, end);
                    return embedIndividually(batch, sourceId, start, end);
                }
                if (!isTransientDbError(e) || attempt >= MAX_DB_RETRIES) {
                    log.error("{} [EMBED] batch failed after {} retries sourceId={}-{}: {}",
                            Instant.now(), attempt, sourceId, start, end, e.getMessage());
                    return false;
                }
                log.warn("{} [INDEX] transient DB batch failure, retrying sourceId={}-{} in {}ms: {}",
                        Instant.now(), sourceId, start, end, BASE_RETRY_DELAY_MS, e.getMessage());
                try {
                    Thread.sleep(BASE_RETRY_DELAY_MS);
                } catch (InterruptedException ie) {
                    Thread.currentThread().interrupt();
                    return false;
                }
            }
        }
        return false;
    }

    private boolean embedIndividually(List<Document> batch, UUID sourceId, int start, int end) {
        int embedded = 0;
        for (int i = 0; i < batch.size(); i++) {
            try {
                vectorStore.add(List.of(batch.get(i)));
                embedded++;
            } catch (RuntimeException e) {
                log.warn("{} [EMBED] skipping problematic chunk {} in batch {}-{} sourceId={}: {}",
                        Instant.now(), start + i, start, end, sourceId, e.getMessage());
            }
        }
        return embedded > 0;
    }

    private static boolean isUtf8NullByteError(Throwable e) {
        for (Throwable cur = e; cur != null; cur = cur.getCause()) {
            String msg = cur.getMessage();
            if (msg != null && (msg.contains("0x00") || msg.toLowerCase(Locale.ROOT).contains("invalid byte sequence for encoding"))) {
                return true;
            }
        }
        return false;
    }

    private static boolean isContentSafetyError(Throwable e) {
        for (Throwable cur = e; cur != null; cur = cur.getCause()) {
            String msg = cur.getMessage();
            if (msg != null) {
                String lower = msg.toLowerCase(Locale.ROOT);
                if (lower.contains("content_filter") || lower.contains("safety") || lower.contains("moderation")) {
                    return true;
                }
            }
        }
        return false;
    }

    private static boolean isTransientDbError(Throwable e) {
        for (Throwable cur = e; cur != null; cur = cur.getCause()) {
            String msg = cur.getMessage();
            if (msg != null) {
                String lower = msg.toLowerCase(Locale.ROOT);
                if (lower.contains("connection")
                        && (lower.contains("closed") || lower.contains("reset") || lower.contains("timeout"))) {
                    return true;
                }
            }
        }
        return false;
    }
}
