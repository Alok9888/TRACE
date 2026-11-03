package devPilot.backend.services.indexing;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.ai.document.Document;
import org.springframework.ai.transformer.splitter.TokenTextSplitter;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import devPilot.backend.services.ai.RagSettings;

@Component
public class CodeChunker {
    private final TokenTextSplitter splitter;
    private final CodeFileFilter fileFilter;
    private final int overlapTokens;

    public CodeChunker(
            @Value("${app.indexing.chunk-size:1600}") int chunkSize,
            CodeFileFilter fileFilter) {
        // Spring AI splits by tokens; ~4 characters per token -> 1600 chars ~= 400 tokens (fits 512-token model window).
        int chunkTokens = Math.max(50, chunkSize / 4);
        this.overlapTokens = chunkTokens / 10; // 10% overlap

        this.splitter = TokenTextSplitter.builder()
                .withChunkSize(chunkTokens)
                .build();
        this.fileFilter = fileFilter;
    }

    public List<Document> chunkFile(UUID userId, String repoId, String filePath, String content) {
        if (content == null || content.isBlank()) {
            return List.of();
        }

        // Sanitize input: remove null bytes that cause UTF8 encoding errors in Postgres
        String sanitizedContent = sanitize(content);
        String sanitizedFilePath = sanitize(filePath);
        String sanitizedRepoId = sanitize(repoId);

        String language = sanitize(fileFilter.detectLanguage(sanitizedFilePath));
        String header = "// File: " + sanitizedFilePath + "\n";

        Document source = new Document(sanitizedContent, baseMetadata(userId, sanitizedRepoId, sanitizedFilePath, language));
        List<Document> split = splitter.apply(List.of(source));
        if (split.isEmpty()) {
            return List.of();
        }

        // Compute 1-based startLine/endLine for each raw split chunk before adding overlap/header
        List<ChunkSpan> spans = computeLineSpans(sanitizedContent, split);

        // Apply 10% overlap and prepend "// File: <path>\n" header to EVERY chunk
        int overlapChars = overlapTokens * 4;
        List<Document> result = new ArrayList<>(spans.size());

        for (int i = 0; i < spans.size(); i++) {
            ChunkSpan current = spans.get(i);
            String body = current.text;
            int startLine = current.startLine;
            int endLine = current.endLine;

            if (i > 0 && overlapChars > 0) {
                ChunkSpan prev = spans.get(i - 1);
                String prevText = prev.text;
                if (prevText != null && !prevText.isEmpty()) {
                    int overlapStart = Math.max(0, prevText.length() - overlapChars);
                    String overlap = prevText.substring(overlapStart);
                    int overlapLines = countNewlines(overlap);
                    startLine = Math.max(1, prev.endLine - overlapLines);
                    body = overlap + "\n" + body;
                }
            }

            Map<String, Object> metadata = new HashMap<>(current.metadata);
            metadata.put(RagSettings.METADATA_REPO_ID, sanitizedRepoId);
            metadata.put(RagSettings.METADATA_USER_ID, userId.toString());
            metadata.put("filePath", sanitizedFilePath);
            metadata.put("language", language);
            metadata.put("chunkIndex", i);
            metadata.put("startLine", startLine);
            metadata.put("endLine", endLine);

            result.add(new Document(sanitize(header + body), metadata));
        }

        return result;
    }

    private List<ChunkSpan> computeLineSpans(String fullContent, List<Document> chunks) {
        List<ChunkSpan> spans = new ArrayList<>(chunks.size());
        int totalLines = countNewlines(fullContent) + 1;
        int cursor = 0;
        int cursorLine = 1;

        for (Document chunk : chunks) {
            String rawText = chunk.getText() == null ? "" : chunk.getText();
            int matchPos = findChunkOffset(fullContent, rawText, cursor);
            int startLine;
            int endLine;

            if (matchPos >= 0) {
                cursorLine += countNewlines(fullContent, cursor, matchPos);
                startLine = cursorLine;
                int chunkLines = countNewlines(rawText);
                endLine = Math.min(totalLines, startLine + chunkLines);
                int nextCursor = Math.min(fullContent.length(), matchPos + rawText.length());
                cursorLine += countNewlines(fullContent, matchPos, nextCursor);
                cursor = nextCursor;
            } else {
                startLine = cursorLine;
                int chunkLines = countNewlines(rawText);
                endLine = Math.min(totalLines, startLine + chunkLines);
            }

            spans.add(new ChunkSpan(rawText, startLine, Math.max(startLine, endLine), chunk.getMetadata()));
        }

        return spans;
    }

    private static int findChunkOffset(String fullContent, String chunkText, int fromIndex) {
        if (chunkText.isEmpty()) {
            return fromIndex;
        }
        int exact = fullContent.indexOf(chunkText, fromIndex);
        if (exact >= 0) {
            return exact;
        }
        String trimmed = chunkText.stripLeading();
        if (trimmed.isEmpty()) {
            return fromIndex;
        }
        int probeLen = Math.min(48, trimmed.length());
        int probe = fullContent.indexOf(trimmed.substring(0, probeLen), fromIndex);
        if (probe >= 0) {
            return probe;
        }
        return -1;
    }

    private static int countNewlines(String text) {
        return countNewlines(text, 0, text.length());
    }

    private static int countNewlines(String text, int start, int end) {
        int count = 0;
        int limit = Math.min(end, text.length());
        for (int i = Math.max(0, start); i < limit; i++) {
            if (text.charAt(i) == '\n') {
                count++;
            }
        }
        return count;
    }

    private static Map<String, Object> baseMetadata(UUID userId, String repoId, String filePath, String language) {
        Map<String, Object> metadata = new HashMap<>();
        metadata.put(RagSettings.METADATA_REPO_ID, repoId);
        metadata.put(RagSettings.METADATA_USER_ID, userId.toString());
        metadata.put("filePath", filePath);
        metadata.put("language", language);
        return metadata;
    }

    /** Remove null bytes that cause UTF8 encoding errors in Postgres TEXT/jsonb columns (zero-alloc fast path). */
    private static String sanitize(String input) {
        if (input == null || input.indexOf('\0') < 0) {
            return input;
        }
        return input.replace("\0", "");
    }

    private record ChunkSpan(String text, int startLine, int endLine, Map<String, Object> metadata) {}
}
