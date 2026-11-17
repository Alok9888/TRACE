package trace.backend.services.indexing;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.ai.document.Document;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import trace.backend.services.ai.RagSettings;

/**
 * Fast, single-pass, line-boundary-aware code chunker.
 * Avoids heavy BPE tokenization overhead while tracking exact 1-based line spans
 * and keeping every chunk safely within bge-small-en-v1.5's 512-token window.
 */
@Component
public class CodeChunker {
    private final int maxChunkChars;
    private final int overlapChars;
    private final CodeFileFilter fileFilter;

    public CodeChunker(
            @Value("${app.indexing.chunk-size:1600}") int chunkSize,
            CodeFileFilter fileFilter) {
        this.maxChunkChars = Math.max(200, chunkSize);
        this.overlapChars = Math.max(0, this.maxChunkChars / 10); // 10% overlap
        this.fileFilter = fileFilter;
    }

    public List<Document> chunkFile(UUID userId, String repoId, String filePath, String content) {
        if (content == null || content.isBlank()) {
            return List.of();
        }

        String sanitizedContent = sanitize(content);
        String sanitizedFilePath = sanitize(filePath);
        String sanitizedRepoId = sanitize(repoId);
        String userIdStr = userId.toString();

        String language = sanitize(fileFilter.detectLanguage(sanitizedFilePath));
        String header = "// File: " + sanitizedFilePath + "\n";

        List<LineSlice> lines = splitLines(sanitizedContent);
        if (lines.isEmpty()) {
            return List.of();
        }

        List<RawChunk> rawChunks = buildLineAwareChunks(sanitizedContent, lines);
        if (rawChunks.isEmpty()) {
            return List.of();
        }

        List<Document> result = new ArrayList<>(rawChunks.size());
        for (int i = 0; i < rawChunks.size(); i++) {
            RawChunk current = rawChunks.get(i);
            String body = current.text;
            int startLine = current.startLine;
            int endLine = current.endLine;

            if (i > 0 && overlapChars > 0) {
                RawChunk prev = rawChunks.get(i - 1);
                String prevText = prev.text;
                if (prevText != null && !prevText.isEmpty()) {
                    int overlapStart = Math.max(0, prevText.length() - overlapChars);
                    // Snap overlap start forward to the next line boundary when possible for cleaner code context
                    int nl = prevText.indexOf('\n', overlapStart);
                    if (nl >= 0 && nl + 1 < prevText.length()) {
                        overlapStart = nl + 1;
                    }
                    String overlap = prevText.substring(overlapStart);
                    int overlapLines = countNewlines(overlap);
                    startLine = Math.max(1, prev.endLine - overlapLines);
                    body = overlap + "\n" + body;
                }
            }

            Map<String, Object> metadata = new HashMap<>(8);
            metadata.put(RagSettings.METADATA_REPO_ID, sanitizedRepoId);
            metadata.put(RagSettings.METADATA_USER_ID, userIdStr);
            metadata.put("filePath", sanitizedFilePath);
            metadata.put("language", language);
            metadata.put("chunkIndex", i);
            metadata.put("startLine", startLine);
            metadata.put("endLine", endLine);

            result.add(new Document(header + body, metadata));
        }

        return result;
    }

    private List<RawChunk> buildLineAwareChunks(String content, List<LineSlice> lines) {
        List<RawChunk> chunks = new ArrayList<>();
        StringBuilder buf = new StringBuilder(Math.min(content.length(), maxChunkChars + 64));
        int chunkStartLine = -1;
        int chunkEndLine = -1;

        for (LineSlice line : lines) {
            int lineLen = line.end - line.start;
            // Hard-slice abnormally long single lines (e.g. minified bundles/JSON) so we never overflow token windows
            if (lineLen > maxChunkChars) {
                if (!buf.isEmpty()) {
                    flushChunk(chunks, buf, chunkStartLine, chunkEndLine);
                    chunkStartLine = -1;
                }
                for (int offset = line.start; offset < line.end; offset += maxChunkChars) {
                    int sliceEnd = Math.min(offset + maxChunkChars, line.end);
                    String piece = content.substring(offset, sliceEnd);
                    if (!piece.isBlank()) {
                        chunks.add(new RawChunk(piece, line.lineNumber, line.lineNumber));
                    }
                }
                continue;
            }

            int projected = buf.length() + (buf.isEmpty() ? 0 : 1) + lineLen;
            if (!buf.isEmpty() && projected > maxChunkChars) {
                flushChunk(chunks, buf, chunkStartLine, chunkEndLine);
                chunkStartLine = -1;
            }

            if (chunkStartLine < 0) {
                chunkStartLine = line.lineNumber;
            } else {
                buf.append('\n');
            }
            buf.append(content, line.start, line.end);
            chunkEndLine = line.lineNumber;
        }

        if (!buf.isEmpty()) {
            flushChunk(chunks, buf, chunkStartLine, chunkEndLine);
        }
        return chunks;
    }

    private static void flushChunk(List<RawChunk> chunks, StringBuilder buf, int startLine, int endLine) {
        String text = buf.toString();
        buf.setLength(0);
        if (!text.isBlank()) {
            chunks.add(new RawChunk(text, Math.max(1, startLine), Math.max(Math.max(1, startLine), endLine)));
        }
    }

    private static List<LineSlice> splitLines(String content) {
        List<LineSlice> lines = new ArrayList<>(Math.max(16, content.length() / 48));
        int len = content.length();
        int lineStart = 0;
        int lineNum = 1;
        for (int i = 0; i < len; i++) {
            if (content.charAt(i) == '\n') {
                int lineEnd = (i > lineStart && content.charAt(i - 1) == '\r') ? i - 1 : i;
                lines.add(new LineSlice(lineStart, lineEnd, lineNum));
                lineNum++;
                lineStart = i + 1;
            }
        }
        if (lineStart < len) {
            int lineEnd = (len > lineStart && content.charAt(len - 1) == '\r') ? len - 1 : len;
            lines.add(new LineSlice(lineStart, lineEnd, lineNum));
        }
        return lines;
    }

    private static int countNewlines(String text) {
        int count = 0;
        for (int i = 0; i < text.length(); i++) {
            if (text.charAt(i) == '\n') {
                count++;
            }
        }
        return count;
    }

    /** Remove null bytes that cause UTF8 encoding errors in Postgres TEXT/jsonb columns (zero-alloc fast path). */
    private static String sanitize(String input) {
        if (input == null || input.indexOf('\0') < 0) {
            return input;
        }
        return input.replace("\0", "");
    }

    private record LineSlice(int start, int end, int lineNumber) {}

    private record RawChunk(String text, int startLine, int endLine) {}
}
