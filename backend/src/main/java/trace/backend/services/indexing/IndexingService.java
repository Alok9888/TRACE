package trace.backend.services.indexing;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executor;
import java.util.concurrent.Executors;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import java.util.stream.Collectors;

import org.springframework.ai.document.Document;
import org.springframework.ai.embedding.EmbeddingModel;
import org.springframework.ai.vectorstore.VectorStore;
import org.springframework.ai.vectorstore.filter.Filter;
import org.springframework.ai.vectorstore.filter.FilterExpressionBuilder;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Service;

import trace.backend.entity.IndexStatus;
import trace.backend.entity.Repository;
import trace.backend.exceptions.NotFoundException;
import trace.backend.repository.RepositoryRepository;
import trace.backend.services.ai.ChatContextCache;
import trace.backend.services.ai.RagSettings;
import trace.backend.services.embedding.CloudflareEmbeddingService;
import trace.backend.services.github.GitHubRateLimiter;
import trace.backend.services.github.GithubApiClient;
import jakarta.transaction.Transactional;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;

@Service
@RequiredArgsConstructor
@Slf4j
public class IndexingService {
    private static final int VECTOR_BATCH_SIZE = 64;
    private static final int PARALLEL_EMBED_BATCHES = 3; // Bounded concurrency over virtual threads: protects Hikari (max=8) & 160MB heap
    private static final int ZIPBALL_FILE_THRESHOLD = 5; // Use 1-request zipball when fetching >= 5 files
    private static final int DELETE_PATH_BATCH_SIZE = 50;
    private static final int PARALLEL_FETCH_WORKERS = 8;
    private static final long RETRIEVAL_TIMEOUT_MS = 120000;
    private static final long STATUS_UPDATE_THROTTLE_MS = 1500;

    private static final int MAX_DB_RETRIES = 1;
    private static final long BASE_RETRY_DELAY_MS = 1000;
    private static final long INDEX_LOCK_TIMEOUT_MS = TimeUnit.MINUTES.toMillis(15);

    private static final Executor FALLBACK_IO_EXECUTOR = Executors.newVirtualThreadPerTaskExecutor();
    private static final ObjectMapper OBJECT_MAPPER = new ObjectMapper();

    private final ConcurrentHashMap<UUID, IndexingLock> indexingSet = new ConcurrentHashMap<>();

    private final RepositoryRepository repositoryRepository;
    private final GithubApiClient gitHubApiClient;
    private final CodeFileFilter fileFilter;
    private final CodeChunker codeChunker;
    private final GitHubRateLimiter rateLimiter;
    private final VectorStore vectorStore;
    private final EmbeddingModel embeddingModel;

    @Autowired(required = false)
    @Qualifier("ioExecutor")
    private Executor ioExecutor;

    @Autowired(required = false)
    private ChatContextCache chatContextCache;

    @Value("${app.indexing.max-file-bytes:102400}")
    private long maxFileBytes;

    private Executor effectiveIoExecutor() {
        return ioExecutor != null ? ioExecutor : FALLBACK_IO_EXECUTOR;
    }

    private static final class IndexingLock {
        private volatile long lastProgressAt = System.currentTimeMillis();
        private final AtomicLong lastDbStatusWriteAt = new AtomicLong(0L);
        private final AtomicReference<String> lastStage = new AtomicReference<>("");
    }

    private IndexingLock activeLock(UUID repoId) {
        IndexingLock lock = indexingSet.get(repoId);
        if (lock != null && System.currentTimeMillis() - lock.lastProgressAt > INDEX_LOCK_TIMEOUT_MS) {
            if (indexingSet.remove(repoId, lock)) {
                log.warn("Indexing lock expired after 15 minutes without progress repoId={}", repoId);
            }
            return null;
        }
        return lock;
    }

    private void scheduleStaleLockCheck(UUID repoId, IndexingLock lock) {
        CompletableFuture.delayedExecutor(1, TimeUnit.MINUTES).execute(() -> {
            if (indexingSet.get(repoId) != lock) return;
            if (System.currentTimeMillis() - lock.lastProgressAt > INDEX_LOCK_TIMEOUT_MS) {
                if (indexingSet.remove(repoId, lock)) {
                    log.warn("Indexing lock expired after 15 minutes without progress repoId={}", repoId);
                }
                return;
            }
            scheduleStaleLockCheck(repoId, lock);
        });
    }

    public boolean isIndexingActive(UUID repoId) {
        return activeLock(repoId) != null;
    }

    /**
     * Throttled DB progress updater: always updates in-memory lock timestamp,
     * writes to Postgres only on stage transitions or at most once every 1.5s.
     */
    private void updateIndexingStatus(UUID repoId, String stage, String detail, int filesDone, int filesTotal, int chunksDone, int chunksTotal, boolean forceWrite) {
        long now = System.currentTimeMillis();
        IndexingLock lock = indexingSet.get(repoId);
        if (lock != null) {
            lock.lastProgressAt = now;
            boolean stageChanged = stage != null && !stage.equals(lock.lastStage.get());
            long lastWrite = lock.lastDbStatusWriteAt.get();
            if (!forceWrite && !stageChanged && (now - lastWrite) < STATUS_UPDATE_THROTTLE_MS) {
                return;
            }
            if (!forceWrite && !stageChanged && !lock.lastDbStatusWriteAt.compareAndSet(lastWrite, now)) {
                return;
            }
            lock.lastDbStatusWriteAt.set(now);
            if (stage != null) {
                lock.lastStage.set(stage);
            }
        }
        try {
            repositoryRepository.updateIndexingProgress(
                    repoId, stage, detail, filesDone, filesTotal, chunksDone, chunksTotal, Instant.now());
        } catch (Exception e) {
            log.warn("Failed to update indexing status: {}", e.getMessage());
        }
    }

    public Repository startIndexing(UUID repoId, UUID userId) {
        Repository repo = repositoryRepository.findByIdAndUserId(repoId, userId)
                .orElseThrow(() -> new NotFoundException("Repository not found"));

        if (activeLock(repoId) != null) {
            log.info("Repository is already indexing, skipping duplicate repoId={}", repoId);
            return repo;
        }
        if (repo.getIndexStatus() == IndexStatus.INDEXING) {
            log.info("Repository is already indexing, skipping duplicate start repoId={}", repoId);
            return repo;
        }

        repo.setIndexStatus(IndexStatus.INDEXING);
        repo.setFilesProcessed(0);
        repo.setFilesTotal(0);
        repo.setChunkCount(0);
        repo.setChunksTotal(0);
        repo.setChunksProcessed(0);
        repo.setIndexingStage("fetching");
        repo.setIndexingDetail("Starting...");
        repo.setErrorMessage(null);
        repo.setUpdatedAt(Instant.now());
        return repositoryRepository.save(repo);
    }

    @Async("indexingExecutor")
    public void indexAsync(UUID repoId, UUID userId) {
        indexAsync(repoId, userId, false);
    }

    @Async("indexingExecutor")
    public void indexAsync(UUID repoId, UUID userId, boolean force) {
        IndexingLock newLock = new IndexingLock();
        IndexingLock existingLock = activeLock(repoId);
        if (existingLock != null) {
            log.info("Repository is already indexing, skipping duplicate repoId={}", repoId);
            return;
        }
        existingLock = indexingSet.putIfAbsent(repoId, newLock);
        if (existingLock != null) {
            existingLock = activeLock(repoId);
            if (existingLock != null) {
                log.info("Repository is already indexing, skipping duplicate repoId={}", repoId);
                return;
            }
            existingLock = indexingSet.putIfAbsent(repoId, newLock);
            if (existingLock != null) {
                log.info("Repository is already indexing, skipping duplicate repoId={}", repoId);
                return;
            }
        }

        scheduleStaleLockCheck(repoId, newLock);
        long startTime = System.currentTimeMillis();
        try {
            doIndex(repoId, userId, startTime, force);
        } catch (Exception ex) {
            log.error("Indexing failed for repo {}", repoId, ex);
            markFailed(repoId, ex.getMessage());
        } finally {
            indexingSet.remove(repoId, newLock);
        }
    }

    private void doIndex(UUID repoId, UUID userId, long startTime, boolean force) {
        AtomicBoolean embeddingFailed = new AtomicBoolean(false);
        long cfCallsBefore = embeddingModel instanceof CloudflareEmbeddingService cf ? cf.getApiCallCount() : 0L;

        log.info("{} [INDEX] start repoId={} force={}", Instant.now(), repoId, force);
        Repository repo = repositoryRepository.findById(repoId)
                .orElseThrow(() -> new NotFoundException("Repository not found"));

        Map<String, String> previousFiles = force ? new HashMap<>() : loadIndexedFiles(repo);
        String previousTreeSha = (!force && repo.getTreeSha() != null) ? repo.getTreeSha() : "";

        // Fetch tree and filter eligible files BEFORE downloading any file content
        Map<String, Object> tree = gitHubApiClient.getRepoTree(
            repo.getOwner(), repo.getName(), repo.getDefaultBranch());

        FilteredTree filteredTree = extractFileShasWithStats(tree);
        Map<String, String> currentFiles = filteredTree.eligibleFiles;
        String currentTreeSha = computeTreeSha(currentFiles);

        log.info("{} [INDEX] filter repoId={} totalBlobs={} eligible={} skippedByFilter={} maxFileBytes={}",
                Instant.now(), repoId, filteredTree.totalBlobs, currentFiles.size(),
                filteredTree.skippedCount, maxFileBytes);

        if (!force && !previousTreeSha.isEmpty() && previousTreeSha.equals(currentTreeSha)) {
            int skippedCount = previousFiles.size();
            long duration = System.currentTimeMillis() - startTime;
            log.info("{} [INDEX] skipped repoId={} files={} time={}ms - tree unchanged",
                     Instant.now(), repoId, skippedCount, duration);
            repo.setFilesProcessed(skippedCount);
            repo.setFilesTotal(skippedCount);
            repo.setIndexStatus(IndexStatus.READY);
            repo.setIndexingStage("done");
            repo.setIndexingDetail("Indexing complete");
            repo.setUpdatedAt(Instant.now());
            repositoryRepository.save(repo);
            return;
        }

        if (force) {
            deleteAllVectorsForRepo(userId, repoId.toString());
        }

        IndexingResult result = computeIndexingChanges(previousFiles, currentFiles);

        log.info("{} [INDEX] changes repoId={} total={} new={} changed={} removed={} unchanged={} filteredOut={}",
            Instant.now(), repoId,
            result.allFiles.size(),
            result.newFiles.size(),
            result.changedFiles.size(),
            result.removedFiles.size(),
            result.unchangedFiles.size(),
            filteredTree.skippedCount);

        updateIndexingStatus(repoId, "fetching", "Fetching repository files...", 0, result.allFiles.size(), 0, 0, true);

        // Delete vectors ONLY for removed and changed files (filtered by repoId + userId + filePath)
        List<String> pathsToDelete = new ArrayList<>(result.removedFiles);
        pathsToDelete.addAll(result.changedFiles);
        deleteVectorsForRemovedFiles(userId, repoId.toString(), pathsToDelete);

        // Stream-fetch, chunk, and flush 64-chunk batches with bounded parallelism
        // Never holds whole-repo chunks in heap (safe for -Xmx160m)
        long pipelineStart = System.currentTimeMillis();
        StreamingStats stats = streamIndexFiles(
                repo, userId, repoId, result.newFiles, result.changedFiles, result.allFiles.size(),
                filteredTree.eligibleBytes, filteredTree.skippedBytes, embeddingFailed);
        long pipelineDuration = System.currentTimeMillis() - pipelineStart;

        if (embeddingFailed.get()) {
            markFailed(repoId, "Embedding batch failed - check logs for details");
            log.warn("{} [INDEX] aborted due to embedding failure repoId={}", Instant.now(), repoId);
            return;
        }

        updateIndexingStatus(repoId, "saving", "Finalizing repository index...",
                result.allFiles.size(), result.allFiles.size(), stats.totalChunks, stats.totalChunks, true);

        repo.setTreeSha(currentTreeSha);
        try {
            repo.setIndexedFilesJson(OBJECT_MAPPER.writeValueAsString(currentFiles));
        } catch (com.fasterxml.jackson.core.JsonProcessingException e) {
            log.error("Failed to serialize indexed files JSON: {}", e.getMessage());
        }
        repo.setFilesTotal(result.allFiles.size());
        repo.setFilesProcessed(result.allFiles.size());
        repo.setChunkCount(stats.totalChunks);
        repo.setChunksTotal(stats.totalChunks);
        repo.setChunksProcessed(stats.totalChunks);
        repo.setIndexedAt(Instant.now());
        repo.setIndexStatus(IndexStatus.READY);
        repo.setIndexingStage("done");
        repo.setIndexingDetail("Indexing complete");
        repo.setUpdatedAt(Instant.now());

        try {
            repositoryRepository.save(repo);
            if (chatContextCache != null) {
                chatContextCache.invalidateRepository(repoId);
            }
            log.info("{} [INDEX] marked READY repoId={}", Instant.now(), repoId);
        } catch (Exception e) {
            log.error("{} [INDEX] FAILED to persist READY status repoId={}: {}", Instant.now(), repoId, e.getMessage(), e);
            repo.setIndexStatus(IndexStatus.FAILED);
            repo.setErrorMessage("Failed to persist indexing completion: " + e.getMessage());
            repo.setIndexingStage("failed");
            repo.setIndexingDetail("Database error: " + e.getMessage());
            repositoryRepository.save(repo);
            throw e;
        }

        long duration = System.currentTimeMillis() - startTime;
        long cfCallsUsed = embeddingModel instanceof CloudflareEmbeddingService cf
                ? cf.getApiCallCount() - cfCallsBefore : 0L;
        double cacheHitRate = embeddingModel instanceof CloudflareEmbeddingService cf
                ? cf.getCacheHitRate() : 0.0;
        log.info("{} [INDEX] complete repoId={} mode={} totalBlobs={} eligible={} filteredOut={} fetched={} unchanged={} chunks={} cfCalls={} cacheHitRate={}% pipelineMs={} time={}ms",
                 Instant.now(), repoId, stats.mode, filteredTree.totalBlobs, result.allFiles.size(),
                 filteredTree.skippedCount, stats.filesProcessed, result.unchangedFiles.size(),
                 stats.totalChunks, cfCallsUsed, String.format(Locale.ROOT, "%.1f", cacheHitRate),
                 pipelineDuration, duration);
    }

    /**
     * Streams files (via single-request zipball for bulk indexing or parallel HTTP/2 raw CDN for small/asset-heavy repos),
     * chunks each file, and flushes 64-chunk batches concurrently with decoupled backpressure so peak heap stays tiny.
     */
    private StreamingStats streamIndexFiles(
            Repository repo,
            UUID userId,
            UUID repoId,
            List<String> newFiles,
            List<String> changedFiles,
            int totalFiles,
            long eligibleBytes,
            long skippedBytes,
            AtomicBoolean embeddingFailed) {

        List<String> filesToFetch = new ArrayList<>(newFiles);
        filesToFetch.addAll(changedFiles);
        if (filesToFetch.isEmpty()) {
            return new StreamingStats("noop", 0, 0);
        }

        StreamingBatchFlusher flusher = new StreamingBatchFlusher(repoId, totalFiles, embeddingFailed);
        Set<String> targetPaths = new HashSet<>(filesToFetch);
        AtomicInteger filesDone = new AtomicInteger(0);
        String mode = "zipball";

        // Skip downloading a multi-MB asset-heavy zipball when only a small set of public code files is needed
        boolean preferRawCdn = !repo.isPrivate()
                && filesToFetch.size() <= 20
                && skippedBytes > 2_000_000L
                && skippedBytes > eligibleBytes * 4;

        boolean zipballSucceeded = false;
        if (filesToFetch.size() >= ZIPBALL_FILE_THRESHOLD && !preferRawCdn) {
            try {
                log.info("{} [INDEX] streaming zipball (1 GitHub call) repoId={} targetFiles={}",
                        Instant.now(), repoId, filesToFetch.size());
                gitHubApiClient.streamRepoZipball(
                        repo.getOwner(),
                        repo.getName(),
                        repo.getDefaultBranch(),
                        maxFileBytes,
                        (path, size) -> targetPaths.contains(path) && fileFilter.isEligible(path, size, maxFileBytes),
                        (path, content) -> {
                            List<Document> chunks = codeChunker.chunkFile(userId, repoId.toString(), path, content);
                            int done = filesDone.incrementAndGet();
                            flusher.addChunks(chunks, done);
                        });
                zipballSucceeded = true;
            } catch (Exception e) {
                log.warn("{} [INDEX] zipball stream failed for repoId={}, falling back to per-file fetch: {}",
                        Instant.now(), repoId, e.getMessage());
            }
        }

        if (!zipballSucceeded) {
            boolean useRawCdn = !repo.isPrivate();
            mode = useRawCdn ? "raw-cdn" : "contents-api";
            List<CompletableFuture<Void>> fetchFutures = new ArrayList<>(filesToFetch.size());
            Semaphore fetchSemaphore = new Semaphore(PARALLEL_FETCH_WORKERS);

            Executor executor = effectiveIoExecutor();
            for (String path : filesToFetch) {
                fetchFutures.add(CompletableFuture.runAsync(() -> {
                    try {
                        fetchSemaphore.acquire();
                        String content;
                        if (useRawCdn) {
                            content = gitHubApiClient.getRawFileContent(
                                    repo.getOwner(), repo.getName(), repo.getDefaultBranch(), path);
                        } else {
                            rateLimiter.pause();
                            content = gitHubApiClient.getFileContent(repo.getOwner(), repo.getName(), path);
                        }
                        int done = filesDone.incrementAndGet();
                        if (content != null) {
                            List<Document> chunks = codeChunker.chunkFile(userId, repoId.toString(), path, content);
                            flusher.addChunks(chunks, done);
                        } else {
                            updateIndexingStatus(repoId, "fetching", "Fetching files...",
                                    done, totalFiles, flusher.getChunksEmbedded(), flusher.getTotalChunks(), false);
                        }
                    } catch (Exception e) {
                        log.warn("Failed to process file {}: {}", path, e.getMessage());
                    } finally {
                        fetchSemaphore.release();
                    }
                }, executor));
            }

            for (CompletableFuture<Void> future : fetchFutures) {
                try {
                    future.get(RETRIEVAL_TIMEOUT_MS, TimeUnit.MILLISECONDS);
                } catch (TimeoutException e) {
                    log.warn("Timeout processing file batch, continuing with remaining results");
                } catch (Exception e) {
                    log.warn("Error processing file: {}", e.getMessage());
                }
            }
        }

        flusher.flushRemainingAndAwait();
        return new StreamingStats(mode, filesDone.get(), flusher.getTotalChunks());
    }

    /**
     * Thread-safe streaming accumulator that flushes 64-chunk batches to Cloudflare + PgVector
     * with bounded concurrency (PARALLEL_EMBED_BATCHES = 2), keeping memory bounded even on large repos.
     */
    private final class StreamingBatchFlusher {
        private static final int MAX_BUFFERED_BATCHES = 6; // Decouples zipball stream from Cloudflare/Neon while bounding RAM (<1.5MB)

        private final UUID repoId;
        private final int totalFiles;
        private final AtomicBoolean embeddingFailed;
        private final Semaphore queueSemaphore = new Semaphore(MAX_BUFFERED_BATCHES);
        private final Semaphore embedSemaphore = new Semaphore(PARALLEL_EMBED_BATCHES);
        private final List<Document> buffer = new ArrayList<>(VECTOR_BATCH_SIZE);
        private final List<CompletableFuture<Void>> inFlight = new ArrayList<>();
        private final AtomicInteger totalChunks = new AtomicInteger(0);
        private final AtomicInteger chunksEmbedded = new AtomicInteger(0);
        private final AtomicInteger lastFilesDone = new AtomicInteger(0);

        StreamingBatchFlusher(UUID repoId, int totalFiles, AtomicBoolean embeddingFailed) {
            this.repoId = repoId;
            this.totalFiles = totalFiles;
            this.embeddingFailed = embeddingFailed;
        }

        void addChunks(List<Document> chunks, int filesDone) {
            lastFilesDone.set(filesDone);
            if (chunks == null || chunks.isEmpty()) {
                return;
            }
            List<List<Document>> readyBatches = new ArrayList<>();
            int batchStartBase;
            synchronized (buffer) {
                batchStartBase = totalChunks.get();
                totalChunks.addAndGet(chunks.size());
                for (Document doc : chunks) {
                    buffer.add(doc);
                    if (buffer.size() >= VECTOR_BATCH_SIZE) {
                        readyBatches.add(new ArrayList<>(buffer));
                        buffer.clear();
                    }
                }
            }
            updateIndexingStatus(repoId, "embedding",
                    "Streaming & embedding (" + filesDone + "/" + totalFiles + " files)...",
                    filesDone, totalFiles, chunksEmbedded.get(), totalChunks.get(), false);

            int offset = batchStartBase;
            for (List<Document> batch : readyBatches) {
                submitBatch(batch, offset, offset + batch.size());
                offset += batch.size();
            }
        }

        void flushRemainingAndAwait() {
            List<Document> remainder = null;
            int endIdx;
            synchronized (buffer) {
                if (!buffer.isEmpty()) {
                    remainder = new ArrayList<>(buffer);
                    buffer.clear();
                }
                endIdx = totalChunks.get();
            }
            if (remainder != null) {
                submitBatch(remainder, Math.max(0, endIdx - remainder.size()), endIdx);
            }
            List<CompletableFuture<Void>> futuresCopy;
            synchronized (inFlight) {
                futuresCopy = new ArrayList<>(inFlight);
            }
            for (CompletableFuture<Void> f : futuresCopy) {
                try {
                    f.join();
                } catch (Exception e) {
                    log.error("Embedding batch future failed for repo {}: {}", repoId, e.getMessage(), e);
                    embeddingFailed.set(true);
                }
            }
        }

        private void submitBatch(List<Document> batch, int start, int end) {
            try {
                // Bounded queue backpressure (6 batches max) keeps zipball download flowing without stalling on Cloudflare/Neon
                queueSemaphore.acquire();
            } catch (InterruptedException ie) {
                Thread.currentThread().interrupt();
                embeddingFailed.set(true);
                return;
            }
            CompletableFuture<Void> future = CompletableFuture.runAsync(() -> {
                boolean acquiredEmbed = false;
                try {
                    embedSemaphore.acquire();
                    acquiredEmbed = true;
                    boolean success = addBatchWithRetry(batch, repoId, start, end);
                    if (!success) {
                        log.error("Failed to store batch {}-{} for repo {} - embeddingFailed flag set", start, end, repoId);
                        embeddingFailed.set(true);
                    } else {
                        int done = chunksEmbedded.addAndGet(batch.size());
                        updateIndexingStatus(repoId, "embedding",
                                "Embedded " + done + "/" + totalChunks.get() + " chunks...",
                                lastFilesDone.get(), totalFiles, done, totalChunks.get(), false);
                    }
                } catch (InterruptedException ie) {
                    Thread.currentThread().interrupt();
                    embeddingFailed.set(true);
                } finally {
                    if (acquiredEmbed) {
                        embedSemaphore.release();
                    }
                    queueSemaphore.release();
                }
            }, effectiveIoExecutor());
            synchronized (inFlight) {
                inFlight.add(future);
            }
        }

        int getTotalChunks() {
            return totalChunks.get();
        }

        int getChunksEmbedded() {
            return chunksEmbedded.get();
        }
    }

    @SuppressWarnings("unchecked")
    private Map<String, String> loadIndexedFiles(Repository repo) {
        if (repo.getIndexedFilesJson() == null || repo.getIndexedFilesJson().isBlank()) {
            return new HashMap<>();
        }
        try {
            return OBJECT_MAPPER.readValue(repo.getIndexedFilesJson(), new TypeReference<Map<String, String>>() {});
        } catch (Exception e) {
            log.warn("Could not parse indexed files JSON, starting fresh: {}", e.getMessage());
            return new HashMap<>();
        }
    }

    Map<String, String> extractFileShas(Map<String, Object> tree) {
        return extractFileShasWithStats(tree).eligibleFiles;
    }

    @SuppressWarnings("unchecked")
    private FilteredTree extractFileShasWithStats(Map<String, Object> tree) {
        Map<String, String> result = new HashMap<>();
        int totalBlobs = 0;
        int skippedCount = 0;
        long eligibleBytes = 0L;
        long skippedBytes = 0L;
        if (tree == null || tree.get("tree") == null) {
            return new FilteredTree(result, 0, 0, 0L, 0L);
        }

        List<Map<String, Object>> entries = (List<Map<String, Object>>) tree.get("tree");
        for (Map<String, Object> entry : entries) {
            if (!"blob".equals(entry.get("type"))) continue;
            totalBlobs++;
            String path = String.valueOf(entry.get("path"));
            long sizeBytes = parseBlobSize(entry.get("size"));
            if (!fileFilter.isEligible(path, sizeBytes, maxFileBytes)) {
                skippedCount++;
                skippedBytes += sizeBytes;
                continue;
            }
            eligibleBytes += sizeBytes;
            String sha = String.valueOf(entry.get("sha"));
            result.put(path, sha);
        }
        return new FilteredTree(result, totalBlobs, skippedCount, eligibleBytes, skippedBytes);
    }

    private static long parseBlobSize(Object sizeObj) {
        if (sizeObj instanceof Number number) {
            return number.longValue();
        }
        if (sizeObj == null) {
            return 0L;
        }
        try {
            return Long.parseLong(String.valueOf(sizeObj));
        } catch (NumberFormatException ignored) {
            return 0L;
        }
    }

    private String computeTreeSha(Map<String, String> files) {
        String filesHash = files.entrySet().stream()
            .map(e -> e.getKey() + ":" + e.getValue())
            .sorted()
            .collect(Collectors.joining("|"));

        if (filesHash.isEmpty()) return "";

        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] hash = md.digest(filesHash.getBytes(StandardCharsets.UTF_8));
            return Base64.getEncoder().encodeToString(hash);
        } catch (Exception e) {
            log.warn("Could not compute tree SHA: {}", e.getMessage());
            return "";
        }
    }

    private IndexingResult computeIndexingChanges(Map<String, String> previousFiles, Map<String, String> currentFiles) {
        List<String> allFiles = new ArrayList<>(currentFiles.keySet());
        List<String> newFiles = new ArrayList<>();
        List<String> changedFiles = new ArrayList<>();
        List<String> removedFiles = new ArrayList<>();
        List<String> unchangedFiles = new ArrayList<>();

        for (String path : currentFiles.keySet()) {
            String currentSha = currentFiles.get(path);
            String prevSha = previousFiles.get(path);
            if (prevSha == null) {
                newFiles.add(path);
            } else if (!prevSha.equals(currentSha)) {
                changedFiles.add(path);
            } else {
                unchangedFiles.add(path);
            }
        }

        for (String prevPath : previousFiles.keySet()) {
            if (!currentFiles.containsKey(prevPath)) {
                removedFiles.add(prevPath);
            }
        }

        return new IndexingResult(allFiles, newFiles, changedFiles, removedFiles, unchangedFiles, currentFiles);
    }

    private void deleteAllVectorsForRepo(UUID userId, String repoId) {
        try {
            FilterExpressionBuilder b = new FilterExpressionBuilder();
            Filter.Expression filter = b.and(
                    b.eq(RagSettings.METADATA_REPO_ID, repoId),
                    b.eq(RagSettings.METADATA_USER_ID, userId.toString())
            ).build();
            vectorStore.delete(filter);
            log.info("{} [INDEX] cleared existing vectors for force re-index repoId={}", Instant.now(), repoId);
        } catch (Exception ex) {
            log.error("Could not clear existing vectors for repo {}", repoId, ex);
        }
    }

    private void deleteVectorsForRemovedFiles(UUID userId, String repoId, List<String> removedFiles) {
        if (removedFiles == null || removedFiles.isEmpty()) return;

        try {
            FilterExpressionBuilder b = new FilterExpressionBuilder();
            for (int i = 0; i < removedFiles.size(); i += DELETE_PATH_BATCH_SIZE) {
                int end = Math.min(i + DELETE_PATH_BATCH_SIZE, removedFiles.size());
                List<String> pathBatch = removedFiles.subList(i, end);

                Filter.Expression pathExpr = pathBatch.size() == 1
                        ? b.eq("filePath", pathBatch.get(0)).build()
                        : b.in("filePath", pathBatch.toArray()).build();

                Filter.Expression filter = b.and(
                        b.and(
                                b.eq(RagSettings.METADATA_REPO_ID, repoId),
                                b.eq(RagSettings.METADATA_USER_ID, userId.toString())
                        ),
                        new FilterExpressionBuilder.Op(pathExpr)
                ).build();

                vectorStore.delete(filter);
            }
            log.info("{} [INDEX] deleted vectors for {} file(s) repoId={}",
                    Instant.now(), removedFiles.size(), repoId);
        } catch (Exception ex) {
            log.error("Could not delete existing vectors for removed files in repo {}", repoId, ex);
        }
    }

    private boolean addBatchWithRetry(List<Document> batch, UUID repoId, int start, int end) {
        log.info("{} [INDEX] vector batch start repoId={} chunks={}-{} batchSize={}",
                Instant.now(), repoId, start, end, batch.size());

        // CloudflareEmbeddingService already handles HTTP 429/5xx/network retries; only retry once here for transient DB issues
        for (int attempt = 0; attempt <= MAX_DB_RETRIES; attempt++) {
            try {
                vectorStore.add(batch);
                log.info("{} [INDEX] vector batch done repoId={} chunks={}-{}", Instant.now(), repoId, start, end);
                return true;
            } catch (RuntimeException e) {
                logFullError(e, repoId, start, end);

                if (isUtf8NullByteError(e)) {
                    log.error("{} [EMBED] batch contains null bytes, skipping chunks repoId={}-{}: {}",
                            Instant.now(), repoId, start, end, e.getMessage());
                    return false;
                }

                if (isContentSafetyError(e)) {
                    log.warn("{} [EMBED] content safety error detected, will split batch", Instant.now());
                    return embedBatchWithContentSafetyHandling(batch, repoId, start, end);
                }

                if (!isTransientDbError(e) || attempt >= MAX_DB_RETRIES) {
                    log.error("{} [EMBED] batch failed after {} retries repoId={}-{}: {}",
                            Instant.now(), attempt, repoId, start, end, e.getMessage());
                    return false;
                }

                long delay = BASE_RETRY_DELAY_MS;
                log.warn("{} [INDEX] transient DB batch failure, retrying (attempt {}/{}) repoId={}-{} in {}ms: {}",
                        Instant.now(), attempt + 1, MAX_DB_RETRIES + 1, repoId, start, end, delay, e.getMessage());
                try {
                    Thread.sleep(delay);
                } catch (InterruptedException ie) {
                    Thread.currentThread().interrupt();
                    log.error("Interrupted during batch retry");
                    return false;
                }
            }
        }
        return false;
    }

    private boolean embedBatchWithContentSafetyHandling(List<Document> batch, UUID repoId, int start, int end) {
        log.info("{} [EMBED] splitting batch {}-{} for content safety, processing individually",
                 Instant.now(), start, end);

        int embeddedCount = 0;

        for (int i = 0; i < batch.size(); i++) {
            Document doc = batch.get(i);
            try {
                vectorStore.add(List.of(doc));
                embeddedCount++;
            } catch (RuntimeException e) {
                if (isContentSafetyError(e)) {
                    log.warn("{} [EMBED] skipping content-safe chunk {} in batch {}-{}",
                             Instant.now(), start + i, start, end);
                } else {
                    log.warn("{} [EMBED] failed to embed chunk {}: {}",
                             Instant.now(), start + i, e.getMessage());
                }
            }
        }

        if (embeddedCount > 0) {
            log.info("{} [INDEX] embedded {} chunks from batch {}-{}, skipped {} problematic chunks",
                     Instant.now(), embeddedCount, start, end, batch.size() - embeddedCount);
            return true;
        }

        log.error("{} [EMBED] no chunks in batch {}-{} could be embedded due to content safety",
                  Instant.now(), start, end);
        return false;
    }

    private void logFullError(RuntimeException e, UUID repoId, int start, int end) {
        StringBuilder details = new StringBuilder();
        details.append("Status: embedding failed");
        details.append(", repoId: ").append(repoId);
        details.append(", chunkRange: ").append(start).append("-").append(end);
        details.append(", model: @cf/baai/bge-small-en-v1.5");
        details.append(", error: ").append(e.getMessage());

        for (Throwable current = e; current != null; current = current.getCause()) {
            String msg = current.getMessage();
            if (msg != null && !msg.equals(e.getMessage())) {
                details.append(", cause: ").append(msg);
            }
            if (msg != null && msg.contains("{")) {
                details.append(", body: ").append(msg);
                break;
            }
        }

        log.error("{} [EMBED] {}", Instant.now(), details, e);
    }

    private static boolean isTransientDbError(Throwable error) {
        for (Throwable current = error; current != null; current = current.getCause()) {
            String message = String.valueOf(current.getMessage()).toLowerCase(Locale.ROOT);
            if (message.contains("connection") && (message.contains("closed") || message.contains("reset") || message.contains("timeout"))) {
                return true;
            }
            if (message.contains("deadlock") || message.contains("could not serialize")) {
                return true;
            }
        }
        return false;
    }

    private static boolean isContentSafetyError(Throwable error) {
        for (Throwable current = error; current != null; current = current.getCause()) {
            String message = String.valueOf(current.getMessage()).toLowerCase(Locale.ROOT);
            if (message.contains("422") || message.contains("content safety") || message.contains("rejected")) {
                return true;
            }
        }
        return false;
    }

    private static boolean isUtf8NullByteError(Throwable error) {
        for (Throwable current = error; current != null; current = current.getCause()) {
            String message = String.valueOf(current.getMessage()).toLowerCase(Locale.ROOT);
            if (message.contains("invalid byte sequence for encoding utf8") && message.contains("0x00")) {
                return true;
            }
        }
        return false;
    }

    private record FilteredTree(Map<String, String> eligibleFiles, int totalBlobs, int skippedCount, long eligibleBytes, long skippedBytes) {}

    private record StreamingStats(String mode, int filesProcessed, int totalChunks) {}

    private class IndexingResult {
        final List<String> allFiles;
        final List<String> newFiles;
        final List<String> changedFiles;
        final List<String> removedFiles;
        final List<String> unchangedFiles;
        final Map<String, String> currentFiles;

        IndexingResult(List<String> allFiles, List<String> newFiles, List<String> changedFiles,
                       List<String> removedFiles, List<String> unchangedFiles, Map<String, String> currentFiles) {
            this.allFiles = allFiles;
            this.newFiles = newFiles;
            this.changedFiles = changedFiles;
            this.removedFiles = removedFiles;
            this.unchangedFiles = unchangedFiles;
            this.currentFiles = currentFiles;
        }
    }

    @Transactional
    protected void markFailed(UUID repoId, String message) {
        repositoryRepository.findById(repoId).ifPresent(repo -> {
            repo.setIndexStatus(IndexStatus.FAILED);
            repo.setErrorMessage(message != null && message.length() > 2000
                    ? message.substring(0, 2000)
                    : message);
            repo.setUpdatedAt(Instant.now());
            repositoryRepository.save(repo);
        });
    }
}
