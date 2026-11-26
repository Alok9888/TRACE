package ai

import (
	"strings"
	"testing"

	"trace/backend-go/internal/model"
)

func TestClassifyQueryTiers(t *testing.T) {
	cases := []struct {
		q    string
		want QueryTier
	}{
		{"hello!", TierTrivial},
		{"Thanks.", TierTrivial},
		{"what port?", TierSimple},
		{"where is cors configured", TierSimple},
		{"how does the vector search filter work in this repository", TierStandard},
		{"walkthrough the entire architecture end-to-end", TierDeep},
		{"What does X do? And how does Y fail?", TierDeep},
	}
	for _, tc := range cases {
		if got := ClassifyQuery(tc.q); got != tc.want {
			t.Errorf("ClassifyQuery(%q) = %s, want %s", tc.q, got, tc.want)
		}
	}
}

func TestParseGenerationConfigClamping(t *testing.T) {
	hiTemp := 9.5
	lowTok := 10
	hiK := 99
	negThresh := -0.5
	cfg := ParseGenerationConfig(model.ChatMessageRequest{
		Temperature:         &hiTemp,
		MaxTokens:           &lowTok,
		TopK:                &hiK,
		SimilarityThreshold: &negThresh,
	})
	if cfg.Temperature != 1.0 || cfg.MaxTokens != 256 || cfg.TopK != 10 || cfg.SimilarityThreshold != 0.0 {
		t.Fatalf("unexpected clamped config: %+v", cfg)
	}
}

func TestAssembleContextBudgetAndDedup(t *testing.T) {
	line1 := 1
	hits := []model.SearchHit{
		{Content: strings.Repeat("a", 300), Citation: model.Citation{FilePath: "a.go", StartLine: &line1}},
		{Content: strings.Repeat("b", 300), Citation: model.Citation{FilePath: "a.go", StartLine: &line1}}, // duplicate citation
		{Content: strings.Repeat("c", 500), Citation: model.Citation{FilePath: "c.go", StartLine: &line1}}, // exceeds 700 budget
	}
	ctxText, cits := AssembleContext(hits, 700)
	if !strings.Contains(ctxText, "aaa") || !strings.Contains(ctxText, "bbb") || strings.Contains(ctxText, "ccc") {
		t.Fatalf("unexpected context budget output: len=%d", len(ctxText))
	}
	if len(cits) != 1 {
		t.Fatalf("expected deduplicated 1 citation, got %d", len(cits))
	}
}
