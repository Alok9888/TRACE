package trace.backend.services.ingestion;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

import org.jsoup.Jsoup;
import org.jsoup.nodes.Document;
import org.jsoup.nodes.Element;
import org.jsoup.nodes.Node;
import org.jsoup.nodes.TextNode;
import org.jsoup.parser.Parser;
import org.springframework.stereotype.Component;

import trace.backend.entity.SourceType;
import trace.backend.exceptions.BadRequestException;

/**
 * Memory-safe EPUB technical book & specification extractor.
 * Opens the temp file with {@link ZipFile} (random-access disk reads, zero archive buffering),
 * detects DRM encryption via {@code META-INF/encryption.xml}, follows {@code container.xml} ->
 * {@code .opf} manifest + spine linear reading order, and streams each XHTML chapter through Jsoup
 * while preserving {@code <pre>}/{@code <code>} blocks and paragraph boundaries.
 */
@Component
public class EpubExtractor implements DocumentExtractor {

    public static final int MAX_CHAPTERS = 350;
    private static final int MIN_EXTRACTABLE_ALNUM = 40;
    private static final Pattern MULTI_NEWLINES = Pattern.compile("\\n{3,}");
    private static final Pattern HORIZONTAL_SPACE = Pattern.compile("[ \\t\\x0B\\f\\u00A0]+");
    private static final Set<String> FONT_EXTENSIONS = Set.of(".otf", ".ttf", ".woff", ".woff2");

    @Override
    public SourceType getSourceType() {
        return SourceType.EPUB;
    }

    @Override
    public boolean supports(String originalFilename, String contentType) {
        boolean hasExt = originalFilename != null
                && originalFilename.toLowerCase(Locale.ROOT).endsWith(".epub");
        boolean hasMime = contentType != null
                && contentType.toLowerCase(Locale.ROOT).contains("epub");
        return hasExt || hasMime;
    }

    @Override
    public List<ExtractedSection> extract(Path tempFile, String originalFilename) {
        try (ZipFile zipFile = new ZipFile(tempFile.toFile(), StandardCharsets.UTF_8)) {
            rejectIfDrmEncrypted(zipFile);
            String opfPath = resolveOpfPath(zipFile);
            List<String> spinePaths = resolveSpineChapterPaths(zipFile, opfPath);

            if (spinePaths.isEmpty()) {
                throw new BadRequestException("No readable chapters were found in this EPUB archive.");
            }
            if (spinePaths.size() > MAX_CHAPTERS) {
                throw new BadRequestException(
                        "EPUB exceeds the maximum supported limit of " + MAX_CHAPTERS + " spine items.");
            }

            List<ExtractedSection> chapters = new ArrayList<>();
            int chapterNum = 0;
            int totalAlnum = 0;

            for (String chapterPath : spinePaths) {
                ZipEntry entry = findZipEntry(zipFile, chapterPath);
                if (entry == null || entry.isDirectory()) {
                    continue;
                }

                try (InputStream chapterStream = zipFile.getInputStream(entry)) {
                    Document doc = Jsoup.parse(chapterStream, StandardCharsets.UTF_8.name(), "");
                    String heading = extractChapterHeading(doc);
                    String bodyText = extractStructuredBody(doc);
                    int alnum = countAlphanumeric(bodyText);
                    if (alnum < 15) {
                        continue; // Skip cover-image-only or blank spacer XHTML files
                    }
                    chapterNum++;
                    totalAlnum += alnum;
                    String effectiveHeading = heading != null && !heading.isBlank()
                            ? heading
                            : "Chapter " + chapterNum;
                    chapters.add(new ExtractedSection(effectiveHeading, chapterNum, bodyText));
                }
            }

            if (chapters.isEmpty() || totalAlnum < MIN_EXTRACTABLE_ALNUM) {
                throw new BadRequestException(
                        "No extractable text found in this EPUB. It may contain only images or unsupported content.");
            }

            return chapters;
        } catch (BadRequestException e) {
            throw e;
        } catch (IOException e) {
            throw new BadRequestException("Could not read EPUB file. Ensure it is a valid, uncorrupted EPUB archive.");
        }
    }

    private static void rejectIfDrmEncrypted(ZipFile zipFile) throws IOException {
        ZipEntry encEntry = findZipEntry(zipFile, "META-INF/encryption.xml");
        if (encEntry == null) {
            return;
        }
        try (InputStream in = zipFile.getInputStream(encEntry)) {
            Document doc = Jsoup.parse(in, StandardCharsets.UTF_8.name(), "", Parser.xmlParser());
            var encryptedNodes = doc.select("EncryptedData");
            if (encryptedNodes.isEmpty()) {
                return;
            }
            // Allow standard EPUB font obfuscation (IDPF/Adobe) on .otf/.ttf/.woff files, reject encrypted content streams
            for (Element enc : encryptedNodes) {
                Element cipherRef = enc.selectFirst("CipherReference");
                String uri = cipherRef != null ? cipherRef.attr("URI").toLowerCase(Locale.ROOT) : "";
                boolean isFontOnly = FONT_EXTENSIONS.stream().anyMatch(uri::endsWith);
                if (!isFontOnly) {
                    throw new BadRequestException(
                            "This EPUB is DRM-encrypted and cannot be indexed. Please upload a DRM-free EPUB.");
                }
            }
        }
    }

    private static String resolveOpfPath(ZipFile zipFile) throws IOException {
        ZipEntry container = findZipEntry(zipFile, "META-INF/container.xml");
        if (container == null) {
            throw new BadRequestException("Invalid EPUB archive: missing META-INF/container.xml.");
        }
        try (InputStream in = zipFile.getInputStream(container)) {
            Document doc = Jsoup.parse(in, StandardCharsets.UTF_8.name(), "", Parser.xmlParser());
            Element rootfile = doc.selectFirst("rootfile[full-path]");
            if (rootfile == null || rootfile.attr("full-path").isBlank()) {
                throw new BadRequestException("Invalid EPUB archive: container.xml does not specify an OPF package.");
            }
            return normalizeZipPath(rootfile.attr("full-path"));
        }
    }

    private static List<String> resolveSpineChapterPaths(ZipFile zipFile, String opfPath) throws IOException {
        ZipEntry opfEntry = findZipEntry(zipFile, opfPath);
        if (opfEntry == null) {
            throw new BadRequestException("Invalid EPUB archive: missing OPF package at " + opfPath);
        }
        String opfDir = "";
        int lastSlash = opfPath.lastIndexOf('/');
        if (lastSlash >= 0) {
            opfDir = opfPath.substring(0, lastSlash + 1);
        }

        Map<String, ManifestItem> manifest = new HashMap<>();
        List<String> spinePaths = new ArrayList<>();
        Set<String> seen = new HashSet<>();

        try (InputStream in = zipFile.getInputStream(opfEntry)) {
            Document doc = Jsoup.parse(in, StandardCharsets.UTF_8.name(), "", Parser.xmlParser());
            for (Element item : doc.select("manifest > item")) {
                String id = item.attr("id");
                String href = item.attr("href");
                String mediaType = item.attr("media-type").toLowerCase(Locale.ROOT);
                String props = item.attr("properties").toLowerCase(Locale.ROOT);
                if (!id.isBlank() && !href.isBlank()) {
                    manifest.put(id, new ManifestItem(href, mediaType, props));
                }
            }

            for (Element itemref : doc.select("spine > itemref")) {
                if ("no".equalsIgnoreCase(itemref.attr("linear"))) {
                    continue;
                }
                String idref = itemref.attr("idref");
                ManifestItem item = manifest.get(idref);
                if (item == null || !isReadableChapter(item)) {
                    continue;
                }
                String resolved = resolveRelativePath(opfDir, item.href());
                if (seen.add(resolved)) {
                    spinePaths.add(resolved);
                }
            }
        }
        return spinePaths;
    }

    private static boolean isReadableChapter(ManifestItem item) {
        if (item.properties().contains("nav")) {
            return false; // Skip EPUB 3 navigation boilerplate
        }
        String mt = item.mediaType();
        if (mt.contains("xhtml") || mt.contains("html")) {
            return true;
        }
        String lowerHref = item.href().toLowerCase(Locale.ROOT);
        return lowerHref.endsWith(".xhtml") || lowerHref.endsWith(".html") || lowerHref.endsWith(".htm");
    }

    private static String extractChapterHeading(Document doc) {
        for (String selector : new String[] { "h1", "h2", "title" }) {
            Element el = doc.selectFirst(selector);
            if (el != null) {
                String text = collapseInline(el.text());
                if (!text.isEmpty() && !text.equalsIgnoreCase("untitled")) {
                    return text.length() > 96 ? text.substring(0, 96).trim() : text;
                }
            }
        }
        return null;
    }

    private static String extractStructuredBody(Document doc) {
        Element body = doc.body();
        if (body == null) {
            return "";
        }
        body.select("script, style, nav, svg, img, figure figcaption:empty").remove();

        StringBuilder out = new StringBuilder(2048);
        renderNode(body, out, false);
        String cleaned = out.toString()
                .replace("\0", "")
                .replace("\r\n", "\n")
                .replace('\r', '\n');
        return MULTI_NEWLINES.matcher(cleaned.trim()).replaceAll("\n\n");
    }

    private static void renderNode(Node node, StringBuilder out, boolean insidePre) {
        if (node instanceof TextNode tn) {
            if (insidePre) {
                out.append(tn.getWholeText());
            } else {
                String text = HORIZONTAL_SPACE.matcher(tn.getWholeText().replace('\n', ' ')).replaceAll(" ");
                if (!text.isBlank() || (!out.isEmpty() && out.charAt(out.length() - 1) != '\n' && out.charAt(out.length() - 1) != ' ')) {
                    out.append(text);
                }
            }
            return;
        }
        if (!(node instanceof Element el)) {
            return;
        }

        String tag = el.tagName().toLowerCase(Locale.ROOT);
        if ("pre".equals(tag)) {
            String code = el.wholeText().replace("\r\n", "\n").replace('\r', '\n').trim();
            if (!code.isEmpty()) {
                ensureBlankLine(out);
                out.append("```\n").append(code).append("\n```\n\n");
            }
            return;
        }
        if ("code".equals(tag) && !insidePre) {
            String inlineCode = collapseInline(el.text());
            if (!inlineCode.isEmpty()) {
                out.append('`').append(inlineCode).append('`');
            }
            return;
        }
        if ("br".equals(tag)) {
            out.append('\n');
            return;
        }

        boolean isBlock = switch (tag) {
            case "p", "div", "section", "article", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6",
                 "li", "tr", "dt", "dd", "ul", "ol", "table", "header" -> true;
            default -> false;
        };

        if (isBlock) {
            ensureBlankLine(out);
            if ("li".equals(tag)) {
                out.append("- ");
            }
        }

        for (Node child : el.childNodes()) {
            renderNode(child, out, insidePre);
        }

        if (isBlock) {
            ensureBlankLine(out);
        }
    }

    private static void ensureBlankLine(StringBuilder out) {
        int len = out.length();
        if (len == 0) return;
        if (len >= 2 && out.charAt(len - 1) == '\n' && out.charAt(len - 2) == '\n') return;
        if (out.charAt(len - 1) == '\n') {
            out.append('\n');
        } else {
            out.append("\n\n");
        }
    }

    private static ZipEntry findZipEntry(ZipFile zipFile, String path) {
        String normalized = normalizeZipPath(path);
        ZipEntry exact = zipFile.getEntry(normalized);
        if (exact != null) {
            return exact;
        }
        // Handle URL-encoded paths in some EPUB manifests (e.g. Chapter%201.xhtml)
        String decoded = normalized.replace("%20", " ");
        return zipFile.getEntry(decoded);
    }

    private static String resolveRelativePath(String baseDir, String href) {
        String cleanHref = href;
        int hash = cleanHref.indexOf('#');
        if (hash >= 0) {
            cleanHref = cleanHref.substring(0, hash);
        }
        String combined = baseDir + cleanHref;
        return normalizeZipPath(combined);
    }

    private static String normalizeZipPath(String raw) {
        String replaced = raw.replace('\\', '/');
        String[] parts = replaced.split("/");
        List<String> stack = new ArrayList<>();
        for (String part : parts) {
            if (part.isEmpty() || ".".equals(part)) {
                continue;
            }
            if ("..".equals(part)) {
                if (!stack.isEmpty()) {
                    stack.remove(stack.size() - 1);
                }
            } else {
                stack.add(part);
            }
        }
        return String.join("/", stack);
    }

    private static String collapseInline(String text) {
        if (text == null) return "";
        return HORIZONTAL_SPACE.matcher(text.replace('\n', ' ')).replaceAll(" ").trim();
    }

    private static int countAlphanumeric(String text) {
        if (text == null) return 0;
        int count = 0;
        for (int i = 0; i < text.length(); i++) {
            if (Character.isLetterOrDigit(text.charAt(i))) count++;
        }
        return count;
    }

    private record ManifestItem(String href, String mediaType, String properties) {}
}
