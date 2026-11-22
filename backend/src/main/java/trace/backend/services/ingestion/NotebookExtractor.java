package trace.backend.services.ingestion;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import org.springframework.stereotype.Component;

import com.fasterxml.jackson.core.JsonFactory;
import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.core.JsonToken;

import trace.backend.entity.SourceType;
import trace.backend.exceptions.BadRequestException;

/**
 * Streaming Jupyter Notebook (.ipynb) extractor built on Jackson's token-level {@link JsonParser}.
 * Immediately skips cell {@code outputs}, {@code metadata}, and {@code attachments} via
 * {@link JsonParser#skipChildren()} so multi-megabyte base64 plot blobs never touch the -Xmx160m heap.
 * Pairs each Markdown narrative cell with the immediately following Code cell into a single
 * contextual {@link ExtractedSection}.
 */
@Component
public class NotebookExtractor implements DocumentExtractor {

    private static final JsonFactory JSON_FACTORY = new JsonFactory();
    private static final Pattern MD_HEADING_PATTERN = Pattern.compile("^#{1,6}\\s+(.+)$");
    private static final int MAX_CELL_TEXT_CHARS = 200_000;

    @Override
    public SourceType getSourceType() {
        return SourceType.NOTEBOOK;
    }

    @Override
    public boolean supports(String originalFilename, String contentType) {
        boolean hasExt = originalFilename != null
                && originalFilename.toLowerCase(Locale.ROOT).endsWith(".ipynb");
        boolean hasMime = contentType != null
                && contentType.toLowerCase(Locale.ROOT).contains("x-ipynb");
        return hasExt || hasMime;
    }

    @Override
    public List<ExtractedSection> extract(Path tempFile, String originalFilename) {
        try (InputStream in = Files.newInputStream(tempFile);
             JsonParser parser = JSON_FACTORY.createParser(in)) {
            return parseNotebook(parser);
        } catch (BadRequestException e) {
            throw e;
        } catch (IOException e) {
            throw new BadRequestException(
                    "Could not parse Jupyter Notebook (.ipynb). Ensure the file is valid notebook JSON.");
        }
    }

    private List<ExtractedSection> parseNotebook(JsonParser parser) throws IOException {
        if (parser.nextToken() != JsonToken.START_OBJECT) {
            throw new BadRequestException("Invalid Jupyter Notebook format: root JSON object expected.");
        }

        String kernelLanguage = "python";
        List<RawCell> rawCells = new ArrayList<>();

        while (parser.nextToken() != JsonToken.END_OBJECT) {
            String fieldName = parser.currentName();
            JsonToken valueToken = parser.nextToken();
            if (fieldName == null) {
                continue;
            }

            if ("metadata".equals(fieldName) && valueToken == JsonToken.START_OBJECT) {
                String detected = extractKernelLanguage(parser);
                if (detected != null && !detected.isBlank()) {
                    kernelLanguage = detected;
                }
            } else if ("cells".equals(fieldName) && valueToken == JsonToken.START_ARRAY) {
                parseCellsArray(parser, rawCells);
            } else {
                parser.skipChildren();
            }
        }

        if (rawCells.isEmpty()) {
            throw new BadRequestException(
                    "This Jupyter Notebook contains no non-empty Markdown or code cells to index.");
        }

        return pairCellsContextually(rawCells, kernelLanguage);
    }

    private static String extractKernelLanguage(JsonParser parser) throws IOException {
        String lang = null;
        while (parser.nextToken() != JsonToken.END_OBJECT) {
            String field = parser.currentName();
            JsonToken token = parser.nextToken();
            if (("kernelspec".equals(field) || "language_info".equals(field)) && token == JsonToken.START_OBJECT) {
                while (parser.nextToken() != JsonToken.END_OBJECT) {
                    String sub = parser.currentName();
                    JsonToken subVal = parser.nextToken();
                    if (("language".equals(sub) || ("language_info".equals(field) && "name".equals(sub)))
                            && subVal == JsonToken.VALUE_STRING) {
                        String candidate = parser.getText().trim().toLowerCase(Locale.ROOT);
                        if (!candidate.isEmpty()) {
                            lang = sanitizeFenceLang(candidate);
                        }
                    } else {
                        parser.skipChildren();
                    }
                }
            } else {
                parser.skipChildren();
            }
        }
        return lang;
    }

    private static void parseCellsArray(JsonParser parser, List<RawCell> outCells) throws IOException {
        int cellIndex = 0;
        while (parser.nextToken() != JsonToken.END_ARRAY) {
            if (parser.currentToken() != JsonToken.START_OBJECT) {
                parser.skipChildren();
                continue;
            }
            cellIndex++;
            String cellType = null;
            String source = null;

            while (parser.nextToken() != JsonToken.END_OBJECT) {
                String field = parser.currentName();
                JsonToken valToken = parser.nextToken();
                if ("cell_type".equals(field) && valToken == JsonToken.VALUE_STRING) {
                    cellType = parser.getText().trim().toLowerCase(Locale.ROOT);
                } else if ("source".equals(field)) {
                    source = readSourceField(parser, valToken);
                } else {
                    // Crucial for -Xmx160m: skip `outputs`, `metadata`, `attachments` (base64 plots/HTML) immediately
                    parser.skipChildren();
                }
            }

            if (source == null || source.isBlank()) {
                continue;
            }
            if ("markdown".equals(cellType) || "code".equals(cellType)) {
                outCells.add(new RawCell(cellIndex, cellType, normalizeLineEndings(source).trim()));
            }
        }
    }

    private static String readSourceField(JsonParser parser, JsonToken valToken) throws IOException {
        if (valToken == JsonToken.VALUE_STRING) {
            String text = parser.getText();
            return text.length() > MAX_CELL_TEXT_CHARS ? text.substring(0, MAX_CELL_TEXT_CHARS) : text;
        }
        if (valToken == JsonToken.START_ARRAY) {
            StringBuilder sb = new StringBuilder(256);
            while (parser.nextToken() != JsonToken.END_ARRAY) {
                if (parser.currentToken() == JsonToken.VALUE_STRING && sb.length() < MAX_CELL_TEXT_CHARS) {
                    String piece = parser.getText();
                    int remaining = MAX_CELL_TEXT_CHARS - sb.length();
                    sb.append(piece.length() <= remaining ? piece : piece.substring(0, remaining));
                } else if (parser.currentToken().isStructStart()) {
                    parser.skipChildren();
                }
            }
            return sb.toString();
        }
        if (valToken != null && valToken.isStructStart()) {
            parser.skipChildren();
        }
        return "";
    }

    private static List<ExtractedSection> pairCellsContextually(List<RawCell> cells, String kernelLang) {
        List<ExtractedSection> sections = new ArrayList<>(cells.size());
        String activeHeading = null;

        int i = 0;
        while (i < cells.size()) {
            RawCell current = cells.get(i);

            if ("markdown".equals(current.type())) {
                String detectedHeading = extractLatestMarkdownHeading(current.text());
                if (detectedHeading != null) {
                    activeHeading = detectedHeading;
                }

                // Pair markdown narrative with immediately following code cell so explanation stays bound to code
                if (i + 1 < cells.size() && "code".equals(cells.get(i + 1).type())) {
                    RawCell codeCell = cells.get(i + 1);
                    String combined = current.text()
                            + "\n\n```" + kernelLang + "\n"
                            + codeCell.text()
                            + "\n```";
                    sections.add(new ExtractedSection(activeHeading, codeCell.cellNumber(), combined));
                    i += 2;
                    continue;
                }

                sections.add(new ExtractedSection(activeHeading, current.cellNumber(), current.text()));
                i++;
            } else {
                // Standalone code cell
                String fenced = "```" + kernelLang + "\n" + current.text() + "\n```";
                sections.add(new ExtractedSection(activeHeading, current.cellNumber(), fenced));
                i++;
            }
        }

        return sections;
    }

    private static String extractLatestMarkdownHeading(String markdown) {
        String latest = null;
        for (String line : markdown.split("\n")) {
            Matcher m = MD_HEADING_PATTERN.matcher(line.trim());
            if (m.matches()) {
                String h = m.group(1).replaceAll("\\s*#+\\s*$", "").trim();
                if (!h.isEmpty()) {
                    latest = h.length() > 96 ? h.substring(0, 96).trim() : h;
                }
            }
        }
        return latest;
    }

    private static String sanitizeFenceLang(String raw) {
        String cleaned = raw.replaceAll("[^a-z0-9_+#-]", "");
        return cleaned.isEmpty() ? "python" : cleaned;
    }

    private static String normalizeLineEndings(String text) {
        String noNull = text.indexOf('\0') >= 0 ? text.replace("\0", "") : text;
        return noNull.replace("\r\n", "\n").replace('\r', '\n');
    }

    private record RawCell(int cellNumber, String type, String text) {}
}
