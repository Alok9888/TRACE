package trace.backend.services.ingestion;

import java.io.File;
import java.io.IOException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

import org.apache.pdfbox.Loader;
import org.apache.pdfbox.io.RandomAccessReadBuffer;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.encryption.InvalidPasswordException;
import org.apache.pdfbox.text.PDFTextStripper;
import org.springframework.stereotype.Component;

import trace.backend.exceptions.BadRequestException;

/**
 * Memory-bounded PDF text extractor preserving exact 1-based page boundaries.
 * Performs whitespace/hyphenation cleanup, repeated running header/footer stripping,
 * section heading detection, and clear rejection of scanned/image-only/encrypted PDFs.
 */
@Component
public class PdfTextExtractor {

    public static final int MAX_PAGES = 400;
    private static final int MIN_EXTRACTABLE_ALNUM_CHARS = 40;

    private static final Pattern PAGE_NUMBER_ONLY = Pattern.compile(
            "^(?:page\\s+\\d+(?:\\s*(?:of|/)\\s*\\d+)?|[-–—\\s]*\\d+[-–—\\s]*)$",
            Pattern.CASE_INSENSITIVE);
    private static final Pattern NUMBERED_HEADING = Pattern.compile(
            "^(?:(?:chapter|section|part|appendix)\\s+[A-Z0-9]+|\\d+(?:\\.\\d+){0,3})\\.?\\s+[A-Za-z].{2,90}$",
            Pattern.CASE_INSENSITIVE);
    private static final Pattern HORIZONTAL_WHITESPACE = Pattern.compile("[ \\t\\x0B\\f\\u00A0]+");
    private static final Pattern MULTI_NEWLINES = Pattern.compile("\\n{3,}");

    public record ExtractedPage(int pageNumber, String text, String primaryHeading) {}

    public record ExtractionResult(int totalPages, List<ExtractedPage> pages, int extractableChars) {}

    public ExtractionResult extract(File pdfFile) {
        try (PDDocument document = Loader.loadPDF(pdfFile)) {
            return extractDocument(document);
        } catch (InvalidPasswordException e) {
            throw new BadRequestException("This PDF is password-protected or encrypted and cannot be indexed.");
        } catch (BadRequestException e) {
            throw e;
        } catch (IOException e) {
            throw new BadRequestException("Could not read PDF file. Ensure it is a valid, uncorrupted PDF document.");
        }
    }

    public ExtractionResult extract(byte[] pdfBytes) {
        if (pdfBytes == null || pdfBytes.length == 0) {
            throw new BadRequestException("Uploaded PDF file is empty.");
        }
        try (PDDocument document = Loader.loadPDF(new RandomAccessReadBuffer(pdfBytes))) {
            return extractDocument(document);
        } catch (InvalidPasswordException e) {
            throw new BadRequestException("This PDF is password-protected or encrypted and cannot be indexed.");
        } catch (BadRequestException e) {
            throw e;
        } catch (IOException e) {
            throw new BadRequestException("Could not read PDF file. Ensure it is a valid, uncorrupted PDF document.");
        }
    }

    private ExtractionResult extractDocument(PDDocument document) throws IOException {
        if (document.isEncrypted()) {
            throw new BadRequestException("This PDF is encrypted and cannot be indexed.");
        }
        int totalPages = document.getNumberOfPages();
        if (totalPages <= 0) {
            throw new BadRequestException("This PDF has no pages to index.");
        }
        if (totalPages > MAX_PAGES) {
            throw new BadRequestException(
                    "PDF exceeds the maximum supported length of " + MAX_PAGES + " pages (found " + totalPages + ").");
        }

        PDFTextStripper stripper = new PDFTextStripper();
        stripper.setSortByPosition(true);
        stripper.setLineSeparator("\n");
        stripper.setParagraphEnd("\n\n");

        List<List<String>> rawPageLines = new ArrayList<>(totalPages);
        for (int page = 1; page <= totalPages; page++) {
            stripper.setStartPage(page);
            stripper.setEndPage(page);
            String raw = stripper.getText(document);
            rawPageLines.add(splitNormalizedLines(raw));
        }

        // Detect repeated running headers/footers appearing on >= 50% of pages (when >= 3 pages)
        Set<String> repeatedMarginLines = detectRepeatedHeadersFooters(rawPageLines);

        List<ExtractedPage> pages = new ArrayList<>(totalPages);
        int totalAlnumChars = 0;

        for (int i = 0; i < totalPages; i++) {
            int pageNumber = i + 1;
            List<String> lines = rawPageLines.get(i);
            String cleaned = cleanPageLines(lines, repeatedMarginLines);
            int alnum = countAlphanumeric(cleaned);
            totalAlnumChars += alnum;
            if (!cleaned.isBlank()) {
                String heading = detectPrimaryHeading(cleaned);
                pages.add(new ExtractedPage(pageNumber, cleaned, heading));
            }
        }

        if (pages.isEmpty() || totalAlnumChars < MIN_EXTRACTABLE_ALNUM_CHARS) {
            throw new BadRequestException(
                    "No extractable text found in this PDF. It appears to be scanned or image-only — please upload a text-searchable or OCR-processed PDF.");
        }

        return new ExtractionResult(totalPages, pages, totalAlnumChars);
    }

    private static List<String> splitNormalizedLines(String raw) {
        if (raw == null || raw.isEmpty()) {
            return List.of();
        }
        String noNulls = raw.indexOf('\0') >= 0 ? raw.replace("\0", "") : raw;
        String normalized = noNulls.replace("\r\n", "\n").replace('\r', '\n');
        String[] split = normalized.split("\n", -1);
        List<String> lines = new ArrayList<>(split.length);
        for (String line : split) {
            String collapsed = HORIZONTAL_WHITESPACE.matcher(line).replaceAll(" ").trim();
            lines.add(collapsed);
        }
        return lines;
    }

    private static Set<String> detectRepeatedHeadersFooters(List<List<String>> rawPageLines) {
        int pageCount = rawPageLines.size();
        if (pageCount < 3) {
            return Set.of();
        }
        Map<String, Integer> marginCounts = new HashMap<>();
        for (List<String> lines : rawPageLines) {
            List<String> nonEmpty = lines.stream().filter(l -> !l.isEmpty()).toList();
            if (nonEmpty.isEmpty()) {
                continue;
            }
            Set<String> seenOnPage = new HashSet<>();
            int topLimit = Math.min(2, nonEmpty.size());
            for (int i = 0; i < topLimit; i++) {
                String candidate = nonEmpty.get(i);
                if (candidate.length() <= 100 && seenOnPage.add(candidate)) {
                    marginCounts.merge(candidate, 1, Integer::sum);
                }
            }
            int bottomStart = Math.max(0, nonEmpty.size() - 2);
            for (int i = bottomStart; i < nonEmpty.size(); i++) {
                String candidate = nonEmpty.get(i);
                if (candidate.length() <= 100 && seenOnPage.add(candidate)) {
                    marginCounts.merge(candidate, 1, Integer::sum);
                }
            }
        }
        int threshold = Math.max(3, (int) Math.ceil(pageCount * 0.5));
        Set<String> repeated = new HashSet<>();
        for (Map.Entry<String, Integer> entry : marginCounts.entrySet()) {
            if (entry.getValue() >= threshold) {
                repeated.add(entry.getKey());
            }
        }
        return repeated;
    }

    private static String cleanPageLines(List<String> lines, Set<String> repeatedMarginLines) {
        if (lines.isEmpty()) {
            return "";
        }
        StringBuilder sb = new StringBuilder(lines.size() * 64);
        boolean previousWasBlank = true;
        for (int i = 0; i < lines.size(); i++) {
            String line = lines.get(i);
            if (line.isEmpty()) {
                if (!previousWasBlank) {
                    sb.append("\n\n");
                    previousWasBlank = true;
                }
                continue;
            }
            if (repeatedMarginLines.contains(line) || PAGE_NUMBER_ONLY.matcher(line).matches()) {
                continue;
            }
            // Join soft-hyphenated words split across line wraps
            if (sb.length() >= 2 && sb.charAt(sb.length() - 1) == '-'
                    && Character.isLetter(sb.charAt(sb.length() - 2))
                    && Character.isLowerCase(line.charAt(0))) {
                sb.setLength(sb.length() - 1);
                sb.append(line);
            } else {
                if (!previousWasBlank && sb.length() > 0) {
                    sb.append('\n');
                }
                sb.append(line);
            }
            previousWasBlank = false;
        }
        return MULTI_NEWLINES.matcher(sb.toString().trim()).replaceAll("\n\n");
    }

    static String detectPrimaryHeading(String cleanedPageText) {
        if (cleanedPageText == null || cleanedPageText.isBlank()) {
            return null;
        }
        String[] lines = cleanedPageText.split("\n");
        int scanned = 0;
        for (String rawLine : lines) {
            String line = rawLine.trim();
            if (line.isEmpty()) {
                continue;
            }
            scanned++;
            if (scanned > 8) {
                break;
            }
            if (isLikelyHeading(line)) {
                return line.length() > 96 ? line.substring(0, 96).trim() : line;
            }
        }
        return null;
    }

    static boolean isLikelyHeading(String line) {
        if (line == null) return false;
        String trimmed = line.trim();
        int len = trimmed.length();
        if (len < 3 || len > 90) return false;
        if (trimmed.endsWith(".") || trimmed.endsWith(",") || trimmed.endsWith(";")) return false;
        if (NUMBERED_HEADING.matcher(trimmed).matches()) return true;

        // Short standalone ALL-CAPS heading with letters (e.g., "EXECUTIVE SUMMARY")
        int letters = 0;
        int upper = 0;
        for (int i = 0; i < len; i++) {
            char c = trimmed.charAt(i);
            if (Character.isLetter(c)) {
                letters++;
                if (Character.isUpperCase(c)) upper++;
            }
        }
        if (letters >= 4 && upper == letters && trimmed.split("\\s+").length <= 10) {
            return true;
        }
        return false;
    }

    private static int countAlphanumeric(String text) {
        if (text == null) return 0;
        int count = 0;
        for (int i = 0; i < text.length(); i++) {
            if (Character.isLetterOrDigit(text.charAt(i))) {
                count++;
            }
        }
        return count;
    }
}
