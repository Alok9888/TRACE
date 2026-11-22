package trace.backend.services.ingestion;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.StringReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import org.springframework.stereotype.Component;

import trace.backend.entity.SourceType;
import trace.backend.exceptions.BadRequestException;

/**
 * Streaming Infrastructure-as-Code & CI/CD extractor supporting:
 * - Terraform (.tf): top-level HCL blocks tracked via brace depth
 * - Dockerfile (Dockerfile, *.dockerfile): build stages grouped by FROM ... [AS <stage>]
 * - Docker Compose & GitHub Actions YAML (.yml/.yaml): top-level services.<name> & jobs.<name> blocks
 */
@Component
public class IacExtractor implements DocumentExtractor {

    private static final Pattern HCL_TOP_BLOCK = Pattern.compile(
            "^(resource|data|module|variable|output|locals|provider|terraform)\\b(.*)$");
    private static final Pattern DOCKER_FROM = Pattern.compile(
            "^FROM\\s+([^\\s]+)(?:\\s+AS\\s+([^\\s#]+))?.*$",
            Pattern.CASE_INSENSITIVE);
    private static final Pattern YAML_KEY = Pattern.compile("^(\\s*)([A-Za-z0-9_.-]+)\\s*:(.*)$");

    @Override
    public SourceType getSourceType() {
        return SourceType.IAC;
    }

    @Override
    public boolean supports(String originalFilename, String contentType) {
        return isIacFilename(originalFilename);
    }

    public boolean isIacPath(String path) {
        if (path == null || path.isBlank()) {
            return false;
        }
        String normalized = path.replace('\\', '/').toLowerCase(Locale.ROOT);
        String base = normalized.substring(normalized.lastIndexOf('/') + 1);
        if (base.endsWith(".tf") || "dockerfile".equals(base) || base.endsWith(".dockerfile")) {
            return true;
        }
        if (base.equals("docker-compose.yml")
                || base.equals("docker-compose.yaml")
                || base.equals("compose.yml")
                || base.equals("compose.yaml")) {
            return true;
        }
        return normalized.contains("/.github/workflows/")
                && (base.endsWith(".yml") || base.endsWith(".yaml"));
    }

    public static boolean isIacFilename(String originalFilename) {
        if (originalFilename == null || originalFilename.isBlank()) {
            return false;
        }
        String normalized = originalFilename.replace('\\', '/');
        String base = normalized.substring(normalized.lastIndexOf('/') + 1).toLowerCase(Locale.ROOT);
        return base.endsWith(".tf")
                || "dockerfile".equals(base)
                || base.endsWith(".dockerfile")
                || base.startsWith("dockerfile.")
                || base.endsWith(".yml")
                || base.endsWith(".yaml");
    }

    @Override
    public List<ExtractedSection> extract(Path tempFile, String originalFilename) {
        try (BufferedReader reader = Files.newBufferedReader(tempFile, StandardCharsets.UTF_8)) {
            List<ExtractedSection> sections = extractFromReader(reader, originalFilename);
            if (sections.isEmpty()) {
                throw new BadRequestException(
                        "No indexable infrastructure blocks were found in " + originalFilename + ".");
            }
            return sections;
        } catch (BadRequestException e) {
            throw e;
        } catch (IOException e) {
            throw new BadRequestException("Could not read infrastructure configuration file.");
        }
    }

    public List<ExtractedSection> extractFromString(String content, String filename) {
        if (content == null || content.isBlank()) {
            return List.of();
        }
        try (BufferedReader reader = new BufferedReader(new StringReader(content))) {
            return extractFromReader(reader, filename);
        } catch (IOException e) {
            return List.of();
        }
    }

    public List<ExtractedSection> extractFromReader(BufferedReader reader, String filename) throws IOException {
        String lower = filename == null ? "" : filename.replace('\\', '/').toLowerCase(Locale.ROOT);
        String base = lower.substring(lower.lastIndexOf('/') + 1);

        if (base.endsWith(".tf")) {
            return extractTerraform(reader);
        }
        if ("dockerfile".equals(base) || base.endsWith(".dockerfile") || base.startsWith("dockerfile.")) {
            return extractDockerfile(reader);
        }
        if (base.endsWith(".yml") || base.endsWith(".yaml")) {
            return extractYamlWorkflowOrCompose(reader, base);
        }
        return extractFallbackText(reader, base);
    }

    private List<ExtractedSection> extractTerraform(BufferedReader reader) throws IOException {
        List<ExtractedSection> sections = new ArrayList<>();
        StringBuilder currentBlock = new StringBuilder(512);
        StringBuilder pendingComments = new StringBuilder(128);
        String currentHeading = null;
        int currentStartLine = 1;
        int braceDepth = 0;
        int lineNum = 0;

        String rawLine;
        while ((rawLine = reader.readLine()) != null) {
            lineNum++;
            String line = stripNulls(rawLine);
            String trimmed = line.trim();

            if (braceDepth == 0) {
                if (trimmed.isEmpty()) {
                    if (!currentBlock.isEmpty()) {
                        flushSection(sections, currentHeading, currentStartLine, currentBlock);
                        currentHeading = null;
                    }
                    continue;
                }
                if (trimmed.startsWith("#") || trimmed.startsWith("//")) {
                    if (pendingComments.isEmpty()) {
                        currentStartLine = lineNum;
                    }
                    pendingComments.append(line).append('\n');
                    continue;
                }

                Matcher m = HCL_TOP_BLOCK.matcher(trimmed);
                if (m.matches()) {
                    if (!currentBlock.isEmpty()) {
                        flushSection(sections, currentHeading, currentStartLine, currentBlock);
                    }
                    if (!pendingComments.isEmpty()) {
                        currentBlock.append(pendingComments);
                        pendingComments.setLength(0);
                    } else {
                        currentStartLine = lineNum;
                    }
                    currentHeading = extractHclSignature(trimmed);
                    currentBlock.append(line).append('\n');
                    braceDepth = Math.max(0, braceDepth + netBraceDelta(line));
                    if (braceDepth == 0 && trimmed.endsWith("}")) {
                        flushSection(sections, currentHeading, currentStartLine, currentBlock);
                        currentHeading = null;
                    }
                } else {
                    if (currentBlock.isEmpty()) {
                        currentStartLine = lineNum;
                        currentHeading = "terraform";
                    }
                    if (!pendingComments.isEmpty()) {
                        currentBlock.append(pendingComments);
                        pendingComments.setLength(0);
                    }
                    currentBlock.append(line).append('\n');
                    braceDepth = Math.max(0, braceDepth + netBraceDelta(line));
                }
            } else {
                currentBlock.append(line).append('\n');
                braceDepth = Math.max(0, braceDepth + netBraceDelta(line));
                if (braceDepth == 0) {
                    flushSection(sections, currentHeading, currentStartLine, currentBlock);
                    currentHeading = null;
                }
            }
        }

        if (!currentBlock.isEmpty()) {
            flushSection(sections, currentHeading, currentStartLine, currentBlock);
        }
        return sections;
    }

    private static String extractHclSignature(String trimmedLine) {
        int brace = trimmedLine.indexOf('{');
        String sig = brace >= 0 ? trimmedLine.substring(0, brace).trim() : trimmedLine;
        return sig.length() > 110 ? sig.substring(0, 110).trim() : sig;
    }

    private static int netBraceDelta(String line) {
        int delta = 0;
        boolean inDoubleQuote = false;
        boolean escaped = false;
        int len = line.length();
        for (int i = 0; i < len; i++) {
            char c = line.charAt(i);
            if (escaped) {
                escaped = false;
                continue;
            }
            if (c == '\\' && inDoubleQuote) {
                escaped = true;
                continue;
            }
            if (c == '"') {
                inDoubleQuote = !inDoubleQuote;
                continue;
            }
            if (!inDoubleQuote) {
                if (c == '#') {
                    break;
                }
                if (c == '/' && i + 1 < len && line.charAt(i + 1) == '/') {
                    break;
                }
                if (c == '{') {
                    delta++;
                } else if (c == '}') {
                    delta--;
                }
            }
        }
        return delta;
    }

    private List<ExtractedSection> extractDockerfile(BufferedReader reader) throws IOException {
        List<ExtractedSection> sections = new ArrayList<>();
        StringBuilder current = new StringBuilder(512);
        String currentStage = "Stage: preamble";
        int startLine = 1;
        int stageCounter = 0;
        int lineNum = 0;

        String rawLine;
        while ((rawLine = reader.readLine()) != null) {
            lineNum++;
            String line = stripNulls(rawLine);
            String trimmed = line.trim();

            Matcher fromMatcher = DOCKER_FROM.matcher(trimmed);
            if (fromMatcher.matches()) {
                if (!current.isEmpty() && !current.toString().isBlank()) {
                    flushSection(sections, currentStage, startLine, current);
                }
                stageCounter++;
                String baseImage = fromMatcher.group(1);
                String alias = fromMatcher.group(2);
                currentStage = alias != null && !alias.isBlank()
                        ? "Stage: " + alias
                        : "Stage " + stageCounter + ": " + baseImage;
                startLine = lineNum;
            } else if (current.isEmpty() && !trimmed.isEmpty()) {
                startLine = lineNum;
            }

            if (!current.isEmpty() || !trimmed.isEmpty()) {
                current.append(line).append('\n');
            }
        }

        if (!current.isEmpty()) {
            flushSection(sections, currentStage, startLine, current);
        }
        return sections;
    }

    private List<ExtractedSection> extractYamlWorkflowOrCompose(BufferedReader reader, String filename)
            throws IOException {
        List<ExtractedSection> sections = new ArrayList<>();
        StringBuilder preamble = new StringBuilder(256);
        int preambleStart = -1;

        String activeContainer = null; // "services" or "jobs"
        int containerChildIndent = -1;
        String activeItemHeading = null;
        int activeItemStartLine = 1;
        StringBuilder activeItemBody = new StringBuilder(512);

        int lineNum = 0;
        String rawLine;
        while ((rawLine = reader.readLine()) != null) {
            lineNum++;
            String line = stripNulls(rawLine);
            String trimmed = line.trim();

            if (trimmed.isEmpty() || trimmed.startsWith("#")) {
                if (activeItemHeading != null) {
                    activeItemBody.append(line).append('\n');
                } else if (!trimmed.isEmpty()) {
                    if (preambleStart < 0) preambleStart = lineNum;
                    preamble.append(line).append('\n');
                }
                continue;
            }

            int indent = leadingSpaces(line);
            Matcher keyMatcher = YAML_KEY.matcher(line);

            if (indent == 0 && keyMatcher.matches()) {
                // Flush any open service/job block when returning to root level
                if (activeItemHeading != null) {
                    flushSection(sections, activeItemHeading, activeItemStartLine, activeItemBody);
                    activeItemHeading = null;
                    containerChildIndent = -1;
                }
                String topKey = keyMatcher.group(2);
                if ("services".equals(topKey) || "jobs".equals(topKey)) {
                    activeContainer = topKey;
                    containerChildIndent = -1;
                    continue;
                } else {
                    activeContainer = null;
                    if (preambleStart < 0) preambleStart = lineNum;
                    preamble.append(line).append('\n');
                    continue;
                }
            }

            if (activeContainer != null) {
                if (keyMatcher.matches() && (containerChildIndent < 0 || indent == containerChildIndent)) {
                    if (activeItemHeading != null) {
                        flushSection(sections, activeItemHeading, activeItemStartLine, activeItemBody);
                    }
                    containerChildIndent = indent;
                    String childName = keyMatcher.group(2);
                    String prefix = "services".equals(activeContainer) ? "service: " : "job: ";
                    activeItemHeading = prefix + childName;
                    activeItemStartLine = lineNum;
                    activeItemBody.append(activeContainer).append(":\n").append(line).append('\n');
                } else if (activeItemHeading != null) {
                    activeItemBody.append(line).append('\n');
                }
            } else {
                if (preambleStart < 0) preambleStart = lineNum;
                preamble.append(line).append('\n');
            }
        }

        if (activeItemHeading != null) {
            flushSection(sections, activeItemHeading, activeItemStartLine, activeItemBody);
        }

        if (!preamble.isEmpty() && !preamble.toString().isBlank()) {
            // Put header/triggers/metadata first so workflow triggers (`on:`) & compose globals are retrievable
            sections.add(0, new ExtractedSection("config: " + filename, Math.max(1, preambleStart), preamble.toString().trim()));
        }

        return sections;
    }

    private List<ExtractedSection> extractFallbackText(BufferedReader reader, String filename) throws IOException {
        StringBuilder sb = new StringBuilder(1024);
        String line;
        while ((line = reader.readLine()) != null) {
            sb.append(stripNulls(line)).append('\n');
        }
        String text = sb.toString().trim();
        if (text.isEmpty()) {
            return List.of();
        }
        return List.of(new ExtractedSection(filename, 1, text));
    }

    private static void flushSection(
            List<ExtractedSection> sections, String heading, int startLine, StringBuilder buf) {
        String content = buf.toString().trim();
        buf.setLength(0);
        if (!content.isEmpty()) {
            sections.add(new ExtractedSection(heading, Math.max(1, startLine), content));
        }
    }

    private static int leadingSpaces(String line) {
        int count = 0;
        for (int i = 0; i < line.length(); i++) {
            char c = line.charAt(i);
            if (c == ' ') count++;
            else if (c == '\t') count += 2;
            else break;
        }
        return count;
    }

    private static String stripNulls(String s) {
        return s.indexOf('\0') >= 0 ? s.replace("\0", "") : s;
    }
}
