package ai

import (
	"fmt"
	"hash/fnv"
	"math"
	"regexp"
	"strings"
	"unicode/utf8"

	"trace/backend-go/internal/model"
)

const (
	DefaultTopK                = 5
	DefaultSimilarityThreshold = 0.35
	MaxContextChars            = 3800
	DefaultTemperature         = 0.2
	DefaultMaxTokens           = 1024
	DefaultSystemPrompt        = "Answer from repo code only."
	GenericDefaultSystemPrompt = "Answer from indexed source content only."
	MaxSystemPromptChars       = 1200
)

type QueryTier string

const (
	TierTrivial  QueryTier = "TRIVIAL"
	TierSimple   QueryTier = "SIMPLE"
	TierStandard QueryTier = "STANDARD"
	TierDeep     QueryTier = "DEEP"
)

var trivialPhrases = map[string]struct{}{
	"hi": {}, "hello": {}, "hey": {}, "yo": {}, "sup": {}, "hola": {},
	"thanks": {}, "thank you": {}, "thx": {}, "ty": {},
	"ok": {}, "okay": {}, "cool": {}, "great": {}, "nice": {}, "got it": {}, "bye": {},
}

var (
	trailingPunctRe = regexp.MustCompile(`[!?.,]+$`)
	deepSignalRe    = regexp.MustCompile(`(?i)\b(architecture|end[- ]to[- ]end|walkthrough|step[- ]by[- ]step|in detail|detailed|deep dive|refactor|compare|comparison|all files|every file|entire codebase|full flow|lifecycle|bottleneck|bottlenecks|audit|design|explain how .* works|trace the|optimize|summarize the entire|comprehensive summary|all sections|key findings|methodology|pipeline|deployment flow|security audit|all resources|all stages)\b`)
	standardSigRe   = regexp.MustCompile(`(?i)\b(how does|how do|why does|why is|explain|implement|fix|debug|difference between|write|add|change|summarize|list|describe)\b`)
)

// ClassifyQuery implements TRACE's 0ms heuristic 4-tier query router.
func ClassifyQuery(question string) QueryTier {
	trimmed := strings.TrimSpace(question)
	if trimmed == "" {
		return TierSimple
	}
	norm := strings.Join(strings.Fields(strings.ToLower(trailingPunctRe.ReplaceAllString(trimmed, ""))), " ")
	if _, ok := trivialPhrases[norm]; ok {
		return TierTrivial
	}
	words := len(strings.Fields(norm))
	qMarks := strings.Count(trimmed, "?")
	if deepSignalRe.MatchString(trimmed) || words >= 26 || qMarks >= 2 {
		return TierDeep
	}
	if words <= 10 && !standardSigRe.MatchString(trimmed) {
		return TierSimple
	}
	if words <= 6 {
		return TierSimple
	}
	return TierStandard
}

// GenerationConfig holds server-clamped per-request LLM and RAG knobs.
type GenerationConfig struct {
	Temperature         float64
	MaxTokens           int
	TopK                int
	SimilarityThreshold float64
	SystemPrompt        string
	CustomMaxTokens     bool
	CustomTopK          bool
}

func ParseGenerationConfig(req model.ChatMessageRequest) GenerationConfig {
	temp := clampFloat(req.Temperature, DefaultTemperature, 0.0, 1.0)
	tokens := clampInt(req.MaxTokens, DefaultMaxTokens, 256, 4096)
	topK := clampInt(req.TopK, DefaultTopK, 1, 10)
	thresh := clampFloat(req.SimilarityThreshold, DefaultSimilarityThreshold, 0.0, 1.0)

	prompt := DefaultSystemPrompt
	if req.SystemPrompt != nil {
		if trimmed := strings.TrimSpace(*req.SystemPrompt); trimmed != "" {
			prompt = truncateUTF8String(trimmed, MaxSystemPromptChars)
		}
	}

	return GenerationConfig{
		Temperature:         temp,
		MaxTokens:           tokens,
		TopK:                topK,
		SimilarityThreshold: thresh,
		SystemPrompt:        prompt,
		CustomMaxTokens:     req.MaxTokens != nil && tokens != DefaultMaxTokens,
		CustomTopK:          req.TopK != nil && topK != DefaultTopK,
	}
}

func (c GenerationConfig) CacheKeySegment() string {
	h := fnv.New32a()
	_, _ = h.Write([]byte(c.SystemPrompt))
	return fmt.Sprintf("t=%.2f|m=%d|k=%d|s=%.2f|p=%x", c.Temperature, c.MaxTokens, c.TopK, c.SimilarityThreshold, h.Sum32())
}

func IsDefaultPromptString(prompt string) bool {
	trimmed := strings.TrimSpace(prompt)
	return trimmed == "" ||
		strings.EqualFold(trimmed, DefaultSystemPrompt) ||
		strings.EqualFold(trimmed, GenericDefaultSystemPrompt)
}

func BuildSystemPrompt(sourceName string, st model.SourceType, tier QueryTier, customPrompt string) string {
	effectiveType := st.Effective()
	var base string
	switch effectiveType {
	case model.SourcePDF:
		base = buildDocPrompt(fmt.Sprintf(`document analyst for the PDF "%s"`, sourceName), "exact page numbers (e.g., Page 4) and section headings", tier)
	case model.SourceEPUB:
		base = buildDocPrompt(fmt.Sprintf(`technical book analyst for the EPUB "%s"`, sourceName), "exact chapter numbers (e.g., Chapter 3) and section headings", tier)
	case model.SourceNotebook:
		base = buildDocPrompt(fmt.Sprintf(`technical analyst for the Jupyter Notebook "%s"`, sourceName), "exact cell numbers (e.g., Cell 7) and section headings", tier)
	case model.SourceIAC:
		base = buildDocPrompt(fmt.Sprintf(`infrastructure & DevOps analyst for the configuration "%s"`, sourceName), `exact block signatures and line numbers (e.g., Block: resource "aws_ecs_service" "worker" (Line 42))`, tier)
	default:
		base = buildRepoPrompt(sourceName, tier)
	}

	isDefault := IsDefaultPromptString(customPrompt)
	directive := strings.TrimSpace(customPrompt)
	if directive == "" {
		directive = GenericDefaultSystemPrompt
	}

	if tier == TierTrivial {
		if isDefault {
			return base
		}
		return base + "\nUSER INSTRUCTION: " + directive + "\n"
	}

	if isDefault {
		switch effectiveType {
		case model.SourcePDF:
			return base + "\nGROUNDING RULE: Answer strictly from the indexed document content. If the retrieved passages do not contain the answer, state clearly that it is not present in the indexed PDF rather than guessing.\n"
		case model.SourceEPUB:
			return base + "\nGROUNDING RULE: Answer strictly from the indexed book chapters. If the retrieved chapters do not contain the answer, state clearly that it is not present in the indexed EPUB rather than guessing.\n"
		case model.SourceNotebook:
			return base + "\nGROUNDING RULE: Answer strictly from the indexed notebook cells. If the retrieved cells do not contain the answer, state clearly that it is not present in the indexed notebook rather than guessing.\n"
		case model.SourceIAC:
			return base + "\nGROUNDING RULE: Answer strictly from the indexed infrastructure configuration. If the retrieved blocks do not contain the answer, state clearly that it is not present in the indexed config rather than guessing.\n"
		default:
			return base + "\nGROUNDING RULE: Answer strictly from the indexed source content. If the retrieved code context does not contain the answer, state clearly that it is not present in the indexed repository rather than guessing.\n"
		}
	}

	reminder := "cite file paths and line ranges"
	switch effectiveType {
	case model.SourcePDF:
		reminder = "cite page numbers (e.g., Page 4) and section headings"
	case model.SourceEPUB:
		reminder = "cite chapter numbers (e.g., Chapter 3) and section headings"
	case model.SourceNotebook:
		reminder = "cite cell numbers (e.g., Cell 5) and section headings"
	case model.SourceIAC:
		reminder = "cite block names and line numbers (e.g., Block: ... (Line 12))"
	}
	return base + "\nUSER INSTRUCTION (prioritize this tone, framing, and focus): " + directive +
		"\nGround claims in the provided indexed context when available, and " + reminder + ".\n"
}

func BuildUserPrompt(contextText, question string, st model.SourceType) string {
	label := "Code context:"
	switch st.Effective() {
	case model.SourcePDF:
		label = "Document context:"
	case model.SourceEPUB:
		label = "Book context:"
	case model.SourceNotebook:
		label = "Notebook context:"
	case model.SourceIAC:
		label = "Infrastructure config context:"
	}
	return fmt.Sprintf("%s\n%s\n\nUser question:\n%s\n", label, contextText, question)
}

func EmptyMatchPrompt(question string, st model.SourceType) string {
	switch st.Effective() {
	case model.SourcePDF:
		return "No relevant document passages matched the current similarity threshold.\n\nUser question:\n" + question
	case model.SourceEPUB:
		return "No relevant book chapters matched the current similarity threshold.\n\nUser question:\n" + question
	case model.SourceNotebook:
		return "No relevant notebook cells matched the current similarity threshold.\n\nUser question:\n" + question
	case model.SourceIAC:
		return "No relevant infrastructure blocks matched the current similarity threshold.\n\nUser question:\n" + question
	default:
		return "No relevant code chunks matched the current similarity threshold.\n\nUser question:\n" + question
	}
}

func buildRepoPrompt(repoName string, tier QueryTier) string {
	switch tier {
	case TierTrivial:
		return fmt.Sprintf("You are TRACE, a concise technical assistant for the %s codebase.\nReply in 1 brief sentence. Do not invent code details.\n", repoName)
	case TierSimple:
		return fmt.Sprintf("You are TRACE, a concise technical assistant for the %s codebase.\nRESPONSE STYLE: Answer directly in 1 to 3 short sentences of plain prose.\nDo NOT use markdown headings, multi-section templates, or bullet lists unless explicitly requested.\nCite exact file paths and line ranges inline when referencing code.\n", repoName)
	case TierDeep:
		return fmt.Sprintf("You are TRACE, an expert technical assistant for the %s codebase.\nRESPONSE STYLE: Provide a clear, structured technical breakdown with concise headings or numbered steps.\nCite exact file paths and line ranges throughout. Keep every point concrete and free of filler.\n", repoName)
	default:
		return fmt.Sprintf("You are TRACE, a concise technical assistant for the %s codebase.\nRESPONSE STYLE: Match length to the question—use a short paragraph or 3 to 5 tight bullets.\nAvoid filler introductions, redundant summaries, and unnecessary headings.\nCite exact file paths and line ranges inline. Include code only when directly helpful.\n", repoName)
	}
}

func buildDocPrompt(roleDesc, citationRule string, tier QueryTier) string {
	switch tier {
	case TierTrivial:
		return fmt.Sprintf("You are TRACE, a concise %s.\nReply in 1 brief sentence. Do not invent details.\n", roleDesc)
	case TierSimple:
		return fmt.Sprintf("You are TRACE, a concise %s.\nRESPONSE STYLE: Answer directly in 1 to 3 short sentences of plain prose.\nDo NOT use markdown headings, multi-section templates, or bullet lists unless explicitly requested.\nCite %s inline when referencing facts.\n", roleDesc, citationRule)
	case TierDeep:
		return fmt.Sprintf("You are TRACE, an expert %s.\nRESPONSE STYLE: Provide a clear, structured technical breakdown with concise headings or numbered points.\nCite %s throughout. Keep every point concrete and free of filler.\n", roleDesc, citationRule)
	default:
		return fmt.Sprintf("You are TRACE, a concise %s.\nRESPONSE STYLE: Match length to the question—use a short paragraph or 3 to 5 tight bullets.\nAvoid filler introductions, redundant summaries, and unnecessary headings.\nCite %s inline for every key claim.\n", roleDesc, citationRule)
	}
}

// AssembleContext builds the retrieved context string within maxChars and deduplicates citations.
func AssembleContext(hits []model.SearchHit, maxChars int) (string, []model.Citation) {
	if maxChars < 400 {
		maxChars = 400
	}
	const sep = "\n\n---\n\n"
	var sb strings.Builder
	citations := make([]model.Citation, 0, len(hits))
	seen := make(map[string]struct{}, len(hits))

	for _, hit := range hits {
		text := hit.Content
		if strings.TrimSpace(text) == "" {
			continue
		}
		proj := sb.Len() + len(text)
		if sb.Len() > 0 {
			proj += len(sep)
		}
		if proj > maxChars {
			if len(citations) == 0 {
				sb.WriteString(truncateUTF8String(text, maxChars))
				citations = append(citations, hit.Citation)
			}
			break
		}
		if sb.Len() > 0 {
			sb.WriteString(sep)
		}
		sb.WriteString(text)
		ck := citationDedupKey(hit.Citation)
		if _, dup := seen[ck]; !dup {
			seen[ck] = struct{}{}
			citations = append(citations, hit.Citation)
		}
	}
	if sb.Len() == 0 {
		return "(no matching code chunks found)", []model.Citation{}
	}
	return sb.String(), citations
}

func citationDedupKey(c model.Citation) string {
	return fmt.Sprintf("%s|%v|%v|%v|%v|%v", c.FilePath, derefInt(c.StartLine), derefInt(c.EndLine), derefInt(c.PageNumber), derefStr(c.SectionHeading), derefInt(c.ChunkIndex))
}

func derefInt(p *int) int {
	if p == nil {
		return -1
	}
	return *p
}

func derefStr(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func clampFloat(val *float64, fallback, minV, maxV float64) float64 {
	if val == nil || math.IsNaN(*val) || math.IsInf(*val, 0) {
		return fallback
	}
	v := math.Max(minV, math.Min(maxV, *val))
	return math.Round(v*100) / 100
}

func clampInt(val *int, fallback, minV, maxV int) int {
	if val == nil {
		return fallback
	}
	if *val < minV {
		return minV
	}
	if *val > maxV {
		return maxV
	}
	return *val
}

func truncateUTF8String(s string, maxBytes int) string {
	if len(s) <= maxBytes {
		return s
	}
	end := maxBytes
	for end > 0 && !utf8.RuneStart(s[end]) {
		end--
	}
	return s[:end]
}
