package ingestion

import (
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"

	"trace/backend-go/internal/model"
)

type rawCodeChunk struct {
	text      string
	startLine int
	endLine   int
}

// ChunkCodeFile implements TRACE's fast single-pass line-boundary-aware code chunker
// (default 1600 chars, 10% newline-snapped overlap, exact 1-based startLine/endLine).
func ChunkCodeFile(userID uuid.UUID, repoID, filePath, content string, maxChunkChars int) []model.VectorChunk {
	if strings.TrimSpace(content) == "" {
		return nil
	}
	if maxChunkChars < 200 {
		maxChunkChars = 200
	}
	overlapChars := maxChunkChars / 10

	cleanContent := stripNulls(content)
	cleanPath := stripNulls(filePath)
	cleanRepo := stripNulls(repoID)
	lang := stripNulls(DetectLanguage(cleanPath))
	header := "// File: " + cleanPath + "\n"

	lines := splitLines(cleanContent)
	if len(lines) == 0 {
		return nil
	}

	raw := buildLineAwareChunks(lines, maxChunkChars)
	if len(raw) == 0 {
		return nil
	}

	out := make([]model.VectorChunk, 0, len(raw))
	userIDStr := userID.String()

	for i, cur := range raw {
		body := cur.text
		startLine := cur.startLine
		endLine := cur.endLine

		if i > 0 && overlapChars > 0 {
			prev := raw[i-1]
			if prev.text != "" {
				overlapStart := advanceToRuneStart(prev.text, max(0, len(prev.text)-overlapChars))
				if nl := strings.IndexByte(prev.text[overlapStart:], '\n'); nl >= 0 && overlapStart+nl+1 < len(prev.text) {
					overlapStart = overlapStart + nl + 1
				}
				overlap := prev.text[overlapStart:]
				startLine = max(1, prev.endLine-strings.Count(overlap, "\n"))
				body = overlap + "\n" + body
			}
		}

		out = append(out, model.VectorChunk{
			ID:      uuid.New(),
			Content: header + body,
			Metadata: map[string]any{
				"repoId":     cleanRepo,
				"userId":     userIDStr,
				"sourceType": string(model.SourceGitHub),
				"filePath":   cleanPath,
				"language":   lang,
				"chunkIndex": i,
				"startLine":  startLine,
				"endLine":    endLine,
			},
		})
	}
	return out
}

func buildLineAwareChunks(lines []string, maxChunkChars int) []rawCodeChunk {
	var chunks []rawCodeChunk
	var buf strings.Builder
	chunkStart := -1
	chunkEnd := -1

	flush := func() {
		if buf.Len() == 0 {
			return
		}
		text := buf.String()
		buf.Reset()
		if strings.TrimSpace(text) != "" {
			s := max(1, chunkStart)
			e := max(s, chunkEnd)
			chunks = append(chunks, rawCodeChunk{text: text, startLine: s, endLine: e})
		}
		chunkStart = -1
	}

	for idx, line := range lines {
		lineNum := idx + 1
		if len(line) > maxChunkChars {
			flush()
			for off := 0; off < len(line); {
				end := retreatToRuneBoundary(line, off, min(off+maxChunkChars, len(line)))
				piece := line[off:end]
				if strings.TrimSpace(piece) != "" {
					chunks = append(chunks, rawCodeChunk{text: piece, startLine: lineNum, endLine: lineNum})
				}
				off = end
			}
			continue
		}

		sep := 0
		if buf.Len() > 0 {
			sep = 1
		}
		if buf.Len() > 0 && buf.Len()+sep+len(line) > maxChunkChars {
			flush()
		}
		if chunkStart < 0 {
			chunkStart = lineNum
		} else {
			buf.WriteByte('\n')
		}
		buf.WriteString(line)
		chunkEnd = lineNum
	}
	flush()
	return chunks
}

func splitLines(content string) []string {
	normalized := strings.ReplaceAll(strings.ReplaceAll(content, "\r\n", "\n"), "\r", "\n")
	return strings.Split(normalized, "\n")
}

func stripNulls(s string) string {
	if strings.ContainsRune(s, '\x00') {
		s = strings.ReplaceAll(s, "\x00", "")
	}
	if !utf8.ValidString(s) {
		s = strings.ToValidUTF8(s, "")
	}
	return s
}

func advanceToRuneStart(s string, idx int) int {
	if idx <= 0 {
		return 0
	}
	if idx >= len(s) {
		return len(s)
	}
	for idx < len(s) && !utf8.RuneStart(s[idx]) {
		idx++
	}
	return idx
}

func retreatToRuneBoundary(s string, start, end int) int {
	if end >= len(s) {
		return len(s)
	}
	orig := end
	for end > start && !utf8.RuneStart(s[end]) {
		end--
	}
	if end == start {
		// Single multibyte rune wider than budget: advance past one full rune
		_, size := utf8.DecodeRuneInString(s[start:])
		return min(len(s), start+max(1, size))
	}
	_ = orig
	return end
}

func truncateUTF8(s string, maxBytes int) string {
	if len(s) <= maxBytes {
		return s
	}
	return s[:retreatToRuneBoundary(s, 0, maxBytes)]
}
