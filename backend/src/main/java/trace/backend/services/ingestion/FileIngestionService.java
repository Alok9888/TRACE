package trace.backend.services.ingestion;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.DigestInputStream;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executor;

import org.springframework.ai.document.Document;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.stereotype.Service;
import org.springframework.web.multipart.MultipartFile;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import trace.backend.entity.IndexStatus;
import trace.backend.entity.Repository;
import trace.backend.entity.SourceType;
import trace.backend.exceptions.BadRequestException;
import trace.backend.repository.RepositoryRepository;
import trace.backend.services.ai.ChatContextCache;
import trace.backend.services.indexing.VectorBatchPersister;

/**
 * Unified multi-format file ingestion orchestrator implementing the 3-tier TRACE pipeline:
 * 1. Sync intake (~20-150ms): size/format validation, 8KB DigestInputStream to temp file,
 *    magic-bytes check, per-user SHA-256 deduplication, Repository row creation, 202 Accepted.
 * 2. Async extraction & semantic chunking on {@code indexingExecutor} (Virtual Threads, limit=4).
 * 3. Bounded-parallel vector persistence via shared {@link VectorBatchPersister} (64-chunk batches, Semaphore(3)).
 */
@Service
@RequiredArgsConstructor
@Slf4j
public class FileIngestionService implements SourceIngestionAdapter<MultipartFile> {

    public static final long MAX_FILE_BYTES = 20L * 1024L * 1024L; // 20 MB
    private static final byte[] PDF_MAGIC = new byte[] { '%', 'P', 'D', 'F', '-' };
    private static final byte[] ZIP_MAGIC = new byte[] { 'P', 'K', 0x03, 0x04 };

    private final RepositoryRepository repositoryRepository;
    private final List<DocumentExtractor> extractors;
    private final SemanticChunker semanticChunker;
    private final VectorBatchPersister vectorBatchPersister;

    @Autowired(required = false)
    @Qualifier("indexingExecutor")
    private Executor indexingExecutor;

    @Autowired(required = false)
    private ChatContextCache chatContextCache;

    @Override
    public SourceType supportedType() {
        return SourceType.PDF;
    }

    @Override
    public Repository ingest(UUID workspaceId, MultipartFile file) {
        if (file == null || file.isEmpty()) {
            throw new BadRequestException("Please select a non-empty file to upload.");
        }
        if (file.getSize() > MAX_FILE_BYTES) {
            throw new BadRequestException("File exceeds the 20 MB upload size limit.");
        }

        String rawName = file.getOriginalFilename();
        String contentType = file.getContentType();
        DocumentExtractor extractor = resolveExtractor(rawName, contentType);
        SourceType sourceType = extractor.getSourceType();
        String sanitizedName = sanitizeFileName(rawName, sourceType);

        Path tempFile = null;
        String sha256;
        long exactSize;
        try {
            tempFile = Files.createTempFile("trace-upload-", ".tmp");
            UploadedFileInfo info = copyHashAndValidateMagic(file, tempFile, sourceType);
            sha256 = info.sha256();
            exactSize = info.sizeBytes();
        } catch (BadRequestException e) {
            deleteQuietly(tempFile);
            throw e;
        } catch (IOException e) {
            deleteQuietly(tempFile);
            throw new BadRequestException("Could not read uploaded file.");
        }

        // Single-pass SHA-256 deduplication per workspace: return immediately if an identical READY source exists
        Optional<Repository> existingReady = repositoryRepository
                .findFirstByUserIdAndTreeShaAndSourceTypeAndIndexStatus(
                        workspaceId, sha256, sourceType, IndexStatus.READY);
        if (existingReady.isPresent()) {
            deleteQuietly(tempFile);
            Repository existing = existingReady.get();
            log.info("{} [INGEST] dedup hit sourceId={} type={} file={} sha256={}",
                    Instant.now(), existing.getId(), sourceType, sanitizedName, sha256.substring(0, 12));
            return existing;
        }

        Repository source = Repository.builder()
                .userId(workspaceId)
                .sourceType(sourceType)
                .githubRepoId(generateUniqueExternalId())
                .owner(ownerLabelFor(sourceType))
                .name(stripExtension(sanitizedName))
                .fullName(sanitizedName)
                .isPrivate(true)
                .defaultBranch("document")
                .language(languageLabelFor(sourceType, sanitizedName))
                .htmlUrl(null)
                .description(formatFileDescription(sourceType, exactSize, null))
                .fileName(sanitizedName)
                .fileSizeBytes(exactSize)
                .pageCount(null)
                .storageKey(sourceType.name().toLowerCase(Locale.ROOT) + ":" + sha256.substring(0, Math.min(24, sha256.length())))
                .treeSha(sha256)
                .indexStatus(IndexStatus.INDEXING)
                .indexingStage("fetching")
                .indexingDetail(initialStageDetail(sourceType))
                .filesTotal(0)
                .filesProcessed(0)
                .chunkCount(0)
                .chunksTotal(0)
                .chunksProcessed(0)
                .build();

        source = repositoryRepository.save(source);
        UUID sourceId = source.getId();
        Path finalTempFile = tempFile;

        Runnable pipeline = () -> processFileAsync(
                sourceId, workspaceId, extractor, sourceType, sanitizedName, exactSize, finalTempFile);
        if (indexingExecutor != null) {
            CompletableFuture.runAsync(pipeline, indexingExecutor);
        } else {
            CompletableFuture.runAsync(pipeline);
        }

        return source;
    }

    void processFileAsync(
            UUID sourceId,
            UUID workspaceId,
            DocumentExtractor extractor,
            SourceType sourceType,
            String fileName,
            long fileSizeBytes,
            Path tempFile) {
        long startMs = System.currentTimeMillis();
        try {
            log.info("{} [INGEST] start sourceId={} type={} file={} bytes={}",
                    Instant.now(), sourceId, sourceType, fileName, fileSizeBytes);
            updateProgress(sourceId, "fetching", initialStageDetail(sourceType), 0, 0, 0, 0);

            List<ExtractedSection> sections = extractor.extract(tempFile, fileName);
            if (sections == null || sections.isEmpty()) {
                throw new BadRequestException("No extractable content was found in " + fileName + ".");
            }
            int unitCount = sections.size();

            updateProgress(sourceId, "chunking",
                    "Segmenting " + unitCount + " " + unitNoun(sourceType, unitCount) + " into semantic chunks...",
                    unitCount, unitCount, 0, 0);

            List<Document> chunks = semanticChunker.chunkSections(
                    workspaceId, sourceId.toString(), sourceType, fileName, sections);
            if (chunks.isEmpty()) {
                throw new BadRequestException("No indexable text segments could be extracted from " + fileName + ".");
            }

            updateProgress(sourceId, "embedding",
                    "Embedding " + chunks.size() + " chunks...",
                    unitCount, unitCount, 0, chunks.size());

            VectorBatchPersister.PersistResult persist = vectorBatchPersister.persistAll(
                    sourceId,
                    chunks,
                    (done, total) -> updateProgress(
                            sourceId,
                            "embedding",
                            "Embedded " + done + "/" + total + " chunks...",
                            unitCount,
                            unitCount,
                            done,
                            total));

            if (persist.failed()) {
                markFailed(sourceId, "Embedding batch failed while indexing " + fileName + ". Please try again.");
                return;
            }

            updateProgress(sourceId, "saving", "Finalizing vector index...",
                    unitCount, unitCount, chunks.size(), chunks.size());

            Repository repo = repositoryRepository.findById(sourceId).orElse(null);
            if (repo == null) {
                return;
            }
            repo.setPageCount(unitCount);
            repo.setFilesTotal(unitCount);
            repo.setFilesProcessed(unitCount);
            repo.setChunkCount(chunks.size());
            repo.setChunksTotal(chunks.size());
            repo.setChunksProcessed(chunks.size());
            repo.setDescription(formatFileDescription(sourceType, fileSizeBytes, unitCount));
            repo.setIndexedAt(Instant.now());
            repo.setIndexStatus(IndexStatus.READY);
            repo.setIndexingStage("done");
            repo.setIndexingDetail("Indexing complete");
            repo.setErrorMessage(null);
            repo.setUpdatedAt(Instant.now());
            repositoryRepository.save(repo);

            if (chatContextCache != null) {
                chatContextCache.invalidateRepository(sourceId);
            }

            log.info("{} [INGEST] complete sourceId={} type={} file={} units={} chunks={} time={}ms",
                    Instant.now(), sourceId, sourceType, fileName, unitCount, chunks.size(),
                    System.currentTimeMillis() - startMs);
        } catch (Exception ex) {
            log.error("{} [INGEST] failed sourceId={} type={} file={}: {}",
                    Instant.now(), sourceId, sourceType, fileName, ex.getMessage(), ex);
            markFailed(sourceId, ex.getMessage() != null ? ex.getMessage() : "File indexing failed.");
        } finally {
            deleteQuietly(tempFile);
        }
    }

    private DocumentExtractor resolveExtractor(String filename, String contentType) {
        for (DocumentExtractor extractor : extractors) {
            if (extractor.supports(filename, contentType)) {
                return extractor;
            }
        }
        throw new BadRequestException(
                "Unsupported file format. Supported formats: PDF (.pdf), Jupyter Notebook (.ipynb), EPUB (.epub), and IaC/CI configs (.tf, Dockerfile, .yml/.yaml).");
    }

    private record UploadedFileInfo(long sizeBytes, String sha256) {}

    private static UploadedFileInfo copyHashAndValidateMagic(
            MultipartFile file, Path target, SourceType sourceType) throws IOException {
        MessageDigest digest;
        try {
            digest = MessageDigest.getInstance("SHA-256");
        } catch (Exception e) {
            throw new IOException("SHA-256 unavailable", e);
        }

        long totalBytes = 0L;
        byte[] headerBuf = new byte[16];
        int headerRead = 0;

        try (InputStream in = new DigestInputStream(file.getInputStream(), digest);
             OutputStream out = Files.newOutputStream(target)) {
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) >= 0) {
                if (n == 0) continue;
                totalBytes += n;
                if (totalBytes > MAX_FILE_BYTES) {
                    throw new BadRequestException("File exceeds the 20 MB upload size limit.");
                }
                if (headerRead < headerBuf.length) {
                    int copyLen = Math.min(n, headerBuf.length - headerRead);
                    System.arraycopy(buf, 0, headerBuf, headerRead, copyLen);
                    headerRead += copyLen;
                }
                out.write(buf, 0, n);
            }
        }

        if (totalBytes == 0) {
            throw new BadRequestException("Uploaded file is empty.");
        }

        if (sourceType == SourceType.PDF && !startsWith(headerBuf, headerRead, PDF_MAGIC)) {
            throw new BadRequestException("Uploaded file is not a valid PDF document (invalid PDF header).");
        }
        if (sourceType == SourceType.EPUB && !startsWith(headerBuf, headerRead, ZIP_MAGIC)) {
            throw new BadRequestException("Uploaded file is not a valid EPUB archive (invalid ZIP header).");
        }
        if (sourceType == SourceType.NOTEBOOK && !startsWithJsonObject(headerBuf, headerRead)) {
            throw new BadRequestException("Uploaded file is not a valid Jupyter Notebook (.ipynb JSON expected).");
        }

        return new UploadedFileInfo(totalBytes, HexFormat.of().formatHex(digest.digest()));
    }

    private static boolean startsWith(byte[] buf, int len, byte[] magic) {
        if (len < magic.length) return false;
        for (int i = 0; i < magic.length; i++) {
            if (buf[i] != magic[i]) return false;
        }
        return true;
    }

    private static boolean startsWithJsonObject(byte[] buf, int len) {
        int i = 0;
        // Skip optional UTF-8 BOM (EF BB BF)
        if (len >= 3 && (buf[0] & 0xFF) == 0xEF && (buf[1] & 0xFF) == 0xBB && (buf[2] & 0xFF) == 0xBF) {
            i = 3;
        }
        while (i < len && Character.isWhitespace((char) (buf[i] & 0xFF))) {
            i++;
        }
        return i < len && buf[i] == '{';
    }

    private void updateProgress(
            UUID sourceId,
            String stage,
            String detail,
            int unitsDone,
            int unitsTotal,
            int chunksDone,
            int chunksTotal) {
        try {
            repositoryRepository.updateIndexingProgress(
                    sourceId, stage, detail, unitsDone, unitsTotal, chunksDone, chunksTotal, Instant.now());
        } catch (Exception e) {
            log.warn("Could not update file indexing progress sourceId={}: {}", sourceId, e.getMessage());
        }
    }

    private void markFailed(UUID sourceId, String message) {
        try {
            repositoryRepository.findById(sourceId).ifPresent(repo -> {
                repo.setIndexStatus(IndexStatus.FAILED);
                repo.setIndexingStage("failed");
                repo.setIndexingDetail("Indexing failed");
                repo.setErrorMessage(message);
                repo.setUpdatedAt(Instant.now());
                repositoryRepository.save(repo);
            });
        } catch (Exception e) {
            log.error("Failed to mark source {} as FAILED: {}", sourceId, e.getMessage());
        }
    }

    private static long generateUniqueExternalId() {
        return UUID.randomUUID().getMostSignificantBits() | Long.MIN_VALUE;
    }

    private static String ownerLabelFor(SourceType type) {
        return switch (type) {
            case PDF -> "PDF";
            case NOTEBOOK -> "NOTEBOOK";
            case IAC -> "IAC";
            case EPUB -> "EPUB";
            default -> "SOURCE";
        };
    }

    private static String languageLabelFor(SourceType type, String fileName) {
        return switch (type) {
            case PDF -> "PDF";
            case NOTEBOOK -> "Jupyter";
            case EPUB -> "EPUB";
            case IAC -> {
                String lower = fileName.toLowerCase(Locale.ROOT);
                if (lower.endsWith(".tf")) yield "Terraform";
                if (lower.contains("dockerfile")) yield "Docker";
                if (lower.contains("compose")) yield "Compose";
                yield "YAML";
            }
            default -> "Document";
        };
    }

    private static String initialStageDetail(SourceType type) {
        return switch (type) {
            case PDF -> "Extracting PDF pages...";
            case NOTEBOOK -> "Streaming notebook cells (skipping binary outputs)...";
            case IAC -> "Parsing infrastructure blocks...";
            case EPUB -> "Extracting EPUB chapters in spine order...";
            default -> "Extracting document content...";
        };
    }

    private static String unitNoun(SourceType type, int count) {
        return switch (type) {
            case PDF -> count == 1 ? "page" : "pages";
            case NOTEBOOK -> count == 1 ? "cell" : "cells";
            case IAC -> count == 1 ? "block" : "blocks";
            case EPUB -> count == 1 ? "chapter" : "chapters";
            default -> count == 1 ? "section" : "sections";
        };
    }

    private static String formatFileDescription(SourceType type, long sizeBytes, Integer unitCount) {
        String sizeStr = sizeBytes >= 1024 * 1024
                ? String.format(Locale.ROOT, "%.1f MB", sizeBytes / (1024.0 * 1024.0))
                : String.format(Locale.ROOT, "%d KB", Math.max(1L, Math.round(sizeBytes / 1024.0)));
        String typeLabel = switch (type) {
            case PDF -> "PDF document";
            case NOTEBOOK -> "Jupyter notebook";
            case IAC -> "IaC / CI config";
            case EPUB -> "EPUB book";
            default -> "Document";
        };
        if (unitCount != null && unitCount > 0) {
            return String.format(Locale.ROOT, "%s · %d %s · %s",
                    typeLabel, unitCount, unitNoun(type, unitCount), sizeStr);
        }
        return typeLabel + " · " + sizeStr;
    }

    static String sanitizeFileName(String raw, SourceType sourceType) {
        if (raw == null || raw.isBlank()) {
            return switch (sourceType) {
                case PDF -> "document.pdf";
                case NOTEBOOK -> "notebook.ipynb";
                case EPUB -> "book.epub";
                case IAC -> "config.tf";
                default -> "document.txt";
            };
        }
        String base = raw.replace('\\', '/');
        int slash = base.lastIndexOf('/');
        if (slash >= 0) {
            base = base.substring(slash + 1);
        }
        base = base.replace("\0", "").trim();
        if (base.isEmpty()) {
            return "document";
        }
        return base.length() > 240 ? base.substring(0, 240) : base;
    }

    private static String stripExtension(String fileName) {
        String lower = fileName.toLowerCase(Locale.ROOT);
        if ("dockerfile".equals(lower)) {
            return fileName;
        }
        int dot = fileName.lastIndexOf('.');
        String stripped = dot > 0 ? fileName.substring(0, dot).trim() : fileName.trim();
        if (stripped.isEmpty()) {
            return fileName;
        }
        return stripped.length() > 180 ? stripped.substring(0, 180) : stripped;
    }

    private static void deleteQuietly(Path path) {
        if (path == null) return;
        try {
            Files.deleteIfExists(path);
        } catch (IOException ignored) {
        }
    }
}
