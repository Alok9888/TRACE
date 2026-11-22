package trace.backend.services.ingestion;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Pattern;

import org.springframework.ai.document.Document;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import trace.backend.entity.SourceType;
import trace.backend.services.ai.RagSettings;

/**
 * Format-aware semantic/recursive chunker supporting PDF, EPUB, Jupyter Notebook, and IaC documents.
 * Splits each {@link ExtractedSection} recursively (\n\n -> \n -> sentences -> words) up to ~1,500 chars
 * (~375 tokens, safely within bge-small-en-v1.5's 512-token cap) with ~11% overlap, never crossing
 * section boundaries so unit citations (Page, Chapter, Cell, Line/Block) remain exact.
 */
@Component
public class SemanticChunker {

    private static final Pattern PARAGRAPH_SPLIT = Pattern.compile("\\n{2,}");
    private static final Pattern SENTENCE_SPLIT = Pattern.compile("(?<=[.!?])\\s+(?=[A-Z0-9(\"'])");

    private final int maxChunkChars;
    private final int overlapChars;

    public SemanticChunker(@Value("${app.indexing.semantic-chunk-size:1500}") int chunkSize) {
        this.maxChunkChars = Math.max(300, chunkSize);
        this.overlapChars = Math.max(0, this.maxChunkChars / 9); // ~11% overlap
    }

    public List<Document> chunkSections(
            UUID userId,
            String sourceId,
            SourceType sourceType,
            String fileName,
            List<ExtractedSection> sections) {
        if (sections == null || sections.isEmpty()) {
            return List.of();
        }

        SourceType effectiveType = sourceType != null ? sourceType : SourceType.PDF;
        String sanitizedFileName = sanitize(fileName);
        String sanitizedSourceId = sanitize(sourceId);
        String userIdStr = userId.toString();
        String languageTag = languageTagFor(effectiveType, sanitizedFileName);

        List<Document> result = new ArrayList<>();
        int globalChunkIndex = 0;

        for (ExtractedSection section : sections) {
            if (section == null || section.content() == null || section.content().isBlank()) {
                continue;
            }
            String cleanContent = sanitize(section.content()).trim();
            if (cleanContent.isEmpty()) {
                continue;
            }

            String heading = section.sectionHeading() != null && !section.sectionHeading().isBlank()
                    ? sanitize(section.sectionHeading()).trim()
                    : null;
            int unitNumber = Math.max(1, section.unitNumber());

            List<String> pieces = splitRecursively(cleanContent);
            String prevPiece = null;

            for (String piece : pieces) {
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

                String header = buildHeader(effectiveType, sanitizedFileName, unitNumber, heading);

                Map<String, Object> metadata = new HashMap<>(10);
                metadata.put(RagSettings.METADATA_REPO_ID, sanitizedSourceId);
                metadata.put(RagSettings.METADATA_USER_ID, userIdStr);
                metadata.put(RagSettings.METADATA_SOURCE_TYPE, effectiveType.name());
                metadata.put("filePath", sanitizedFileName);
                metadata.put("language", languageTag);
                metadata.put(RagSettings.METADATA_PAGE_NUMBER, unitNumber);
                metadata.put("chunkIndex", globalChunkIndex);
                if (effectiveType == SourceType.IAC) {
                    metadata.put("startLine", unitNumber);
                }
                if (heading != null && !heading.isBlank()) {
                    metadata.put(RagSettings.METADATA_SECTION_HEADING, heading);
                }

                result.add(new Document(header + body, metadata));
                globalChunkIndex++;
            }
        }

        return result;
    }

    static String buildHeader(SourceType sourceType, String fileName, int unitNumber, String heading) {
        StringBuilder sb = new StringBuilder(96);
        switch (sourceType) {
            case EPUB -> {
                sb.append("[Book: ").append(fileName).append(" | Chapter ").append(unitNumber);
                if (heading != null && !heading.isBlank()) {
                    sb.append(" | Section: ").append(heading);
                }
            }
            case NOTEBOOK -> {
                sb.append("[Notebook: ").append(fileName).append(" | Cell ").append(unitNumber);
                if (heading != null && !heading.isBlank()) {
                    sb.append(" | Section: ").append(heading);
                }
            }
            case IAC -> {
                sb.append("[Config: ").append(fileName).append(" | Line ").append(unitNumber);
                if (heading != null && !heading.isBlank()) {
                    sb.append(" | Block: ").append(heading);
                }
            }
            default -> {
                sb.append("[Document: ").append(fileName).append(" | Page ").append(unitNumber);
                if (heading != null && !heading.isBlank()) {
                    sb.append(" | Section: ").append(heading);
                }
            }
        }
        sb.append("]\n");
        return sb.toString();
    }

    private static String languageTagFor(SourceType sourceType, String fileName) {
        return switch (sourceType) {
            case PDF -> "pdf";
            case EPUB -> "epub";
            case NOTEBOOK -> "ipynb";
            case IAC -> {
                String lower = fileName != null ? fileName.toLowerCase(Locale.ROOT) : "";
                if (lower.endsWith(".tf")) yield "hcl";
                if (lower.contains("dockerfile")) yield "dockerfile";
                if (lower.endsWith(".yml") || lower.endsWith(".yaml")) yield "yaml";
                yield "iac";
            }
            default -> "text";
        };
    }

    private List<String> splitRecursively(String text) {
        if (text.length() <= maxChunkChars) {
            return List.of(text);
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
                chunks.addAll(splitByLines(para));
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

    private List<String> splitByLines(String block) {
        String[] lines = block.split("\n");
        if (lines.length <= 1) {
            return splitBySentencesOrWords(block);
        }
        List<String> chunks = new ArrayList<>();
        StringBuilder current = new StringBuilder(maxChunkChars + 64);

        for (String line : lines) {
            if (line.length() > maxChunkChars) {
                flushBuffer(chunks, current);
                chunks.addAll(splitBySentencesOrWords(line));
                continue;
            }
            int projected = current.length() + (current.isEmpty() ? 0 : 1) + line.length();
            if (!current.isEmpty() && projected > maxChunkChars) {
                flushBuffer(chunks, current);
            }
            if (!current.isEmpty()) {
                current.append('\n');
            }
            current.append(line);
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
        int nl = prev.indexOf('\n', start);
        if (nl >= 0 && nl + 1 < prev.length()) {
            start = nl + 1;
        } else {
            int sentenceBreak = prev.indexOf(". ", start);
            if (sentenceBreak >= 0 && sentenceBreak + 2 < prev.length()) {
                start = sentenceBreak + 2;
            } else {
                int space = prev.indexOf(' ', start);
                if (space >= 0 && space + 1 < prev.length()) {
                    start = space + 1;
                }
            }
        }
        return prev.substring(start).trim();
    }

    private static String sanitize(String input) {
        if (input == null || input.indexOf('\0') < 0) {
            return input;
        }
        return input.replace("\0", "");
    }
}
