package ingestion

import (
	"archive/zip"
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"os/exec"
	"path"
	"regexp"
	"strings"
	"unicode"

	"github.com/ledongthuc/pdf"
	"golang.org/x/net/html"

	"trace/backend-go/internal/model"
)

// DocumentExtractor is the unified strategy interface implemented by PDF, Notebook, IaC, and EPUB extractors.
type DocumentExtractor interface {
	SourceType() model.SourceType
	Supports(filename, contentType string) bool
	Extract(ctx context.Context, tempFilePath, originalFilename string) ([]ExtractedSection, error)
}

func DefaultExtractors() []DocumentExtractor {
	return []DocumentExtractor{
		&PDFExtractor{},
		&NotebookExtractor{},
		&EPUBExtractor{},
		&IACExtractor{},
	}
}

// =============================================================================
// 1. PDF EXTRACTOR (Poppler pdftotext primary, pure-Go ledongthuc/pdf fallback)
// =============================================================================

const (
	MaxPDFPages              = 400
	MinExtractableAlnumChars = 40
)

var (
	pdfPageNumberOnlyRe = regexp.MustCompile(`(?i)^(?:page\s+\d+(?:\s*(?:of|/)\s*\d+)?|[-\x{2013}\x{2014}\s]*\d+[-\x{2013}\x{2014}\s]*)$`)
	pdfNumberedHeading  = regexp.MustCompile(`(?i)^(?:(?:chapter|section|part|appendix)\s+[A-Z0-9]+|\d+(?:\.\d+){0,3})\.?\s+[A-Za-z].{2,90}$`)
	horizWhitespaceRe   = regexp.MustCompile(`[ \t\x0B\f\x{00A0}]+`)
	multiNewlineRe      = regexp.MustCompile(`\n{3,}`)
)

type PDFExtractor struct{}

func (p *PDFExtractor) SourceType() model.SourceType { return model.SourcePDF }

func (p *PDFExtractor) Supports(filename, contentType string) bool {
	return strings.HasSuffix(strings.ToLower(filename), ".pdf") ||
		strings.Contains(strings.ToLower(contentType), "pdf")
}

func (p *PDFExtractor) Extract(ctx context.Context, tempFilePath, _ string) ([]ExtractedSection, error) {
	rawPages, err := extractPDFPagesRaw(ctx, tempFilePath)
	if err != nil {
		return nil, err
	}
	if len(rawPages) == 0 {
		return nil, errors.New("this PDF has no pages to index")
	}
	if len(rawPages) > MaxPDFPages {
		return nil, fmt.Errorf("PDF exceeds the maximum supported length of %d pages (found %d)", MaxPDFPages, len(rawPages))
	}

	rawPageLines := make([][]string, len(rawPages))
	for i, raw := range rawPages {
		rawPageLines[i] = splitNormalizedLines(raw)
	}
	repeatedMargins := detectRepeatedHeadersFooters(rawPageLines)

	var sections []ExtractedSection
	totalAlnum := 0
	for i, lines := range rawPageLines {
		cleaned := cleanPDFPageLines(lines, repeatedMargins)
		alnum := countAlphanumeric(cleaned)
		totalAlnum += alnum
		if strings.TrimSpace(cleaned) != "" {
			sections = append(sections, ExtractedSection{
				SectionHeading: detectPrimaryHeading(cleaned),
				UnitNumber:     i + 1,
				Content:        cleaned,
			})
		}
	}

	if len(sections) == 0 || totalAlnum < MinExtractableAlnumChars {
		return nil, errors.New("no extractable text found in this PDF. It appears to be scanned or image-only — please upload a text-searchable or OCR-processed PDF")
	}
	return sections, nil
}

func extractPDFPagesRaw(ctx context.Context, filePath string) ([]string, error) {
	// Fast, zero-heap path in Linux/Docker containers where poppler-utils is installed
	if bin, err := exec.LookPath("pdftotext"); err == nil {
		cmd := exec.CommandContext(ctx, bin, "-enc", "UTF-8", filePath, "-")
		var stdout, stderr bytes.Buffer
		cmd.Stdout = &stdout
		cmd.Stderr = &stderr
		if err := cmd.Run(); err != nil {
			errMsg := strings.ToLower(stderr.String())
			if strings.Contains(errMsg, "password") || strings.Contains(errMsg, "encrypt") {
				return nil, errors.New("this PDF is password-protected or encrypted and cannot be indexed")
			}
			// Fall back to pure-Go extractor on unusual CLI errors
		} else {
			pages := strings.Split(stdout.String(), "\f")
			if len(pages) > 1 && strings.TrimSpace(pages[len(pages)-1]) == "" {
				pages = pages[:len(pages)-1]
			}
			return pages, nil
		}
	}

	// Pure-Go fallback (ideal for local Windows development without Poppler installed)
	f, r, err := pdf.Open(filePath)
	if err != nil {
		msg := strings.ToLower(err.Error())
		if strings.Contains(msg, "encrypt") || strings.Contains(msg, "password") {
			return nil, errors.New("this PDF is password-protected or encrypted and cannot be indexed")
		}
		return nil, errors.New("could not read PDF file; ensure it is a valid, uncorrupted PDF document")
	}
	defer f.Close()

	numPages := r.NumPage()
	if numPages > MaxPDFPages {
		return nil, fmt.Errorf("PDF exceeds the maximum supported length of %d pages (found %d)", MaxPDFPages, numPages)
	}
	pages := make([]string, 0, numPages)
	for i := 1; i <= numPages; i++ {
		page := r.Page(i)
		if page.V.IsNull() {
			pages = append(pages, "")
			continue
		}
		text, err := page.GetPlainText(nil)
		if err != nil {
			pages = append(pages, "")
			continue
		}
		pages = append(pages, text)
	}
	return pages, nil
}

func splitNormalizedLines(raw string) []string {
	if raw == "" {
		return nil
	}
	norm := strings.ReplaceAll(strings.ReplaceAll(stripNulls(raw), "\r\n", "\n"), "\r", "\n")
	parts := strings.Split(norm, "\n")
	out := make([]string, len(parts))
	for i, l := range parts {
		out[i] = strings.TrimSpace(horizWhitespaceRe.ReplaceAllString(l, " "))
	}
	return out
}

func detectRepeatedHeadersFooters(rawPageLines [][]string) map[string]struct{} {
	pageCount := len(rawPageLines)
	if pageCount < 3 {
		return nil
	}
	counts := make(map[string]int)
	for _, lines := range rawPageLines {
		var nonEmpty []string
		for _, l := range lines {
			if l != "" {
				nonEmpty = append(nonEmpty, l)
			}
		}
		if len(nonEmpty) == 0 {
			continue
		}
		seen := make(map[string]struct{})
		for i := 0; i < min(2, len(nonEmpty)); i++ {
			c := nonEmpty[i]
			if len(c) <= 100 {
				if _, ok := seen[c]; !ok {
					seen[c] = struct{}{}
					counts[c]++
				}
			}
		}
		for i := max(0, len(nonEmpty)-2); i < len(nonEmpty); i++ {
			c := nonEmpty[i]
			if len(c) <= 100 {
				if _, ok := seen[c]; !ok {
					seen[c] = struct{}{}
					counts[c]++
				}
			}
		}
	}
	threshold := max(3, int(math.Ceil(float64(pageCount)*0.5)))
	repeated := make(map[string]struct{})
	for k, v := range counts {
		if v >= threshold {
			repeated[k] = struct{}{}
		}
	}
	return repeated
}

func cleanPDFPageLines(lines []string, repeated map[string]struct{}) string {
	var sb strings.Builder
	prevBlank := true
	for _, line := range lines {
		if line == "" {
			if !prevBlank {
				sb.WriteString("\n\n")
				prevBlank = true
			}
			continue
		}
		if _, isRep := repeated[line]; isRep || pdfPageNumberOnlyRe.MatchString(line) {
			continue
		}
		cur := sb.String()
		if len(cur) >= 2 && cur[len(cur)-1] == '-' && unicode.IsLetter(rune(cur[len(cur)-2])) && unicode.IsLower(rune(line[0])) {
			trimmed := cur[:len(cur)-1]
			sb.Reset()
			sb.WriteString(trimmed)
			sb.WriteString(line)
		} else {
			if !prevBlank && sb.Len() > 0 {
				sb.WriteByte('\n')
			}
			sb.WriteString(line)
		}
		prevBlank = false
	}
	return multiNewlineRe.ReplaceAllString(strings.TrimSpace(sb.String()), "\n\n")
}

func detectPrimaryHeading(text string) string {
	scanned := 0
	for _, raw := range strings.Split(text, "\n") {
		line := strings.TrimSpace(raw)
		if line == "" {
			continue
		}
		scanned++
		if scanned > 8 {
			break
		}
		if isLikelyHeading(line) {
			return strings.TrimSpace(truncateUTF8(line, 96))
		}
	}
	return ""
}

func isLikelyHeading(line string) bool {
	l := len(line)
	if l < 3 || l > 90 || strings.HasSuffix(line, ".") || strings.HasSuffix(line, ",") || strings.HasSuffix(line, ";") {
		return false
	}
	if pdfNumberedHeading.MatchString(line) {
		return true
	}
	letters, upper := 0, 0
	for _, r := range line {
		if unicode.IsLetter(r) {
			letters++
			if unicode.IsUpper(r) {
				upper++
			}
		}
	}
	return letters >= 4 && upper == letters && len(strings.Fields(line)) <= 10
}

// =============================================================================
// 2. JUPYTER NOTEBOOK EXTRACTOR (Token-streaming json.Decoder, skips plot bloat)
// =============================================================================

const maxCellTextChars = 200_000

var (
	mdHeadingRe    = regexp.MustCompile(`^#{1,6}\s+(.+)$`)
	fenceLangClean = regexp.MustCompile(`[^a-z0-9_+#-]`)
)

type NotebookExtractor struct{}

func (n *NotebookExtractor) SourceType() model.SourceType { return model.SourceNotebook }

func (n *NotebookExtractor) Supports(filename, contentType string) bool {
	return strings.HasSuffix(strings.ToLower(filename), ".ipynb") ||
		strings.Contains(strings.ToLower(contentType), "x-ipynb")
}

type rawNotebookCell struct {
	cellNumber int
	cellType   string
	text       string
}

func (n *NotebookExtractor) Extract(_ context.Context, tempFilePath, _ string) ([]ExtractedSection, error) {
	f, err := os.Open(tempFilePath)
	if err != nil {
		return nil, errors.New("could not open Jupyter Notebook file")
	}
	defer f.Close()

	dec := json.NewDecoder(f)
	tok, err := dec.Token()
	if err != nil || tok != json.Delim('{') {
		return nil, errors.New("invalid Jupyter Notebook format: root JSON object expected")
	}

	kernelLang := "python"
	var cells []rawNotebookCell

	for dec.More() {
		keyTok, err := dec.Token()
		if err != nil {
			return nil, errors.New("could not parse Jupyter Notebook JSON")
		}
		field, _ := keyTok.(string)

		switch field {
		case "metadata":
			if lang := parseNotebookKernelLang(dec); lang != "" {
				kernelLang = lang
			}
		case "cells":
			parsedCells, err := parseNotebookCells(dec)
			if err != nil {
				return nil, err
			}
			cells = parsedCells
		default:
			if err := skipJSONValue(dec); err != nil {
				return nil, err
			}
		}
	}

	if len(cells) == 0 {
		return nil, errors.New("this Jupyter Notebook contains no non-empty Markdown or code cells to index")
	}
	return pairNotebookCells(cells, kernelLang), nil
}

func parseNotebookKernelLang(dec *json.Decoder) string {
	var meta struct {
		Kernelspec   struct{ Language string `json:"language"` } `json:"kernelspec"`
		LanguageInfo struct{ Name string `json:"name"` } `json:"language_info"`
	}
	if err := dec.Decode(&meta); err != nil {
		return ""
	}
	raw := strings.ToLower(strings.TrimSpace(meta.Kernelspec.Language))
	if raw == "" {
		raw = strings.ToLower(strings.TrimSpace(meta.LanguageInfo.Name))
	}
	cleaned := fenceLangClean.ReplaceAllString(raw, "")
	if cleaned == "" {
		return ""
	}
	return cleaned
}

func parseNotebookCells(dec *json.Decoder) ([]rawNotebookCell, error) {
	tok, err := dec.Token()
	if err != nil || tok != json.Delim('[') {
		return nil, errors.New("invalid notebook cells array")
	}

	var cells []rawNotebookCell
	cellNum := 0

	for dec.More() {
		t, err := dec.Token()
		if err != nil {
			return nil, err
		}
		if t != json.Delim('{') {
			continue
		}
		cellNum++
		var cellType, source string

		for dec.More() {
			ft, err := dec.Token()
			if err != nil {
				return nil, err
			}
			field, _ := ft.(string)
			switch field {
			case "cell_type":
				var s string
				if err := dec.Decode(&s); err == nil {
					cellType = strings.ToLower(strings.TrimSpace(s))
				}
			case "source":
				source, err = readNotebookSource(dec)
				if err != nil {
					return nil, err
				}
			default:
				// Immediately discard outputs/metadata/attachments (multi-MB base64 plots) without loading into heap
				if err := skipJSONValue(dec); err != nil {
					return nil, err
				}
			}
		}
		_, _ = dec.Token() // closing '}'

		source = strings.TrimSpace(strings.ReplaceAll(strings.ReplaceAll(stripNulls(source), "\r\n", "\n"), "\r", "\n"))
		if source != "" && (cellType == "markdown" || cellType == "code") {
			cells = append(cells, rawNotebookCell{cellNumber: cellNum, cellType: cellType, text: source})
		}
	}
	_, _ = dec.Token() // closing ']'
	return cells, nil
}

func readNotebookSource(dec *json.Decoder) (string, error) {
	tok, err := dec.Token()
	if err != nil {
		return "", err
	}
	switch v := tok.(type) {
	case string:
		return truncateUTF8(v, maxCellTextChars), nil
	case json.Delim:
		if v == '[' {
			var sb strings.Builder
			for dec.More() {
				elem, err := dec.Token()
				if err != nil {
					return "", err
				}
				if s, ok := elem.(string); ok && sb.Len() < maxCellTextChars {
					sb.WriteString(truncateUTF8(s, maxCellTextChars-sb.Len()))
				}
			}
			_, _ = dec.Token() // ']'
			return sb.String(), nil
		}
		return "", skipOpenDelim(dec, v)
	default:
		return "", nil
	}
}

func skipJSONValue(dec *json.Decoder) error {
	tok, err := dec.Token()
	if err != nil {
		return err
	}
	if d, ok := tok.(json.Delim); ok {
		return skipOpenDelim(dec, d)
	}
	return nil
}

func skipOpenDelim(dec *json.Decoder, open json.Delim) error {
	depth := 1
	for depth > 0 {
		tok, err := dec.Token()
		if err != nil {
			return err
		}
		if d, ok := tok.(json.Delim); ok {
			switch d {
			case '{', '[':
				depth++
			case '}', ']':
				depth--
			}
		}
	}
	return nil
}

func pairNotebookCells(cells []rawNotebookCell, kernelLang string) []ExtractedSection {
	sections := make([]ExtractedSection, 0, len(cells))
	activeHeading := ""

	for i := 0; i < len(cells); {
		cur := cells[i]
		if cur.cellType == "markdown" {
			if h := extractLatestMDHeading(cur.text); h != "" {
				activeHeading = h
			}
			if i+1 < len(cells) && cells[i+1].cellType == "code" {
				code := cells[i+1]
				combined := cur.text + "\n\n```" + kernelLang + "\n" + code.text + "\n```"
				sections = append(sections, ExtractedSection{
					SectionHeading: activeHeading,
					UnitNumber:     code.cellNumber,
					Content:        combined,
				})
				i += 2
				continue
			}
			sections = append(sections, ExtractedSection{
				SectionHeading: activeHeading,
				UnitNumber:     cur.cellNumber,
				Content:        cur.text,
			})
			i++
		} else {
			sections = append(sections, ExtractedSection{
				SectionHeading: activeHeading,
				UnitNumber:     cur.cellNumber,
				Content:        "```" + kernelLang + "\n" + cur.text + "\n```",
			})
			i++
		}
	}
	return sections
}

func extractLatestMDHeading(md string) string {
	latest := ""
	for _, line := range strings.Split(md, "\n") {
		if m := mdHeadingRe.FindStringSubmatch(strings.TrimSpace(line)); len(m) == 2 {
			h := strings.TrimSpace(strings.TrimRight(m[1], "# "))
			if h != "" {
				latest = strings.TrimSpace(truncateUTF8(h, 96))
			}
		}
	}
	return latest
}

// =============================================================================
// 3. IAC & CI/CD EXTRACTOR (.tf, Dockerfile, docker-compose, GitHub Actions YAML)
// =============================================================================

var (
	hclTopBlockRe = regexp.MustCompile(`^(resource|data|module|variable|output|locals|provider|terraform)\b(.*)$`)
	dockerFromRe  = regexp.MustCompile(`(?i)^FROM\s+([^\s]+)(?:\s+AS\s+([^\s#]+))?.*$`)
	yamlKeyRe     = regexp.MustCompile(`^(\s*)([A-Za-z0-9_.-]+)\s*:(.*)$`)
)

type IACExtractor struct{}

func (x *IACExtractor) SourceType() model.SourceType { return model.SourceIAC }

func (x *IACExtractor) Supports(filename, _ string) bool {
	return IsIACFilename(filename)
}

func IsIACFilename(filename string) bool {
	if strings.TrimSpace(filename) == "" {
		return false
	}
	base := path.Base(strings.ToLower(strings.ReplaceAll(filename, "\\", "/")))
	return strings.HasSuffix(base, ".tf") ||
		base == "dockerfile" ||
		strings.HasSuffix(base, ".dockerfile") ||
		strings.HasPrefix(base, "dockerfile.") ||
		strings.HasSuffix(base, ".yml") ||
		strings.HasSuffix(base, ".yaml")
}

// IsIACRepoPath matches Terraform, Dockerfile, Docker Compose, and GitHub Actions workflow paths inside repos.
func IsIACRepoPath(repoPath string) bool {
	if strings.TrimSpace(repoPath) == "" {
		return false
	}
	norm := strings.ToLower(strings.ReplaceAll(repoPath, "\\", "/"))
	base := path.Base(norm)
	if strings.HasSuffix(base, ".tf") || base == "dockerfile" || strings.HasSuffix(base, ".dockerfile") || strings.HasPrefix(base, "dockerfile.") {
		return true
	}
	if base == "docker-compose.yml" || base == "docker-compose.yaml" || base == "compose.yml" || base == "compose.yaml" {
		return true
	}
	return (strings.HasPrefix(norm, ".github/workflows/") || strings.Contains(norm, "/.github/workflows/")) &&
		(strings.HasSuffix(base, ".yml") || strings.HasSuffix(base, ".yaml"))
}

func (x *IACExtractor) Extract(_ context.Context, tempFilePath, originalFilename string) ([]ExtractedSection, error) {
	f, err := os.Open(tempFilePath)
	if err != nil {
		return nil, errors.New("could not read infrastructure configuration file")
	}
	defer f.Close()
	sections, err := ExtractIACFromReader(f, originalFilename)
	if err != nil {
		return nil, err
	}
	if len(sections) == 0 {
		return nil, fmt.Errorf("no indexable infrastructure blocks were found in %s", originalFilename)
	}
	return sections, nil
}

func ExtractIACFromString(content, filename string) []ExtractedSection {
	if strings.TrimSpace(content) == "" {
		return nil
	}
	sections, _ := ExtractIACFromReader(strings.NewReader(content), filename)
	return sections
}

func ExtractIACFromReader(r io.Reader, filename string) ([]ExtractedSection, error) {
	base := path.Base(strings.ToLower(strings.ReplaceAll(filename, "\\", "/")))
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)

	switch {
	case strings.HasSuffix(base, ".tf"):
		return extractTerraform(scanner), scanner.Err()
	case base == "dockerfile" || strings.HasSuffix(base, ".dockerfile") || strings.HasPrefix(base, "dockerfile."):
		return extractDockerfile(scanner), scanner.Err()
	case strings.HasSuffix(base, ".yml") || strings.HasSuffix(base, ".yaml"):
		return extractYAMLWorkflowOrCompose(scanner, base), scanner.Err()
	default:
		var sb strings.Builder
		for scanner.Scan() {
			sb.WriteString(stripNulls(scanner.Text()))
			sb.WriteByte('\n')
		}
		if text := strings.TrimSpace(sb.String()); text != "" {
			return []ExtractedSection{{SectionHeading: base, UnitNumber: 1, Content: text}}, scanner.Err()
		}
		return nil, scanner.Err()
	}
}

func extractTerraform(scanner *bufio.Scanner) []ExtractedSection {
	var sections []ExtractedSection
	var current, pendingComments strings.Builder
	heading := ""
	startLine, braceDepth, lineNum := 1, 0, 0

	flush := func() {
		if text := strings.TrimSpace(current.String()); text != "" {
			sections = append(sections, ExtractedSection{
				SectionHeading: heading,
				UnitNumber:     max(1, startLine),
				Content:        text,
			})
		}
		current.Reset()
		heading = ""
	}

	for scanner.Scan() {
		lineNum++
		line := stripNulls(scanner.Text())
		trimmed := strings.TrimSpace(line)

		if braceDepth == 0 {
			if trimmed == "" {
				if current.Len() > 0 {
					flush()
				}
				continue
			}
			if strings.HasPrefix(trimmed, "#") || strings.HasPrefix(trimmed, "//") {
				if pendingComments.Len() == 0 {
					startLine = lineNum
				}
				pendingComments.WriteString(line)
				pendingComments.WriteByte('\n')
				continue
			}
			if hclTopBlockRe.MatchString(trimmed) {
				if current.Len() > 0 {
					flush()
				}
				if pendingComments.Len() > 0 {
					current.WriteString(pendingComments.String())
					pendingComments.Reset()
				} else {
					startLine = lineNum
				}
				heading = extractHCLSignature(trimmed)
				current.WriteString(line)
				current.WriteByte('\n')
				braceDepth = max(0, braceDepth+netBraceDelta(line))
				if braceDepth == 0 && strings.HasSuffix(trimmed, "}") {
					flush()
				}
			} else {
				if current.Len() == 0 {
					startLine = lineNum
					heading = "terraform"
				}
				if pendingComments.Len() > 0 {
					current.WriteString(pendingComments.String())
					pendingComments.Reset()
				}
				current.WriteString(line)
				current.WriteByte('\n')
				braceDepth = max(0, braceDepth+netBraceDelta(line))
			}
		} else {
			current.WriteString(line)
			current.WriteByte('\n')
			braceDepth = max(0, braceDepth+netBraceDelta(line))
			if braceDepth == 0 {
				flush()
			}
		}
	}
	if current.Len() > 0 {
		flush()
	}
	return sections
}

func extractHCLSignature(trimmed string) string {
	sig := trimmed
	if idx := strings.IndexByte(trimmed, '{'); idx >= 0 {
		sig = strings.TrimSpace(trimmed[:idx])
	}
	return strings.TrimSpace(truncateUTF8(sig, 110))
}

func netBraceDelta(line string) int {
	delta := 0
	inQuote, escaped := false, false
	for i := 0; i < len(line); i++ {
		c := line[i]
		if escaped {
			escaped = false
			continue
		}
		if c == '\\' && inQuote {
			escaped = true
			continue
		}
		if c == '"' {
			inQuote = !inQuote
			continue
		}
		if !inQuote {
			if c == '#' || (c == '/' && i+1 < len(line) && line[i+1] == '/') {
				break
			}
			if c == '{' {
				delta++
			} else if c == '}' {
				delta--
			}
		}
	}
	return delta
}

func extractDockerfile(scanner *bufio.Scanner) []ExtractedSection {
	var sections []ExtractedSection
	var current strings.Builder
	stage := "Stage: preamble"
	startLine, stageCounter, lineNum := 1, 0, 0

	flush := func() {
		if text := strings.TrimSpace(current.String()); text != "" {
			sections = append(sections, ExtractedSection{
				SectionHeading: stage,
				UnitNumber:     max(1, startLine),
				Content:        text,
			})
		}
		current.Reset()
	}

	for scanner.Scan() {
		lineNum++
		line := stripNulls(scanner.Text())
		trimmed := strings.TrimSpace(line)

		if m := dockerFromRe.FindStringSubmatch(trimmed); len(m) >= 2 {
			if strings.TrimSpace(current.String()) != "" {
				flush()
			}
			stageCounter++
			if len(m) >= 3 && strings.TrimSpace(m[2]) != "" {
				stage = "Stage: " + m[2]
			} else {
				stage = fmt.Sprintf("Stage %d: %s", stageCounter, m[1])
			}
			startLine = lineNum
		} else if current.Len() == 0 && trimmed != "" {
			startLine = lineNum
		}
		if current.Len() > 0 || trimmed != "" {
			current.WriteString(line)
			current.WriteByte('\n')
		}
	}
	flush()
	return sections
}

func extractYAMLWorkflowOrCompose(scanner *bufio.Scanner, filename string) []ExtractedSection {
	var sections []ExtractedSection
	var preamble, activeBody strings.Builder
	preambleStart := -1
	activeContainer := ""
	childIndent := -1
	activeHeading := ""
	activeStartLine := 1
	lineNum := 0

	flushActive := func() {
		if text := strings.TrimSpace(activeBody.String()); text != "" && activeHeading != "" {
			sections = append(sections, ExtractedSection{
				SectionHeading: activeHeading,
				UnitNumber:     max(1, activeStartLine),
				Content:        text,
			})
		}
		activeBody.Reset()
		activeHeading = ""
	}

	for scanner.Scan() {
		lineNum++
		line := stripNulls(scanner.Text())
		trimmed := strings.TrimSpace(line)

		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			if activeHeading != "" {
				activeBody.WriteString(line)
				activeBody.WriteByte('\n')
			} else if trimmed != "" {
				if preambleStart < 0 {
					preambleStart = lineNum
				}
				preamble.WriteString(line)
				preamble.WriteByte('\n')
			}
			continue
		}

		indent := leadingSpaces(line)
		m := yamlKeyRe.FindStringSubmatch(line)

		if indent == 0 && len(m) >= 3 {
			flushActive()
			childIndent = -1
			topKey := m[2]
			if topKey == "services" || topKey == "jobs" {
				activeContainer = topKey
				continue
			}
			activeContainer = ""
			if preambleStart < 0 {
				preambleStart = lineNum
			}
			preamble.WriteString(line)
			preamble.WriteByte('\n')
			continue
		}

		if activeContainer != "" {
			if len(m) >= 3 && (childIndent < 0 || indent == childIndent) {
				flushActive()
				childIndent = indent
				prefix := "job: "
				if activeContainer == "services" {
					prefix = "service: "
				}
				activeHeading = prefix + m[2]
				activeStartLine = lineNum
				activeBody.WriteString(activeContainer + ":\n" + line + "\n")
			} else if activeHeading != "" {
				activeBody.WriteString(line)
				activeBody.WriteByte('\n')
			}
		} else {
			if preambleStart < 0 {
				preambleStart = lineNum
			}
			preamble.WriteString(line)
			preamble.WriteByte('\n')
		}
	}
	flushActive()

	if text := strings.TrimSpace(preamble.String()); text != "" {
		sections = append([]ExtractedSection{{
			SectionHeading: "config: " + filename,
			UnitNumber:     max(1, preambleStart),
			Content:        text,
		}}, sections...)
	}
	return sections
}

func leadingSpaces(line string) int {
	n := 0
	for i := 0; i < len(line); i++ {
		if line[i] == ' ' {
			n++
		} else if line[i] == '\t' {
			n += 2
		} else {
			break
		}
	}
	return n
}

// =============================================================================
// 4. EPUB EXTRACTOR (archive/zip + XML OPF spine + x/net/html structured renderer)
// =============================================================================

const MaxEPUBChapters = 350

var fontExts = []string{".otf", ".ttf", ".woff", ".woff2"}

type EPUBExtractor struct{}

func (e *EPUBExtractor) SourceType() model.SourceType { return model.SourceEPUB }

func (e *EPUBExtractor) Supports(filename, contentType string) bool {
	return strings.HasSuffix(strings.ToLower(filename), ".epub") ||
		strings.Contains(strings.ToLower(contentType), "epub")
}

func (e *EPUBExtractor) Extract(_ context.Context, tempFilePath, _ string) ([]ExtractedSection, error) {
	zr, err := zip.OpenReader(tempFilePath)
	if err != nil {
		return nil, errors.New("could not read EPUB file; ensure it is a valid, uncorrupted EPUB archive")
	}
	defer zr.Close()

	entries := make(map[string]*zip.File, len(zr.File))
	for _, f := range zr.File {
		entries[normalizeZipPath(f.Name)] = f
	}

	if err := rejectDRM(entries); err != nil {
		return nil, err
	}
	opfPath, err := resolveOPFPath(entries)
	if err != nil {
		return nil, err
	}
	spinePaths, err := resolveSpinePaths(entries, opfPath)
	if err != nil {
		return nil, err
	}
	if len(spinePaths) == 0 {
		return nil, errors.New("no readable chapters were found in this EPUB archive")
	}
	if len(spinePaths) > MaxEPUBChapters {
		return nil, fmt.Errorf("EPUB exceeds the maximum supported limit of %d spine items", MaxEPUBChapters)
	}

	var chapters []ExtractedSection
	chapterNum, totalAlnum := 0, 0

	for _, chPath := range spinePaths {
		f := lookupZipEntry(entries, chPath)
		if f == nil || f.FileInfo().IsDir() {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			continue
		}
		doc, parseErr := html.Parse(rc)
		_ = rc.Close()
		if parseErr != nil {
			continue
		}

		heading := extractHTMLHeading(doc)
		body := extractHTMLBody(doc)
		alnum := countAlphanumeric(body)
		if alnum < 15 {
			continue
		}
		chapterNum++
		totalAlnum += alnum
		if heading == "" {
			heading = fmt.Sprintf("Chapter %d", chapterNum)
		}
		chapters = append(chapters, ExtractedSection{
			SectionHeading: heading,
			UnitNumber:     chapterNum,
			Content:        body,
		})
	}

	if len(chapters) == 0 || totalAlnum < MinExtractableAlnumChars {
		return nil, errors.New("no extractable text found in this EPUB; it may contain only images or unsupported content")
	}
	return chapters, nil
}

func rejectDRM(entries map[string]*zip.File) error {
	f := lookupZipEntry(entries, "META-INF/encryption.xml")
	if f == nil {
		return nil
	}
	rc, err := f.Open()
	if err != nil {
		return nil
	}
	defer rc.Close()

	dec := xml.NewDecoder(rc)
	inEncrypted := false
	for {
		tok, err := dec.Token()
		if err != nil {
			break
		}
		switch t := tok.(type) {
		case xml.StartElement:
			if t.Name.Local == "EncryptedData" {
				inEncrypted = true
			}
			if inEncrypted && t.Name.Local == "CipherReference" {
				uri := ""
				for _, attr := range t.Attr {
					if strings.EqualFold(attr.Name.Local, "URI") {
						uri = strings.ToLower(attr.Value)
					}
				}
				isFont := false
				for _, ext := range fontExts {
					if strings.HasSuffix(uri, ext) {
						isFont = true
						break
					}
				}
				if !isFont {
					return errors.New("this EPUB is DRM-encrypted and cannot be indexed; please upload a DRM-free EPUB")
				}
			}
		case xml.EndElement:
			if t.Name.Local == "EncryptedData" {
				inEncrypted = false
			}
		}
	}
	return nil
}

func resolveOPFPath(entries map[string]*zip.File) (string, error) {
	f := lookupZipEntry(entries, "META-INF/container.xml")
	if f == nil {
		return "", errors.New("invalid EPUB archive: missing META-INF/container.xml")
	}
	rc, err := f.Open()
	if err != nil {
		return "", err
	}
	defer rc.Close()

	dec := xml.NewDecoder(rc)
	for {
		tok, err := dec.Token()
		if err != nil {
			break
		}
		if se, ok := tok.(xml.StartElement); ok && se.Name.Local == "rootfile" {
			for _, attr := range se.Attr {
				if attr.Name.Local == "full-path" && strings.TrimSpace(attr.Value) != "" {
					return normalizeZipPath(attr.Value), nil
				}
			}
		}
	}
	return "", errors.New("invalid EPUB archive: container.xml does not specify an OPF package")
}

type manifestItem struct {
	href       string
	mediaType  string
	properties string
}

func resolveSpinePaths(entries map[string]*zip.File, opfPath string) ([]string, error) {
	f := lookupZipEntry(entries, opfPath)
	if f == nil {
		return nil, fmt.Errorf("invalid EPUB archive: missing OPF package at %s", opfPath)
	}
	rc, err := f.Open()
	if err != nil {
		return nil, err
	}
	defer rc.Close()

	opfDir := ""
	if slash := strings.LastIndexByte(opfPath, '/'); slash >= 0 {
		opfDir = opfPath[:slash+1]
	}

	manifest := make(map[string]manifestItem)
	var spineRefs []string

	dec := xml.NewDecoder(rc)
	for {
		tok, err := dec.Token()
		if err != nil {
			break
		}
		se, ok := tok.(xml.StartElement)
		if !ok {
			continue
		}
		switch se.Name.Local {
		case "item":
			var id, href, mt, props string
			for _, a := range se.Attr {
				switch a.Name.Local {
				case "id":
					id = a.Value
				case "href":
					href = a.Value
				case "media-type":
					mt = strings.ToLower(a.Value)
				case "properties":
					props = strings.ToLower(a.Value)
				}
			}
			if id != "" && href != "" {
				manifest[id] = manifestItem{href: href, mediaType: mt, properties: props}
			}
		case "itemref":
			var idref, linear string
			for _, a := range se.Attr {
				switch a.Name.Local {
				case "idref":
					idref = a.Value
				case "linear":
					linear = a.Value
				}
			}
			if !strings.EqualFold(linear, "no") && idref != "" {
				spineRefs = append(spineRefs, idref)
			}
		}
	}

	seen := make(map[string]struct{})
	var paths []string
	for _, ref := range spineRefs {
		item, ok := manifest[ref]
		if !ok || strings.Contains(item.properties, "nav") {
			continue
		}
		lowerHref := strings.ToLower(item.href)
		readable := strings.Contains(item.mediaType, "html") ||
			strings.HasSuffix(lowerHref, ".xhtml") ||
			strings.HasSuffix(lowerHref, ".html") ||
			strings.HasSuffix(lowerHref, ".htm")
		if !readable {
			continue
		}
		cleanHref := item.href
		if hash := strings.IndexByte(cleanHref, '#'); hash >= 0 {
			cleanHref = cleanHref[:hash]
		}
		resolved := normalizeZipPath(opfDir + cleanHref)
		if _, dup := seen[resolved]; !dup {
			seen[resolved] = struct{}{}
			paths = append(paths, resolved)
		}
	}
	return paths, nil
}

func extractHTMLHeading(root *html.Node) string {
	for _, tag := range []string{"h1", "h2", "title"} {
		if node := findFirstElement(root, tag); node != nil {
			text := collapseInline(collectText(node))
			if text != "" && !strings.EqualFold(text, "untitled") {
				return strings.TrimSpace(truncateUTF8(text, 96))
			}
		}
	}
	return ""
}

func extractHTMLBody(root *html.Node) string {
	body := findFirstElement(root, "body")
	if body == nil {
		body = root
	}
	var out strings.Builder
	renderHTMLNode(body, &out, false)
	cleaned := strings.ReplaceAll(strings.ReplaceAll(stripNulls(out.String()), "\r\n", "\n"), "\r", "\n")
	return multiNewlineRe.ReplaceAllString(strings.TrimSpace(cleaned), "\n\n")
}

func renderHTMLNode(n *html.Node, out *strings.Builder, insidePre bool) {
	if n.Type == html.TextNode {
		if insidePre {
			out.WriteString(n.Data)
			return
		}
		text := horizWhitespaceRe.ReplaceAllString(strings.ReplaceAll(n.Data, "\n", " "), " ")
		if strings.TrimSpace(text) != "" || (out.Len() > 0 && !strings.HasSuffix(out.String(), "\n") && !strings.HasSuffix(out.String(), " ")) {
			out.WriteString(text)
		}
		return
	}
	if n.Type != html.ElementNode {
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			renderHTMLNode(c, out, insidePre)
		}
		return
	}

	tag := strings.ToLower(n.Data)
	switch tag {
	case "script", "style", "nav", "svg", "img":
		return
	case "pre":
		code := strings.TrimSpace(strings.ReplaceAll(strings.ReplaceAll(collectText(n), "\r\n", "\n"), "\r", "\n"))
		if code != "" {
			ensureBlankLine(out)
			out.WriteString("```\n" + code + "\n```\n\n")
		}
		return
	case "code":
		if !insidePre {
			if inline := collapseInline(collectText(n)); inline != "" {
				out.WriteByte('`')
				out.WriteString(inline)
				out.WriteByte('`')
			}
			return
		}
	case "br":
		out.WriteByte('\n')
		return
	}

	isBlock := false
	switch tag {
	case "p", "div", "section", "article", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6",
		"li", "tr", "dt", "dd", "ul", "ol", "table", "header":
		isBlock = true
	}

	if isBlock {
		ensureBlankLine(out)
		if tag == "li" {
			out.WriteString("- ")
		}
	}
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		renderHTMLNode(c, out, insidePre)
	}
	if isBlock {
		ensureBlankLine(out)
	}
}

func findFirstElement(n *html.Node, tag string) *html.Node {
	if n.Type == html.ElementNode && strings.EqualFold(n.Data, tag) {
		return n
	}
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		if found := findFirstElement(c, tag); found != nil {
			return found
		}
	}
	return nil
}

func collectText(n *html.Node) string {
	var sb strings.Builder
	var walk func(*html.Node)
	walk = func(cur *html.Node) {
		if cur.Type == html.TextNode {
			sb.WriteString(cur.Data)
		}
		for c := cur.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(n)
	return sb.String()
}

func ensureBlankLine(out *strings.Builder) {
	s := out.String()
	if len(s) == 0 || strings.HasSuffix(s, "\n\n") {
		return
	}
	if strings.HasSuffix(s, "\n") {
		out.WriteByte('\n')
	} else {
		out.WriteString("\n\n")
	}
}

func collapseInline(s string) string {
	return strings.TrimSpace(horizWhitespaceRe.ReplaceAllString(strings.ReplaceAll(s, "\n", " "), " "))
}

func lookupZipEntry(entries map[string]*zip.File, p string) *zip.File {
	norm := normalizeZipPath(p)
	if f, ok := entries[norm]; ok {
		return f
	}
	return entries[strings.ReplaceAll(norm, "%20", " ")]
}

func normalizeZipPath(raw string) string {
	parts := strings.Split(strings.ReplaceAll(raw, "\\", "/"), "/")
	stack := make([]string, 0, len(parts))
	for _, part := range parts {
		if part == "" || part == "." {
			continue
		}
		if part == ".." {
			if len(stack) > 0 {
				stack = stack[:len(stack)-1]
			}
		} else {
			stack = append(stack, part)
		}
	}
	return strings.Join(stack, "/")
}

func countAlphanumeric(s string) int {
	n := 0
	for _, r := range s {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			n++
		}
	}
	return n
}
