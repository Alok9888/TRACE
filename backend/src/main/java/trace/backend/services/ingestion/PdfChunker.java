package trace.backend.services.ingestion;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Pattern;

import org.springframework.ai.document.Document;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import trace.backend.entity.SourceType;
import trace.backend.services.ai.RagSettings;

/**
 * Semantic/recursive PDF chunker that strictly preserves 1-based page boundaries
 * and section heading provenance while keeping every chunk inside bge-small-en-v1.5's 512-token window.
 */
@Component
public class PdfChunker {

    private static final Pattern PARAGRAPH_SPLIT = Pattern.compile("\\n{2,}");
    private static final Pattern SENTENCE_SPLIT = Pattern.compile("(?<=[.!?])\\s+(?=[A-Z0-9(\"'])");

    private final int maxChunkChars;
    private final int overlapChars;

    public PdfChunker(@Value("${app.indexing.pdf-chunk-size:1500}") int chunkSize) {
        this.maxChunkChars = Math.max(300, chunkSize);
        this.overlapChars = Math.max(0, this.maxChunkChars / 9); // ~11% sentence-aligned overlap
    }

    public List<Document> chunkPages(
            UUID userId,
            String sourceId,
            String fileName,
            List<PdfTextExtractor.ExtractedPage> pages) {
        if (pages == null || pages.isEmpty()) {
            return List.of();
        }

        String sanitizedFileName = sanitize(fileName);
        String sanitizedSourceId = sanitize(sourceId);
        String userIdStr = userId.toString();

        List<Document> result = new ArrayList<>();
        int globalChunkIndex = 0;
        String activeSectionHeading = null;

        for (PdfTextExtractor.ExtractedPage page : pages) {
            if (page.text() == null || page.text().isBlank()) {
                continue;
            }
            if (page.primaryHeading() != null && !page.primaryHeading().isBlank()) {
                activeSectionHeading = sanitize(page.primaryHeading());
            }

            List<String> pagePieces = splitRecursively(sanitize(page.text()));
            String prevPiece = null;
            for (String piece : pagePieces) {
                if (piece.isBlank()) {
                    continue;
                }
                String body = piece;
                if (prevPiece != null && overlapChars > 0) {
                    String overlap = extractTailOverlap(prevPiece, overlapChars);
                    if (!overlap.isEmpty()) {
                        body = overlap + "\n" + piece;
                    }
                }
                prevPiece = piece;

                // Track heading updates within the page if the chunk opens with a clear heading line
                String chunkHeading = activeSectionHeading;
                String firstLine = firstNonEmptyLine(piece);
                if (firstLine != null && PdfTextExtractor.isLikelyHeading(firstLine)) {
                    chunkHeading = sanitize(firstLine);
                    activeSectionHeading = chunkHeading;
                }

                StringBuilder header = new StringBuilder();
                header.append("[Document: ").append(sanitizedFileName)
                        .append(" | Page ").append(page.pageNumber());
                if (chunkHeading != null && !chunkHeading.isBlank()) {
                    header.append(" | Section: ").append(chunkHeading);
                }
                header.append("]\n");

                Map<String, Object> metadata = new HashMap<>(10);
                metadata.put(RagSettings.METADATA_REPO_ID, sanitizedSourceId);
                metadata.put(RagSettings.METADATA_USER_ID, userIdStr);
                metadata.put(RagSettings.METADATA_SOURCE_TYPE, SourceType.PDF.name());
                metadata.put("filePath", sanitizedFileName);
                metadata.put("language", "pdf");
                metadata.put(RagSettings.METADATA_PAGE_NUMBER, page.pageNumber());
                metadata.put("chunkIndex", globalChunkIndex);
                if (chunkHeading != null && !chunkHeading.isBlank()) {
                    metadata.put(RagSettings.METADATA_SECTION_HEADING, chunkHeading);
                }

                result.add(new Document(header + body, metadata));
                globalChunkIndex++;
            }
        }

        return result;
    }

    private List<String> splitRecursively(String text) {
        if (text.length() <= maxChunkChars) {
            return List.of(text.trim());
        }

        String[] paragraphs = PARAGRAPH_SPLIT.split(text);
        List<String> chunks = new ArrayList<>();
        StringBuilder current = new StringBuilder(maxChunkChars + 64);

        for (String rawPara : paragraphs) {
            String para = rawPara.trim();
            if (para.isEmpty()) {
                continue;
            }
            if (para.length() > maxChunkChars) {
                flushBuffer(chunks, current);
                chunks.addAll(splitBySentencesOrWords(para));
                continue;
            }
            int projected = current.length() + (current.isEmpty() ? 0 : 2) + para.length();
            if (!current.isEmpty() && projected > maxChunkChars) {
                flushBuffer(chunks, current);
            }
            if (!current.isEmpty()) {
                current.append("\n\n");
            }
            current.append(para);
        }
        flushBuffer(chunks, current);
        return chunks;
    }

    private List<String> splitBySentencesOrWords(String paragraph) {
        String[] sentences = SENTENCE_SPLIT.split(paragraph);
        List<String> chunks = new ArrayList<>();
        StringBuilder current = new StringBuilder(maxChunkChars + 64);

        for (String rawSentence : sentences) {
            String sentence = rawSentence.trim();
            if (sentence.isEmpty()) {
                continue;
            }
            if (sentence.length() > maxChunkChars) {
                flushBuffer(chunks, current);
                chunks.addAll(hardSliceWords(sentence));
                continue;
            }
            int projected = current.length() + (current.isEmpty() ? 0 : 1) + sentence.length();
            if (!current.isEmpty() && projected > maxChunkChars) {
                flushBuffer(chunks, current);
            }
            if (!current.isEmpty()) {
                current.append(' ');
            }
            current.append(sentence);
        }
        flushBuffer(chunks, current);
        return chunks;
    }

    private List<String> hardSliceWords(String text) {
        List<String> slices = new ArrayList<>();
        int start = 0;
        int len = text.length();
        while (start < len) {
            int end = Math.min(len, start + maxChunkChars);
            if (end < len) {
                int space = text.lastIndexOf(' ', end);
                if (space > start + maxChunkChars / 2) {
                    end = space;
                }
            }
            String piece = text.substring(start, end).trim();
            if (!piece.isEmpty()) {
                slices.add(piece);
            }
            start = Math.max(end, start + 1);
            while (start < len && Character.isWhitespace(text.charAt(start))) {
                start++;
            }
        }
        return slices;
    }

    private static void flushBuffer(List<String> chunks, StringBuilder buf) {
        if (!buf.isEmpty()) {
            String text = buf.toString().trim();
            buf.setLength(0);
            if (!text.isEmpty()) {
                chunks.add(text);
            }
        }
    }

    private static String extractTailOverlap(String prev, int targetChars) {
        if (prev == null || prev.length() <= 40) {
            return "";
        }
        int start = Math.max(0, prev.length() - targetChars);
        // Snap forward to a sentence or word boundary so overlap reads cleanly
        int sentenceBreak = prev.indexOf(". ", start);
        if (sentenceBreak >= 0 && sentenceBreak + 2 < prev.length()) {
            start = sentenceBreak + 2;
        } else {
            int space = prev.indexOf(' ', start);
            if (space >= 0 && space + 1 < prev.length()) {
                start = space + 1;
            }
        }
        return prev.substring(start).trim();
    }

    private static String firstNonEmptyLine(String text) {
        int newline = text.indexOf('\n');
        String first = newline >= 0 ? text.substring(0, newline).trim() : text.trim();
        return first.isEmpty() ? null : first;
    }

    private static String sanitize(String input) {
        if (input == null || input.indexOf('\0') < 0) {
            return input;
        }
        return input.replace("\0", "");
    }
}
