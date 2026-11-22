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
 * Isolated PDF ingestion adapter implementing {@link SourceIngestionAdapter}.
 * Validates uploads, streams bytes to a bounded temp file (heap-safe under -Xmx160m),
 * extracts page-bounded text via {@link PdfTextExtractor}, chunks via {@link PdfChunker},
 * and persists embeddings through the shared {@link VectorBatchPersister}.
 */
@Service
@RequiredArgsConstructor
@Slf4j
public class PdfIngestionService implements SourceIngestionAdapter<MultipartFile> {

    public static final long MAX_PDF_BYTES = 20L * 1024L * 1024L; // 20 MB
    private static final byte[] PDF_MAGIC = new byte[] { '%', 'P', 'D', 'F', '-' };

    private final RepositoryRepository repositoryRepository;
    private final PdfTextExtractor pdfTextExtractor;
    private final PdfChunker pdfChunker;
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
        validateUpload(file);

        String originalName = sanitizeFileName(file.getOriginalFilename());
        String displayName = stripPdfExtension(originalName);

        Path tempFile = null;
        String sha256;
        long exactSize;
        try {
            tempFile = Files.createTempFile("trace-pdf-", ".pdf");
            UploadedFileInfo info = copyAndVerifyMagicHeader(file, tempFile);
            sha256 = info.sha256();
            exactSize = info.sizeBytes();
        } catch (BadRequestException e) {
            deleteQuietly(tempFile);
            throw e;
        } catch (IOException e) {
            deleteQuietly(tempFile);
            throw new BadRequestException("Could not read uploaded PDF file.");
        }

        Repository source = Repository.builder()
                .userId(workspaceId)
                .sourceType(SourceType.PDF)
                .githubRepoId(generateUniquePdfExternalId())
                .owner("PDF")
                .name(displayName)
                .fullName(originalName)
                .isPrivate(true)
                .defaultBranch("document")
                .language("PDF")
                .htmlUrl(null)
                .description(formatFileDescription(exactSize, null))
                .fileName(originalName)
                .fileSizeBytes(exactSize)
                .pageCount(null)
                .storageKey("pdf:" + sha256.substring(0, Math.min(24, sha256.length())))
                .treeSha(sha256)
                .indexStatus(IndexStatus.INDEXING)
                .indexingStage("fetching")
                .indexingDetail("Extracting PDF pages...")
                .filesTotal(0)
                .filesProcessed(0)
                .chunkCount(0)
                .chunksTotal(0)
                .chunksProcessed(0)
                .build();

        source = repositoryRepository.save(source);
        UUID sourceId = source.getId();
        Path finalTempFile = tempFile;

        Runnable pipeline = () -> processPdfAsync(sourceId, workspaceId, originalName, exactSize, finalTempFile);
        if (indexingExecutor != null) {
            CompletableFuture.runAsync(pipeline, indexingExecutor);
        } else {
            CompletableFuture.runAsync(pipeline);
        }

        return source;
    }

    void processPdfAsync(UUID sourceId, UUID workspaceId, String fileName, long fileSizeBytes, Path tempFile) {
        long startMs = System.currentTimeMillis();
        try {
            log.info("{} [PDF] start sourceId={} file={} bytes={}", Instant.now(), sourceId, fileName, fileSizeBytes);
            updateProgress(sourceId, "fetching", "Extracting text from PDF pages...", 0, 0, 0, 0);

            PdfTextExtractor.ExtractionResult extracted = pdfTextExtractor.extract(tempFile.toFile());
            int totalPages = extracted.totalPages();

            updateProgress(sourceId, "chunking",
                    "Segmenting " + totalPages + " pages into semantic chunks...",
                    totalPages, totalPages, 0, 0);

            List<Document> chunks = pdfChunker.chunkPages(workspaceId, sourceId.toString(), fileName, extracted.pages());
            if (chunks.isEmpty()) {
                throw new BadRequestException("No indexable text segments could be extracted from this PDF.");
            }

            updateProgress(sourceId, "embedding",
                    "Embedding " + chunks.size() + " document chunks...",
                    totalPages, totalPages, 0, chunks.size());

            VectorBatchPersister.PersistResult persist = vectorBatchPersister.persistAll(
                    sourceId,
                    chunks,
                    (done, total) -> updateProgress(
                            sourceId,
                            "embedding",
                            "Embedded " + done + "/" + total + " chunks...",
                            totalPages,
                            totalPages,
                            done,
                            total));

            if (persist.failed()) {
                markFailed(sourceId, "Embedding batch failed while indexing PDF. Please try again.");
                return;
            }

            updateProgress(sourceId, "saving", "Finalizing document index...",
                    totalPages, totalPages, chunks.size(), chunks.size());

            Repository repo = repositoryRepository.findById(sourceId).orElse(null);
            if (repo == null) {
                return;
            }
            repo.setPageCount(totalPages);
            repo.setFilesTotal(totalPages);
            repo.setFilesProcessed(totalPages);
            repo.setChunkCount(chunks.size());
            repo.setChunksTotal(chunks.size());
            repo.setChunksProcessed(chunks.size());
            repo.setDescription(formatFileDescription(fileSizeBytes, totalPages));
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

            log.info("{} [PDF] complete sourceId={} file={} pages={} chunks={} time={}ms",
                    Instant.now(), sourceId, fileName, totalPages, chunks.size(), System.currentTimeMillis() - startMs);
        } catch (Exception ex) {
            log.error("{} [PDF] failed sourceId={} file={}: {}", Instant.now(), sourceId, fileName, ex.getMessage(), ex);
            markFailed(sourceId, ex.getMessage() != null ? ex.getMessage() : "PDF indexing failed.");
        } finally {
            deleteQuietly(tempFile);
        }
    }

    private void updateProgress(
            UUID sourceId,
            String stage,
            String detail,
            int pagesDone,
            int pagesTotal,
            int chunksDone,
            int chunksTotal) {
        try {
            repositoryRepository.updateIndexingProgress(
                    sourceId, stage, detail, pagesDone, pagesTotal, chunksDone, chunksTotal, Instant.now());
        } catch (Exception e) {
            log.warn("Could not update PDF indexing progress sourceId={}: {}", sourceId, e.getMessage());
        }
    }

    private void markFailed(UUID sourceId, String message) {
        try {
            repositoryRepository.findById(sourceId).ifPresent(repo -> {
                repo.setIndexStatus(IndexStatus.FAILED);
                repo.setIndexingStage("failed");
                repo.setIndexingDetail("PDF indexing failed");
                repo.setErrorMessage(message);
                repo.setUpdatedAt(Instant.now());
                repositoryRepository.save(repo);
            });
        } catch (Exception e) {
            log.error("Failed to mark PDF source {} as FAILED: {}", sourceId, e.getMessage());
        }
    }

    private static void validateUpload(MultipartFile file) {
        if (file == null || file.isEmpty()) {
            throw new BadRequestException("Please select a non-empty PDF file to upload.");
        }
        if (file.getSize() > MAX_PDF_BYTES) {
            throw new BadRequestException("PDF exceeds the 20 MB size limit.");
        }
        String name = file.getOriginalFilename();
        String contentType = file.getContentType();
        boolean hasPdfExt = name != null && name.toLowerCase(Locale.ROOT).endsWith(".pdf");
        boolean hasPdfMime = contentType != null && contentType.toLowerCase(Locale.ROOT).contains("pdf");
        if (!hasPdfExt && !hasPdfMime) {
            throw new BadRequestException("Only PDF (.pdf) documents are supported.");
        }
    }

    private record UploadedFileInfo(long sizeBytes, String sha256) {}

    private static UploadedFileInfo copyAndVerifyMagicHeader(MultipartFile file, Path target) throws IOException {
        MessageDigest digest;
        try {
            digest = MessageDigest.getInstance("SHA-256");
        } catch (Exception e) {
            throw new IOException("SHA-256 unavailable", e);
        }

        long totalBytes = 0L;
        byte[] headerBuf = new byte[PDF_MAGIC.length];
        int headerRead = 0;

        try (InputStream in = new DigestInputStream(file.getInputStream(), digest);
             OutputStream out = Files.newOutputStream(target)) {
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) >= 0) {
                if (n == 0) continue;
                totalBytes += n;
                if (totalBytes > MAX_PDF_BYTES) {
                    throw new BadRequestException("PDF exceeds the 20 MB size limit.");
                }
                if (headerRead < PDF_MAGIC.length) {
                    int copyLen = Math.min(n, PDF_MAGIC.length - headerRead);
                    System.arraycopy(buf, 0, headerBuf, headerRead, copyLen);
                    headerRead += copyLen;
                }
                out.write(buf, 0, n);
            }
        }

        if (headerRead < PDF_MAGIC.length) {
            throw new BadRequestException("Uploaded file is not a valid PDF document.");
        }
        for (int i = 0; i < PDF_MAGIC.length; i++) {
            if (headerBuf[i] != PDF_MAGIC[i]) {
                throw new BadRequestException("Uploaded file is not a valid PDF document (invalid PDF header).");
            }
        }
        return new UploadedFileInfo(totalBytes, HexFormat.of().formatHex(digest.digest()));
    }

    private static long generateUniquePdfExternalId() {
        // Negative 64-bit ID guarantees zero collision with positive GitHub repo IDs under (user_id, github_repo_id)
        return UUID.randomUUID().getMostSignificantBits() | Long.MIN_VALUE;
    }

    static String sanitizeFileName(String raw) {
        if (raw == null || raw.isBlank()) {
            return "document.pdf";
        }
        String base = raw.replace('\\', '/');
        int slash = base.lastIndexOf('/');
        if (slash >= 0) {
            base = base.substring(slash + 1);
        }
        base = base.replace("\0", "").trim();
        if (base.isEmpty()) {
            return "document.pdf";
        }
        if (!base.toLowerCase(Locale.ROOT).endsWith(".pdf")) {
            base = base + ".pdf";
        }
        return base.length() > 240 ? base.substring(0, 236) + ".pdf" : base;
    }

    private static String stripPdfExtension(String fileName) {
        String stripped = fileName.toLowerCase(Locale.ROOT).endsWith(".pdf")
                ? fileName.substring(0, fileName.length() - 4)
                : fileName;
        String clean = stripped.trim();
        if (clean.isEmpty()) {
            return "Document";
        }
        return clean.length() > 180 ? clean.substring(0, 180) : clean;
    }

    private static String formatFileDescription(long sizeBytes, Integer pageCount) {
        String sizeStr = sizeBytes >= 1024 * 1024
                ? String.format(Locale.ROOT, "%.1f MB", sizeBytes / (1024.0 * 1024.0))
                : String.format(Locale.ROOT, "%d KB", Math.max(1L, Math.round(sizeBytes / 1024.0)));
        if (pageCount != null && pageCount > 0) {
            return String.format(Locale.ROOT, "PDF document · %d %s · %s",
                    pageCount, pageCount == 1 ? "page" : "pages", sizeStr);
        }
        return "PDF document · " + sizeStr;
    }

    private static void deleteQuietly(Path path) {
        if (path == null) return;
        try {
            Files.deleteIfExists(path);
        } catch (IOException ignored) {
        }
    }
}
