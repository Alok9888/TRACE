package ingestion

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime/multipart"
	"os"
	"path"
	"strings"
	"sync/atomic"
	"time"
	"unicode"

	"github.com/google/uuid"
	"golang.org/x/sync/errgroup"

	"trace/backend-go/internal/embedding"
	"trace/backend-go/internal/model"
	"trace/backend-go/internal/store"
)

var (
	pdfMagic = []byte("%PDF-")
	zipMagic = []byte{'P', 'K', 0x03, 0x04}
)

// FileIngestor implements TRACE's 3-tier upload pipeline:
// 1. Sync intake: size/format validation, 8KB streaming SHA-256 to temp file, magic-byte check,
//    per-workspace READY deduplication, Repository row creation -> 202 Accepted (or 200 on dedup hit).
// 2. Async extraction & recursive semantic chunking (bounded to 4 concurrent jobs).
// 3. Bounded-parallel 64-chunk embedding & PgVector batch insert (3 concurrent batches).
type FileIngestor struct {
	repos       *store.RepoStore
	vectors     *store.VectorStore
	embedder    embedding.Embedder
	extractors  []DocumentExtractor
	maxBytes    int64
	semChunkSz  int
	onReady     func(sourceID uuid.UUID)
	jobSem      chan struct{}
}

func NewFileIngestor(
	repos *store.RepoStore,
	vectors *store.VectorStore,
	embedder embedding.Embedder,
	maxBytes int64,
	semChunkSz int,
	onReady func(sourceID uuid.UUID),
) *FileIngestor {
	return &FileIngestor{
		repos:      repos,
		vectors:    vectors,
		embedder:   embedder,
		extractors: DefaultExtractors(),
		maxBytes:   maxBytes,
		semChunkSz: semChunkSz,
		onReady:    onReady,
		jobSem:     make(chan struct{}, 4),
	}
}

func (f *FileIngestor) Ingest(ctx context.Context, workspaceID uuid.UUID, header *multipart.FileHeader) (model.Repository, error) {
	if header == nil || header.Size == 0 {
		return model.Repository{}, errors.New("please select a non-empty file to upload")
	}
	if header.Size > f.maxBytes {
		return model.Repository{}, errors.New("file exceeds the 20 MB upload size limit")
	}

	contentType := header.Header.Get("Content-Type")
	extractor, err := f.resolveExtractor(header.Filename, contentType)
	if err != nil {
		return model.Repository{}, err
	}
	sourceType := extractor.SourceType()
	cleanName := sanitizeUploadFileName(header.Filename, sourceType)

	srcFile, err := header.Open()
	if err != nil {
		return model.Repository{}, errors.New("could not read uploaded file")
	}
	defer srcFile.Close()

	tmp, err := os.CreateTemp("", "trace-upload-*.tmp")
	if err != nil {
		return model.Repository{}, errors.New("could not buffer uploaded file")
	}
	tmpPath := tmp.Name()
	cleanupTmp := true
	defer func() {
		if cleanupTmp {
			_ = os.Remove(tmpPath)
		}
	}()

	exactSize, shaHex, err := copyHashAndValidateMagic(srcFile, tmp, f.maxBytes, sourceType)
	_ = tmp.Close()
	if err != nil {
		return model.Repository{}, err
	}

	// Single-pass SHA-256 deduplication per workspace
	if existing, err := f.repos.FindReadyByDedup(ctx, workspaceID, shaHex, sourceType); err == nil {
		return existing, nil
	}

	lang := languageLabelFor(sourceType, cleanName)
	desc := formatFileDescription(sourceType, exactSize, 0)
	storageKey := strings.ToLower(string(sourceType)) + ":" + shaHex[:min(24, len(shaHex))]
	stage := "fetching"
	detail := initialStageDetail(sourceType)

	source := model.Repository{
		ID:             uuid.New(),
		UserID:         workspaceID,
		SourceType:     sourceType,
		GithubRepoID:   randomSyntheticID(),
		Owner:          string(sourceType),
		Name:           stripExt(cleanName),
		FullName:       cleanName,
		IsPrivate:      true,
		DefaultBranch:  "document",
		Language:       &lang,
		Description:    &desc,
		FileName:       &cleanName,
		FileSizeBytes:  &exactSize,
		StorageKey:     &storageKey,
		TreeSHA:        &shaHex,
		IndexStatus:    model.StatusIndexing,
		IndexingStage:  &stage,
		IndexingDetail: &detail,
	}
	if err := f.repos.Insert(ctx, &source); err != nil {
		return model.Repository{}, err
	}

	cleanupTmp = false // ownership transfers to async goroutine
	go f.processAsync(source.ID, workspaceID, extractor, sourceType, cleanName, exactSize, tmpPath)
	return source, nil
}

func (f *FileIngestor) processAsync(
	sourceID, workspaceID uuid.UUID,
	extractor DocumentExtractor,
	sourceType model.SourceType,
	fileName string,
	fileSize int64,
	tmpPath string,
) {
	f.jobSem <- struct{}{}
	defer func() {
		<-f.jobSem
		_ = os.Remove(tmpPath)
	}()

	ctx := context.Background()
	start := time.Now()
	_ = f.repos.UpdateProgress(ctx, sourceID, "fetching", initialStageDetail(sourceType), 0, 0, 0, 0)

	sections, err := extractor.Extract(ctx, tmpPath, fileName)
	if err != nil {
		_ = f.repos.MarkFailed(ctx, sourceID, err.Error())
		return
	}
	if len(sections) == 0 {
		_ = f.repos.MarkFailed(ctx, sourceID, "no extractable content was found in "+fileName)
		return
	}

	unitCount := len(sections)
	_ = f.repos.UpdateProgress(ctx, sourceID, "chunking",
		fmt.Sprintf("Segmenting %d %s into semantic chunks...", unitCount, unitNoun(sourceType, unitCount)),
		unitCount, unitCount, 0, 0)

	chunks := ChunkSections(workspaceID, sourceID.String(), sourceType, fileName, sections, f.semChunkSz)
	if len(chunks) == 0 {
		_ = f.repos.MarkFailed(ctx, sourceID, "no indexable text segments could be extracted from "+fileName)
		return
	}

	_ = f.repos.UpdateProgress(ctx, sourceID, "embedding",
		fmt.Sprintf("Embedding %d chunks...", len(chunks)),
		unitCount, unitCount, 0, len(chunks))

	var embeddedCount atomic.Int64
	g, gctx := errgroup.WithContext(ctx)
	g.SetLimit(parallelEmbedBatches)

	for s := 0; s < len(chunks); s += vectorBatchSize {
		batch := chunks[s:min(s+vectorBatchSize, len(chunks))]
		g.Go(func() error {
			if err := persistChunkBatch(gctx, f.embedder, f.vectors, batch); err != nil {
				return err
			}
			done := int(embeddedCount.Add(int64(len(batch))))
			_ = f.repos.UpdateProgress(ctx, sourceID, "embedding",
				fmt.Sprintf("Embedded %d/%d chunks...", done, len(chunks)),
				unitCount, unitCount, done, len(chunks))
			return nil
		})
	}
	if err := g.Wait(); err != nil {
		slog.Error("file vector persistence failed", "sourceId", sourceID, "err", err)
		_ = f.repos.MarkFailed(ctx, sourceID, "Embedding batch failed while indexing "+fileName+". Please try again.")
		return
	}

	_ = f.repos.UpdateProgress(ctx, sourceID, "saving", "Finalizing vector index...",
		unitCount, unitCount, len(chunks), len(chunks))

	repo, err := f.repos.FindByID(ctx, sourceID)
	if err != nil {
		return
	}
	now := time.Now().UTC()
	desc := formatFileDescription(sourceType, fileSize, unitCount)
	doneStage := "done"
	doneDetail := "Indexing complete"
	repo.PageCount = &unitCount
	repo.FilesTotal = unitCount
	repo.FilesProcessed = unitCount
	repo.ChunkCount = len(chunks)
	repo.ChunksTotal = len(chunks)
	repo.ChunksProcessed = len(chunks)
	repo.Description = &desc
	repo.IndexedAt = &now
	repo.IndexStatus = model.StatusReady
	repo.IndexingStage = &doneStage
	repo.IndexingDetail = &doneDetail
	repo.ErrorMessage = nil

	if err := f.repos.Update(ctx, &repo); err != nil {
		_ = f.repos.MarkFailed(ctx, sourceID, err.Error())
		return
	}
	if f.onReady != nil {
		f.onReady(sourceID)
	}
	slog.Info("file ingestion complete", "sourceId", sourceID, "type", sourceType, "units", unitCount, "chunks", len(chunks), "ms", time.Since(start).Milliseconds())
}

func (f *FileIngestor) resolveExtractor(filename, contentType string) (DocumentExtractor, error) {
	for _, ex := range f.extractors {
		if ex.Supports(filename, contentType) {
			return ex, nil
		}
	}
	return nil, errors.New("unsupported file format. Supported formats: PDF (.pdf), Jupyter Notebook (.ipynb), EPUB (.epub), and IaC/CI configs (.tf, Dockerfile, .yml/.yaml)")
}

func copyHashAndValidateMagic(src io.Reader, dst io.Writer, maxBytes int64, st model.SourceType) (int64, string, error) {
	hasher := sha256.New()
	var header [16]byte
	headerLen := 0
	var total int64
	buf := make([]byte, 8192)

	for {
		n, readErr := src.Read(buf)
		if n > 0 {
			total += int64(n)
			if total > maxBytes {
				return 0, "", errors.New("file exceeds the 20 MB upload size limit")
			}
			if headerLen < len(header) {
				cp := min(n, len(header)-headerLen)
				copy(header[headerLen:], buf[:cp])
				headerLen += cp
			}
			_, _ = hasher.Write(buf[:n])
			if _, werr := dst.Write(buf[:n]); werr != nil {
				return 0, "", werr
			}
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			return 0, "", readErr
		}
	}

	if total == 0 {
		return 0, "", errors.New("uploaded file is empty")
	}
	head := header[:headerLen]
	switch st {
	case model.SourcePDF:
		if !bytes.HasPrefix(head, pdfMagic) {
			return 0, "", errors.New("uploaded file is not a valid PDF document (invalid PDF header)")
		}
	case model.SourceEPUB:
		if !bytes.HasPrefix(head, zipMagic) {
			return 0, "", errors.New("uploaded file is not a valid EPUB archive (invalid ZIP header)")
		}
	case model.SourceNotebook:
		if !startsWithJSONObject(head) {
			return 0, "", errors.New("uploaded file is not a valid Jupyter Notebook (.ipynb JSON expected)")
		}
	}
	return total, hex.EncodeToString(hasher.Sum(nil)), nil
}

func startsWithJSONObject(head []byte) bool {
	i := 0
	if len(head) >= 3 && head[0] == 0xEF && head[1] == 0xBB && head[2] == 0xBF {
		i = 3
	}
	for i < len(head) && unicode.IsSpace(rune(head[i])) {
		i++
	}
	return i < len(head) && head[i] == '{'
}

func randomSyntheticID() int64 {
	u := uuid.New()
	return int64(binary.BigEndian.Uint64(u[:8])) | (-1 << 63)
}

func sanitizeUploadFileName(raw string, st model.SourceType) string {
	if strings.TrimSpace(raw) == "" {
		switch st {
		case model.SourcePDF:
			return "document.pdf"
		case model.SourceNotebook:
			return "notebook.ipynb"
		case model.SourceEPUB:
			return "book.epub"
		case model.SourceIAC:
			return "config.tf"
		default:
			return "document.txt"
		}
	}
	base := path.Base(strings.ReplaceAll(raw, "\\", "/"))
	base = strings.TrimSpace(stripNulls(base))
	if base == "" || base == "." || base == "/" {
		return "document"
	}
	if len(base) > 240 {
		return base[:240]
	}
	return base
}

func stripExt(fileName string) string {
	if strings.EqualFold(fileName, "dockerfile") {
		return fileName
	}
	if dot := strings.LastIndexByte(fileName, '.'); dot > 0 {
		if s := strings.TrimSpace(fileName[:dot]); s != "" {
			if len(s) > 180 {
				return s[:180]
			}
			return s
		}
	}
	if len(fileName) > 180 {
		return fileName[:180]
	}
	return fileName
}

func languageLabelFor(st model.SourceType, fileName string) string {
	switch st {
	case model.SourcePDF:
		return "PDF"
	case model.SourceNotebook:
		return "Jupyter"
	case model.SourceEPUB:
		return "EPUB"
	case model.SourceIAC:
		lower := strings.ToLower(fileName)
		switch {
		case strings.HasSuffix(lower, ".tf"):
			return "Terraform"
		case strings.Contains(lower, "dockerfile"):
			return "Docker"
		case strings.Contains(lower, "compose"):
			return "Compose"
		default:
			return "YAML"
		}
	default:
		return "Document"
	}
}

func initialStageDetail(st model.SourceType) string {
	switch st {
	case model.SourcePDF:
		return "Extracting PDF pages..."
	case model.SourceNotebook:
		return "Streaming notebook cells (skipping binary outputs)..."
	case model.SourceIAC:
		return "Parsing infrastructure blocks..."
	case model.SourceEPUB:
		return "Extracting EPUB chapters in spine order..."
	default:
		return "Extracting document content..."
	}
}

func unitNoun(st model.SourceType, count int) string {
	switch st {
	case model.SourcePDF:
		if count == 1 {
			return "page"
		}
		return "pages"
	case model.SourceNotebook:
		if count == 1 {
			return "cell"
		}
		return "cells"
	case model.SourceIAC:
		if count == 1 {
			return "block"
		}
		return "blocks"
	case model.SourceEPUB:
		if count == 1 {
			return "chapter"
		}
		return "chapters"
	default:
		if count == 1 {
			return "section"
		}
		return "sections"
	}
}

func formatFileDescription(st model.SourceType, sizeBytes int64, units int) string {
	var sizeStr string
	if sizeBytes >= 1024*1024 {
		sizeStr = fmt.Sprintf("%.1f MB", float64(sizeBytes)/(1024*1024))
	} else {
		sizeStr = fmt.Sprintf("%d KB", max(int64(1), (sizeBytes+512)/1024))
	}
	label := "Document"
	switch st {
	case model.SourcePDF:
		label = "PDF document"
	case model.SourceNotebook:
		label = "Jupyter notebook"
	case model.SourceIAC:
		label = "IaC / CI config"
	case model.SourceEPUB:
		label = "EPUB book"
	}
	if units > 0 {
		return fmt.Sprintf("%s · %d %s · %s", label, units, unitNoun(st, units), sizeStr)
	}
	return label + " · " + sizeStr
}
