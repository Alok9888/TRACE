package ingestion

import (
	"fmt"
	"regexp"
	"strings"
	"unicode"

	"github.com/google/uuid"

	"trace/backend-go/internal/model"
)

// ExtractedSection represents one semantic unit from PDF, EPUB, Notebook, or IaC files.
type ExtractedSection struct {
	SectionHeading string
	UnitNumber     int // 1-based page, chapter, cell, or start line
	Content        string
}

var (
	paragraphSplitRe = regexp.MustCompile(`\n{2,}`)
	sentenceEndRe    = regexp.MustCompile(`([.!?])\s+([A-Z0-9("'])`)
)

// ChunkSections recursively splits each ExtractedSection (\n\n -> \n -> sentences -> words)
// up to ~1500 chars with ~11% overlap without crossing section boundaries.
func ChunkSections(
	userID uuid.UUID,
	sourceID string,
	sourceType model.SourceType,
	fileName string,
	sections []ExtractedSection,
	maxChunkChars int,
) []model.VectorChunk {
	if len(sections) == 0 {
		return nil
	}
	if maxChunkChars < 300 {
		maxChunkChars = 300
	}
	overlapChars := maxChunkChars / 9 // ~11%
	effectiveType := sourceType.Effective()
	cleanFile := stripNulls(fileName)
	cleanSource := stripNulls(sourceID)
	userIDStr := userID.String()
	langTag := languageTagFor(effectiveType, cleanFile)

	var out []model.VectorChunk
	chunkIdx := 0

	for _, sec := range sections {
		cleanContent := strings.TrimSpace(stripNulls(sec.Content))
		if cleanContent == "" {
			continue
		}
		heading := strings.TrimSpace(stripNulls(sec.SectionHeading))
		unitNum := max(1, sec.UnitNumber)

		pieces := splitRecursively(cleanContent, maxChunkChars)
		prevPiece := ""
		for _, piece := range pieces {
			if strings.TrimSpace(piece) == "" {
				continue
			}
			body := piece
			if prevPiece != "" && overlapChars > 0 {
				if ov := extractTailOverlap(prevPiece, overlapChars); ov != "" {
					body = ov + "\n" + piece
				}
			}
			prevPiece = piece

			header := buildSectionHeader(effectiveType, cleanFile, unitNum, heading)
			meta := map[string]any{
				"repoId":     cleanSource,
				"userId":     userIDStr,
				"sourceType": string(effectiveType),
				"filePath":   cleanFile,
				"language":   langTag,
				"pageNumber": unitNum,
				"chunkIndex": chunkIdx,
			}
			if effectiveType == model.SourceIAC {
				meta["startLine"] = unitNum
			}
			if heading != "" {
				meta["sectionHeading"] = heading
			}

			out = append(out, model.VectorChunk{
				ID:       uuid.New(),
				Content:  header + body,
				Metadata: meta,
			})
			chunkIdx++
		}
	}
	return out
}

func buildSectionHeader(st model.SourceType, fileName string, unit int, heading string) string {
	var sb strings.Builder
	switch st {
	case model.SourceEPUB:
		fmt.Fprintf(&sb, "[Book: %s | Chapter %d", fileName, unit)
		if heading != "" {
			fmt.Fprintf(&sb, " | Section: %s", heading)
		}
	case model.SourceNotebook:
		fmt.Fprintf(&sb, "[Notebook: %s | Cell %d", fileName, unit)
		if heading != "" {
			fmt.Fprintf(&sb, " | Section: %s", heading)
		}
	case model.SourceIAC:
		fmt.Fprintf(&sb, "[Config: %s | Line %d", fileName, unit)
		if heading != "" {
			fmt.Fprintf(&sb, " | Block: %s", heading)
		}
	default:
		fmt.Fprintf(&sb, "[Document: %s | Page %d", fileName, unit)
		if heading != "" {
			fmt.Fprintf(&sb, " | Section: %s", heading)
		}
	}
	sb.WriteString("]\n")
	return sb.String()
}

func languageTagFor(st model.SourceType, fileName string) string {
	switch st {
	case model.SourcePDF:
		return "pdf"
	case model.SourceEPUB:
		return "epub"
	case model.SourceNotebook:
		return "ipynb"
	case model.SourceIAC:
		lower := strings.ToLower(fileName)
		switch {
		case strings.HasSuffix(lower, ".tf"):
			return "hcl"
		case strings.Contains(lower, "dockerfile"):
			return "dockerfile"
		case strings.HasSuffix(lower, ".yml") || strings.HasSuffix(lower, ".yaml"):
			return "yaml"
		default:
			return "iac"
		}
	default:
		return "text"
	}
}

func splitRecursively(text string, maxChars int) []string {
	if len(text) <= maxChars {
		return []string{text}
	}
	paras := paragraphSplitRe.Split(text, -1)
	var chunks []string
	var cur strings.Builder

	flush := func() {
		if s := strings.TrimSpace(cur.String()); s != "" {
			chunks = append(chunks, s)
		}
		cur.Reset()
	}

	for _, raw := range paras {
		p := strings.TrimSpace(raw)
		if p == "" {
			continue
		}
		if len(p) > maxChars {
			flush()
			chunks = append(chunks, splitByLines(p, maxChars)...)
			continue
		}
		sep := 0
		if cur.Len() > 0 {
			sep = 2
		}
		if cur.Len() > 0 && cur.Len()+sep+len(p) > maxChars {
			flush()
		}
		if cur.Len() > 0 {
			cur.WriteString("\n\n")
		}
		cur.WriteString(p)
	}
	flush()
	return chunks
}

func splitByLines(block string, maxChars int) []string {
	lines := strings.Split(block, "\n")
	if len(lines) <= 1 {
		return splitBySentencesOrWords(block, maxChars)
	}
	var chunks []string
	var cur strings.Builder

	flush := func() {
		if s := strings.TrimSpace(cur.String()); s != "" {
			chunks = append(chunks, s)
		}
		cur.Reset()
	}

	for _, line := range lines {
		if len(line) > maxChars {
			flush()
			chunks = append(chunks, splitBySentencesOrWords(line, maxChars)...)
			continue
		}
		sep := 0
		if cur.Len() > 0 {
			sep = 1
		}
		if cur.Len() > 0 && cur.Len()+sep+len(line) > maxChars {
			flush()
		}
		if cur.Len() > 0 {
			cur.WriteByte('\n')
		}
		cur.WriteString(line)
	}
	flush()
	return chunks
}

func splitBySentencesOrWords(paragraph string, maxChars int) []string {
	// Go RE2 lacks lookbehind, so mark sentence boundaries before splitting
	marked := sentenceEndRe.ReplaceAllString(paragraph, "$1\x1F$2")
	sentences := strings.Split(marked, "\x1F")

	var chunks []string
	var cur strings.Builder

	flush := func() {
		if s := strings.TrimSpace(cur.String()); s != "" {
			chunks = append(chunks, s)
		}
		cur.Reset()
	}

	for _, raw := range sentences {
		s := strings.TrimSpace(raw)
		if s == "" {
			continue
		}
		if len(s) > maxChars {
			flush()
			chunks = append(chunks, hardSliceWords(s, maxChars)...)
			continue
		}
		sep := 0
		if cur.Len() > 0 {
			sep = 1
		}
		if cur.Len() > 0 && cur.Len()+sep+len(s) > maxChars {
			flush()
		}
		if cur.Len() > 0 {
			cur.WriteByte(' ')
		}
		cur.WriteString(s)
	}
	flush()
	return chunks
}

func hardSliceWords(text string, maxChars int) []string {
	var slices []string
	start := 0
	for start < len(text) {
		end := retreatToRuneBoundary(text, start, min(len(text), start+maxChars))
		if end < len(text) {
			if sp := strings.LastIndexByte(text[:end], ' '); sp > start+maxChars/2 {
				end = sp
			}
		}
		if piece := strings.TrimSpace(text[start:end]); piece != "" {
			slices = append(slices, piece)
		}
		start = advanceToRuneStart(text, max(end, start+1))
		for start < len(text) && unicode.IsSpace(rune(text[start])) {
			start++
		}
	}
	return slices
}

func extractTailOverlap(prev string, targetChars int) string {
	if len(prev) <= 40 {
		return ""
	}
	start := advanceToRuneStart(prev, max(0, len(prev)-targetChars))
	if nl := strings.IndexByte(prev[start:], '\n'); nl >= 0 && start+nl+1 < len(prev) {
		start += nl + 1
	} else if sb := strings.Index(prev[start:], ". "); sb >= 0 && start+sb+2 < len(prev) {
		start += sb + 2
	} else if sp := strings.IndexByte(prev[start:], ' '); sp >= 0 && start+sp+1 < len(prev) {
		start += sp + 1
	}
	return strings.TrimSpace(prev[start:])
}
