package ingestion

import (
	"archive/zip"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/google/uuid"

	"trace/backend-go/internal/model"
)

func TestCodeFileFilterIncludesGithubWorkflows(t *testing.T) {
	if !IsEligibleCodeFile(".github/workflows/ci.yml", 2048, 102400) {
		t.Fatal("expected .github/workflows/ci.yml to be eligible")
	}
	if IsEligibleCodeFile(".git/config", 512, 102400) {
		t.Fatal("expected .git/config to be skipped")
	}
	if IsEligibleCodeFile("node_modules/pkg/index.js", 512, 102400) {
		t.Fatal("expected node_modules file to be skipped")
	}
	if IsEligibleCodeFile("src/app.min.js", 512, 102400) {
		t.Fatal("expected minified js to be skipped")
	}
	if !IsEligibleCodeFile("Dockerfile", 400, 102400) {
		t.Fatal("expected Dockerfile to be eligible")
	}
}

func TestCodeChunkerTracksLinesAndOverlap(t *testing.T) {
	var sb strings.Builder
	for i := 1; i <= 100; i++ {
		sb.WriteString("func handlerLine() { return true } // line padding content here\n")
	}
	chunks := ChunkCodeFile(uuid.New(), uuid.NewString(), "internal/app.go", sb.String(), 600)
	if len(chunks) < 2 {
		t.Fatalf("expected multiple chunks, got %d", len(chunks))
	}
	if !strings.HasPrefix(chunks[0].Content, "// File: internal/app.go\n") {
		t.Fatalf("unexpected chunk header: %q", chunks[0].Content[:30])
	}
	if chunks[0].Metadata["startLine"] != 1 {
		t.Fatalf("expected startLine=1, got %v", chunks[0].Metadata["startLine"])
	}
}

func TestCodeChunkerPreservesValidUTF8WithEmojis(t *testing.T) {
	// Multibyte 4-byte emojis (0xf0 0x9f ...) across overlap and hard-slice boundaries
	longEmojiLine := strings.Repeat("🚀✨🔥globby", 120)
	multiLine := strings.Repeat("// Rocket launch 🚀 status check ✅\n", 80) + longEmojiLine + "\n"

	chunks := ChunkCodeFile(uuid.New(), uuid.NewString(), "readme.md", multiLine, 250)
	if len(chunks) < 3 {
		t.Fatalf("expected >= 3 chunks, got %d", len(chunks))
	}
	for i, c := range chunks {
		if !utf8.ValidString(c.Content) {
			t.Fatalf("chunk %d contains invalid UTF-8 byte sequence", i)
		}
	}

	semChunks := ChunkSections(uuid.New(), uuid.NewString(), model.SourcePDF, "doc.pdf", []ExtractedSection{
		{SectionHeading: "Intro 🚀", UnitNumber: 1, Content: multiLine},
	}, 300)
	for i, c := range semChunks {
		if !utf8.ValidString(c.Content) {
			t.Fatalf("semantic chunk %d contains invalid UTF-8 byte sequence", i)
		}
	}
}

func TestNotebookExtractorSkipsBase64OutputsAndPairsCells(t *testing.T) {
	tmp := filepath.Join(t.TempDir(), "analysis.ipynb")
	hugePlot := strings.Repeat("A", 50000)
	raw := `{
		"metadata": {"kernelspec": {"language": "python"}},
		"cells": [
			{"cell_type": "markdown", "source": ["# Data Cleaning\n", "Drop nulls before training."]},
			{"cell_type": "code", "source": ["df = df.dropna()\n", "print(len(df))"], "outputs": [{"data": {"image/png": "` + hugePlot + `"}}]}
		]
	}`
	if err := os.WriteFile(tmp, []byte(raw), 0o600); err != nil {
		t.Fatal(err)
	}

	sections, err := (&NotebookExtractor{}).Extract(context.Background(), tmp, "analysis.ipynb")
	if err != nil {
		t.Fatalf("extract failed: %v", err)
	}
	if len(sections) != 1 {
		t.Fatalf("expected 1 paired section, got %d", len(sections))
	}
	if sections[0].SectionHeading != "Data Cleaning" {
		t.Fatalf("expected heading 'Data Cleaning', got %q", sections[0].SectionHeading)
	}
	if sections[0].UnitNumber != 2 {
		t.Fatalf("expected code cell unit 2, got %d", sections[0].UnitNumber)
	}
	if strings.Contains(sections[0].Content, "AAAA") {
		t.Fatal("base64 plot output leaked into extracted content")
	}
	if !strings.Contains(sections[0].Content, "```python") {
		t.Fatal("expected python code fence in paired cell")
	}
}

func TestIACExtractorTerraformDockerfileYAML(t *testing.T) {
	tf := "# Primary VPC\nresource \"aws_vpc\" \"main\" {\n  cidr_block = \"10.0.0.0/16\"\n}\n\nvariable \"env\" {\n  default = \"prod\"\n}\n"
	tfSections := ExtractIACFromString(tf, "main.tf")
	if len(tfSections) != 2 {
		t.Fatalf("expected 2 terraform blocks, got %d", len(tfSections))
	}
	if !strings.Contains(tfSections[0].SectionHeading, `resource "aws_vpc" "main"`) {
		t.Fatalf("unexpected HCL heading: %q", tfSections[0].SectionHeading)
	}

	dockerfile := "FROM golang:1.23-alpine AS build\nRUN go build\n\nFROM alpine:3.21\nCOPY --from=build /app /app\n"
	dfSections := ExtractIACFromString(dockerfile, "Dockerfile")
	if len(dfSections) != 2 || dfSections[0].SectionHeading != "Stage: build" {
		t.Fatalf("unexpected dockerfile sections: %+v", dfSections)
	}

	ci := "name: CI\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n  deploy:\n    needs: test\n"
	ciSections := ExtractIACFromString(ci, "ci.yml")
	if len(ciSections) != 3 || ciSections[1].SectionHeading != "job: test" || ciSections[2].SectionHeading != "job: deploy" {
		t.Fatalf("unexpected CI sections: %+v", ciSections)
	}
}

func TestEPUBExtractorValidAndDRMRejection(t *testing.T) {
	validPath := filepath.Join(t.TempDir(), "spec.epub")
	buildTestEPUB(t, validPath, false)

	sections, err := (&EPUBExtractor{}).Extract(context.Background(), validPath, "spec.epub")
	if err != nil {
		t.Fatalf("valid epub failed: %v", err)
	}
	if len(sections) != 1 || sections[0].SectionHeading != "Distributed Consensus" {
		t.Fatalf("unexpected epub sections: %+v", sections)
	}
	chunks := ChunkSections(uuid.New(), uuid.NewString(), model.SourceEPUB, "spec.epub", sections, 1500)
	if len(chunks) == 0 || !strings.HasPrefix(chunks[0].Content, "[Book: spec.epub | Chapter 1") {
		t.Fatalf("unexpected epub chunk: %+v", chunks)
	}

	drmPath := filepath.Join(t.TempDir(), "drm.epub")
	buildTestEPUB(t, drmPath, true)
	if _, err := (&EPUBExtractor{}).Extract(context.Background(), drmPath, "drm.epub"); err == nil || !strings.Contains(err.Error(), "DRM") {
		t.Fatalf("expected DRM rejection error, got %v", err)
	}
}

func buildTestEPUB(t *testing.T, dest string, encrypted bool) {
	t.Helper()
	f, err := os.Create(dest)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()

	zw := zip.NewWriter(f)
	add := func(name, content string) {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = w.Write([]byte(content))
	}
	add("META-INF/container.xml", `<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>`)
	add("OEBPS/content.opf", `<?xml version="1.0"?><package><manifest><item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="ch1"/></spine></package>`)
	add("OEBPS/ch1.xhtml", `<html><body><h1>Distributed Consensus</h1><p>Raft decomposes consensus into leader election, log replication, and safety guarantees across fault-tolerant clusters.</p><pre>func vote() {}</pre></body></html>`)
	if encrypted {
		add("META-INF/encryption.xml", `<encryption><EncryptedData><CipherData><CipherReference URI="OEBPS/ch1.xhtml"/></CipherData></EncryptedData></encryption>`)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
}
