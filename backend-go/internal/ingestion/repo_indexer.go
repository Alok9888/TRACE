package ingestion

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"golang.org/x/sync/errgroup"

	"trace/backend-go/internal/embedding"
	gh "trace/backend-go/internal/github"
	"trace/backend-go/internal/model"
	"trace/backend-go/internal/store"
)

const (
	vectorBatchSize      = 64
	parallelEmbedBatches = 3
	zipballFileThreshold = 5
	parallelFetchWorkers = 8
	indexLockTimeout     = 15 * time.Minute
	statusUpdateThrottle = 1500 * time.Millisecond
)

type indexingLock struct {
	lastProgressAt atomic.Int64
	lastDBWriteAt  atomic.Int64
	lastStage      atomic.Value
}

type AnalyzeDecision struct {
	Repo        model.Repository
	ShouldStart bool
}

// RepoIndexer orchestrates GitHub repository analysis, incremental SHA-256 diffing,
// zipball/raw-CDN streaming, chunking, and bounded-parallel embedding persistence.
type RepoIndexer struct {
	repos        *store.RepoStore
	vectors      *store.VectorStore
	embedder     embedding.Embedder
	ghClient     *gh.Client
	maxFileBytes int64
	codeChunkSz  int
	semChunkSz   int
	onRepoReady  func(repoID uuid.UUID)

	jobSem        chan struct{} // concurrency limit = 4 (matches Java indexingExecutor)
	mu            sync.Mutex
	activeLocks   map[uuid.UUID]*indexingLock
	analyzeTasks  map[string]struct{}
	prepareLocker sync.Mutex
}

func NewRepoIndexer(
	repos *store.RepoStore,
	vectors *store.VectorStore,
	embedder embedding.Embedder,
	ghClient *gh.Client,
	maxFileBytes int64,
	codeChunkSz, semChunkSz int,
	onRepoReady func(repoID uuid.UUID),
) *RepoIndexer {
	return &RepoIndexer{
		repos:        repos,
		vectors:      vectors,
		embedder:     embedder,
		ghClient:     ghClient,
		maxFileBytes: maxFileBytes,
		codeChunkSz:  codeChunkSz,
		semChunkSz:   semChunkSz,
		onRepoReady:  onRepoReady,
		jobSem:       make(chan struct{}, 4),
		activeLocks:  make(map[uuid.UUID]*indexingLock),
		analyzeTasks: make(map[string]struct{}),
	}
}

func (idx *RepoIndexer) IsActive(repoID uuid.UUID) bool {
	idx.mu.Lock()
	defer idx.mu.Unlock()
	lock, ok := idx.activeLocks[repoID]
	if !ok {
		return false
	}
	if time.Since(time.UnixMilli(lock.lastProgressAt.Load())) > indexLockTimeout {
		delete(idx.activeLocks, repoID)
		return false
	}
	return true
}

func (idx *RepoIndexer) PrepareAnalyze(ctx context.Context, userID uuid.UUID, owner, name string, force bool) (AnalyzeDecision, error) {
	idx.prepareLocker.Lock()
	defer idx.prepareLocker.Unlock()

	existing, err := idx.repos.FindByUserAndOwnerName(ctx, userID, owner, name)
	if err == nil {
		if existing.IndexStatus == model.StatusReady && !force {
			return AnalyzeDecision{Repo: existing, ShouldStart: false}, nil
		}
		recent := time.Since(existing.UpdatedAt) < 10*time.Minute
		if existing.IndexStatus == model.StatusIndexing && (recent || idx.IsActive(existing.ID)) {
			return AnalyzeDecision{Repo: existing, ShouldStart: false}, nil
		}
		return AnalyzeDecision{Repo: existing, ShouldStart: true}, nil
	}
	if !errors.Is(err, store.ErrNotFound) {
		return AnalyzeDecision{}, err
	}

	stage := "creating"
	detail := "Creating repo row..."
	repo := model.Repository{
		ID:             uuid.New(),
		UserID:         userID,
		SourceType:     model.SourceGitHub,
		GithubRepoID:   placeholderGithubID(owner, name),
		Owner:          owner,
		Name:           name,
		FullName:       owner + "/" + name,
		DefaultBranch:  "main",
		IndexStatus:    model.StatusIndexing,
		IndexingStage:  &stage,
		IndexingDetail: &detail,
	}
	if err := idx.repos.Insert(ctx, &repo); err != nil {
		return AnalyzeDecision{}, err
	}
	return AnalyzeDecision{Repo: repo, ShouldStart: true}, nil
}

func (idx *RepoIndexer) AnalyzeAndIndexAsync(userID uuid.UUID, owner, name string, placeholderID uuid.UUID, force bool) {
	taskKey := fmt.Sprintf("%s:%s/%s", userID, strings.ToLower(owner), strings.ToLower(name))
	idx.mu.Lock()
	if _, running := idx.analyzeTasks[taskKey]; running {
		idx.mu.Unlock()
		return
	}
	idx.analyzeTasks[taskKey] = struct{}{}
	idx.mu.Unlock()

	go func() {
		defer func() {
			idx.mu.Lock()
			delete(idx.analyzeTasks, taskKey)
			idx.mu.Unlock()
		}()

		ctx := context.Background()
		meta, err := idx.ghClient.GetRepository(ctx, owner, name)
		if err != nil {
			slog.Error("github analyze failed", "owner", owner, "name", name, "err", err)
			_ = idx.repos.MarkFailed(ctx, placeholderID, err.Error())
			return
		}

		repo, err := idx.repos.FindByUserAndGithubID(ctx, userID, meta.ID)
		if errors.Is(err, store.ErrNotFound) {
			repo, err = idx.repos.FindByIDAndUser(ctx, placeholderID, userID)
		}
		if err != nil {
			slog.Error("load repo row failed", "err", err)
			return
		}

		repo.GithubRepoID = meta.ID
		repo.Owner = owner
		repo.Name = name
		if meta.FullName != "" {
			repo.FullName = meta.FullName
		}
		repo.IsPrivate = meta.Private
		repo.DefaultBranch = meta.DefaultBranch
		repo.Language = ptrIfNotEmpty(meta.Language)
		repo.HTMLURL = ptrIfNotEmpty(meta.HTMLURL)
		repo.Description = ptrIfNotEmpty(meta.Description)
		if force {
			repo.TreeSHA = nil
			repo.IndexedFilesJSON = nil
		}
		stage := "fetching"
		detail := "Fetching file list..."
		repo.IndexStatus = model.StatusIndexing
		repo.IndexingStage = &stage
		repo.IndexingDetail = &detail
		repo.FilesTotal, repo.FilesProcessed = 0, 0
		repo.ChunkCount, repo.ChunksTotal, repo.ChunksProcessed = 0, 0, 0
		repo.ErrorMessage = nil

		if err := idx.repos.Update(ctx, &repo); err != nil {
			slog.Error("update repo metadata failed", "err", err)
			return
		}
		if placeholderID != uuid.Nil && placeholderID != repo.ID {
			_ = idx.repos.DeleteByID(ctx, placeholderID)
		}

		idx.IndexAsync(repo.ID, userID, force)
	}()
}

func (idx *RepoIndexer) StartReindex(ctx context.Context, repoID, userID uuid.UUID) (model.Repository, error) {
	repo, err := idx.repos.FindByIDAndUser(ctx, repoID, userID)
	if err != nil {
		return repo, err
	}
	if repo.SourceType.Effective() != model.SourceGitHub {
		return repo, errors.New("uploaded files cannot be re-indexed from GitHub; upload a new file instead")
	}
	if idx.IsActive(repoID) || repo.IndexStatus == model.StatusIndexing {
		return repo, nil
	}

	stage := "fetching"
	detail := "Starting..."
	repo.IndexStatus = model.StatusIndexing
	repo.FilesProcessed, repo.FilesTotal = 0, 0
	repo.ChunkCount, repo.ChunksTotal, repo.ChunksProcessed = 0, 0, 0
	repo.IndexingStage = &stage
	repo.IndexingDetail = &detail
	repo.ErrorMessage = nil
	if err := idx.repos.Update(ctx, &repo); err != nil {
		return repo, err
	}
	idx.IndexAsync(repoID, userID, false)
	return repo, nil
}

func (idx *RepoIndexer) IndexAsync(repoID, userID uuid.UUID, force bool) {
	idx.mu.Lock()
	if existing, ok := idx.activeLocks[repoID]; ok && time.Since(time.UnixMilli(existing.lastProgressAt.Load())) <= indexLockTimeout {
		idx.mu.Unlock()
		return
	}
	lock := &indexingLock{}
	lock.lastProgressAt.Store(time.Now().UnixMilli())
	lock.lastStage.Store("")
	idx.activeLocks[repoID] = lock
	idx.mu.Unlock()

	go func() {
		idx.jobSem <- struct{}{}
		defer func() {
			<-idx.jobSem
			idx.mu.Lock()
			if idx.activeLocks[repoID] == lock {
				delete(idx.activeLocks, repoID)
			}
			idx.mu.Unlock()
		}()

		ctx := context.Background()
		if err := idx.doIndex(ctx, repoID, userID, force, lock); err != nil {
			slog.Error("repo indexing failed", "repoId", repoID, "err", err)
			_ = idx.repos.MarkFailed(ctx, repoID, err.Error())
		}
	}()
}

func (idx *RepoIndexer) doIndex(ctx context.Context, repoID, userID uuid.UUID, force bool, lock *indexingLock) error {
	repo, err := idx.repos.FindByID(ctx, repoID)
	if err != nil {
		return err
	}

	previousFiles := make(map[string]string)
	previousTreeSHA := ""
	if !force {
		if repo.IndexedFilesJSON != nil && *repo.IndexedFilesJSON != "" {
			_ = json.Unmarshal([]byte(*repo.IndexedFilesJSON), &previousFiles)
		}
		if repo.TreeSHA != nil {
			previousTreeSHA = *repo.TreeSHA
		}
	}

	tree, err := idx.ghClient.GetRepoTree(ctx, repo.Owner, repo.Name, repo.DefaultBranch)
	if err != nil {
		return err
	}

	currentFiles := make(map[string]string)
	var eligibleBytes, skippedBytes int64
	for _, entry := range tree.Tree {
		if entry.Type != "blob" {
			continue
		}
		if !IsEligibleCodeFile(entry.Path, entry.Size, idx.maxFileBytes) {
			skippedBytes += entry.Size
			continue
		}
		eligibleBytes += entry.Size
		currentFiles[entry.Path] = entry.SHA
	}

	currentTreeSHA := computeTreeSHA(currentFiles)
	if !force && previousTreeSHA != "" && previousTreeSHA == currentTreeSHA {
		stage := "done"
		detail := "Indexing complete"
		repo.FilesProcessed = len(previousFiles)
		repo.FilesTotal = len(previousFiles)
		repo.IndexStatus = model.StatusReady
		repo.IndexingStage = &stage
		repo.IndexingDetail = &detail
		return idx.repos.Update(ctx, &repo)
	}

	if force {
		_ = idx.vectors.DeleteByRepo(ctx, userID, repoID)
	}

	var toFetch, toDelete []string
	for p, sha := range currentFiles {
		prevSHA, exists := previousFiles[p]
		if !exists {
			toFetch = append(toFetch, p)
		} else if prevSHA != sha {
			toFetch = append(toFetch, p)
			toDelete = append(toDelete, p)
		}
	}
	for prevPath := range previousFiles {
		if _, exists := currentFiles[prevPath]; !exists {
			toDelete = append(toDelete, prevPath)
		}
	}

	idx.updateProgress(ctx, repoID, lock, "fetching", "Fetching repository files...", 0, len(currentFiles), 0, 0, true)
	if len(toDelete) > 0 {
		if err := idx.vectors.DeleteByFilePaths(ctx, userID, repoID, toDelete); err != nil {
			slog.Warn("failed deleting stale file vectors", "repoId", repoID, "err", err)
		}
	}

	if len(toFetch) > 0 {
		if err := idx.streamFetchAndEmbed(ctx, repo, userID, toFetch, len(currentFiles), eligibleBytes, skippedBytes, lock); err != nil {
			return err
		}
	}

	// Exact total vector count from Postgres (prevents incremental re-index from overwriting total chunk_count)
	totalVectors, err := idx.vectors.CountByRepo(ctx, userID, repoID)
	if err != nil {
		totalVectors = repo.ChunkCount
	}

	idx.updateProgress(ctx, repoID, lock, "saving", "Finalizing repository index...", len(currentFiles), len(currentFiles), totalVectors, totalVectors, true)

	filesJSONBytes, _ := json.Marshal(currentFiles)
	filesJSON := string(filesJSONBytes)
	now := time.Now().UTC()
	doneStage := "done"
	doneDetail := "Indexing complete"

	repo.TreeSHA = &currentTreeSHA
	repo.IndexedFilesJSON = &filesJSON
	repo.FilesTotal = len(currentFiles)
	repo.FilesProcessed = len(currentFiles)
	repo.ChunkCount = totalVectors
	repo.ChunksTotal = totalVectors
	repo.ChunksProcessed = totalVectors
	repo.IndexedAt = &now
	repo.IndexStatus = model.StatusReady
	repo.IndexingStage = &doneStage
	repo.IndexingDetail = &doneDetail
	repo.ErrorMessage = nil

	if err := idx.repos.Update(ctx, &repo); err != nil {
		return err
	}
	if idx.onRepoReady != nil {
		idx.onRepoReady(repoID)
	}
	return nil
}

func (idx *RepoIndexer) streamFetchAndEmbed(
	ctx context.Context,
	repo model.Repository,
	userID uuid.UUID,
	filesToFetch []string,
	totalFiles int,
	eligibleBytes, skippedBytes int64,
	lock *indexingLock,
) error {
	targetSet := make(map[string]struct{}, len(filesToFetch))
	for _, p := range filesToFetch {
		targetSet[p] = struct{}{}
	}

	var filesDone, totalChunks, embeddedChunks atomic.Int64
	var bufMu sync.Mutex
	batchBuf := make([]model.VectorChunk, 0, vectorBatchSize)
	batchCh := make(chan []model.VectorChunk, 6) // bounded queue backpressure

	embedGroup, embedCtx := errgroup.WithContext(ctx)
	embedGroup.SetLimit(parallelEmbedBatches)

	dispatcherDone := make(chan struct{})
	go func() {
		defer close(dispatcherDone)
		for batch := range batchCh {
			b := batch
			embedGroup.Go(func() error {
				if err := persistChunkBatch(embedCtx, idx.embedder, idx.vectors, b); err != nil {
					return err
				}
				done := int(embeddedChunks.Add(int64(len(b))))
				idx.updateProgress(ctx, repo.ID, lock, "embedding",
					fmt.Sprintf("Embedded %d/%d chunks...", done, totalChunks.Load()),
					int(filesDone.Load()), totalFiles, done, int(totalChunks.Load()), false)
				return nil
			})
		}
	}()

	enqueueChunks := func(chunks []model.VectorChunk, doneFiles int) error {
		if len(chunks) == 0 {
			return nil
		}
		var ready [][]model.VectorChunk
		bufMu.Lock()
		totalChunks.Add(int64(len(chunks)))
		for _, c := range chunks {
			batchBuf = append(batchBuf, c)
			if len(batchBuf) >= vectorBatchSize {
				batch := make([]model.VectorChunk, len(batchBuf))
				copy(batch, batchBuf)
				ready = append(ready, batch)
				batchBuf = batchBuf[:0]
			}
		}
		bufMu.Unlock()

		idx.updateProgress(ctx, repo.ID, lock, "embedding",
			fmt.Sprintf("Streaming & embedding (%d/%d files)...", doneFiles, totalFiles),
			doneFiles, totalFiles, int(embeddedChunks.Load()), int(totalChunks.Load()), false)

		for _, b := range ready {
			select {
			case <-embedCtx.Done():
				return embedCtx.Err()
			case batchCh <- b:
			}
		}
		return nil
	}

	preferRawCDN := !repo.IsPrivate && len(filesToFetch) <= 20 && skippedBytes > 2_000_000 && skippedBytes > eligibleBytes*4
	zipballOK := false

	if len(filesToFetch) >= zipballFileThreshold && !preferRawCDN {
		_, err := idx.ghClient.StreamRepoZipball(
			embedCtx, repo.Owner, repo.Name, repo.DefaultBranch, idx.maxFileBytes,
			func(p string, size int64) bool {
				_, ok := targetSet[p]
				return ok && IsEligibleCodeFile(p, size, idx.maxFileBytes)
			},
			func(p, content string) error {
				chunks := idx.chunkRepoFile(userID, repo.ID.String(), p, content)
				done := int(filesDone.Add(1))
				return enqueueChunks(chunks, done)
			},
		)
		if err == nil {
			zipballOK = true
		} else {
			slog.Warn("zipball stream failed, falling back to per-file fetch", "repoId", repo.ID, "err", err)
		}
	}

	if !zipballOK {
		fetchGroup, fetchCtx := errgroup.WithContext(embedCtx)
		fetchGroup.SetLimit(parallelFetchWorkers)
		for _, p := range filesToFetch {
			filePath := p
			fetchGroup.Go(func() error {
				var content string
				var err error
				if !repo.IsPrivate {
					content, err = idx.ghClient.GetRawFileContent(fetchCtx, repo.Owner, repo.Name, repo.DefaultBranch, filePath)
				} else {
					if err := idx.ghClient.PauseForRateLimit(fetchCtx); err != nil {
						return err
					}
					content, err = idx.ghClient.GetFileContent(fetchCtx, repo.Owner, repo.Name, filePath)
				}
				done := int(filesDone.Add(1))
				if err != nil || content == "" {
					return nil
				}
				chunks := idx.chunkRepoFile(userID, repo.ID.String(), filePath, content)
				return enqueueChunks(chunks, done)
			})
		}
		_ = fetchGroup.Wait()
	}

	bufMu.Lock()
	if len(batchBuf) > 0 {
		rem := make([]model.VectorChunk, len(batchBuf))
		copy(rem, batchBuf)
		batchBuf = batchBuf[:0]
		bufMu.Unlock()
		batchCh <- rem
	} else {
		bufMu.Unlock()
	}
	close(batchCh)
	<-dispatcherDone
	return embedGroup.Wait()
}

func (idx *RepoIndexer) chunkRepoFile(userID uuid.UUID, repoID, filePath, content string) []model.VectorChunk {
	if IsIACRepoPath(filePath) {
		if blocks := ExtractIACFromString(content, filePath); len(blocks) > 0 {
			chunks := ChunkSections(userID, repoID, model.SourceIAC, filePath, blocks, idx.semChunkSz)
			for i := range chunks {
				chunks[i].Metadata["sourceType"] = string(model.SourceGitHub)
			}
			return chunks
		}
	}
	return ChunkCodeFile(userID, repoID, filePath, content, idx.codeChunkSz)
}

func (idx *RepoIndexer) updateProgress(ctx context.Context, repoID uuid.UUID, lock *indexingLock, stage, detail string, filesDone, filesTotal, chunksDone, chunksTotal int, force bool) {
	now := time.Now().UnixMilli()
	if lock != nil {
		lock.lastProgressAt.Store(now)
		prevStage, _ := lock.lastStage.Load().(string)
		stageChanged := stage != "" && stage != prevStage
		lastWrite := lock.lastDBWriteAt.Load()
		if !force && !stageChanged && (now-lastWrite) < statusUpdateThrottle.Milliseconds() {
			return
		}
		if !force && !stageChanged && !lock.lastDBWriteAt.CompareAndSwap(lastWrite, now) {
			return
		}
		lock.lastDBWriteAt.Store(now)
		if stage != "" {
			lock.lastStage.Store(stage)
		}
	}
	_ = idx.repos.UpdateProgress(ctx, repoID, stage, detail, filesDone, filesTotal, chunksDone, chunksTotal)
}

func persistChunkBatch(ctx context.Context, embedder embedding.Embedder, vectors *store.VectorStore, batch []model.VectorChunk) error {
	if len(batch) == 0 {
		return nil
	}
	texts := make([]string, len(batch))
	for i, c := range batch {
		texts[i] = c.Content
	}
	embeddings, err := embedder.EmbedBatch(ctx, texts)
	if err != nil {
		return err
	}
	for i := range batch {
		batch[i].Embedding = embeddings[i]
	}

	// Retry once on transient Postgres connection reset/timeout
	if err := vectors.InsertBatch(ctx, batch); err != nil {
		if isTransientDBErr(err) {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(time.Second):
			}
			return vectors.InsertBatch(ctx, batch)
		}
		return err
	}
	return nil
}

func isTransientDBErr(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	return (strings.Contains(msg, "connection") && (strings.Contains(msg, "closed") || strings.Contains(msg, "reset") || strings.Contains(msg, "timeout"))) ||
		strings.Contains(msg, "deadlock")
}

func computeTreeSHA(files map[string]string) string {
	if len(files) == 0 {
		return ""
	}
	pairs := make([]string, 0, len(files))
	for k, v := range files {
		pairs = append(pairs, k+":"+v)
	}
	sort.Strings(pairs)
	sum := sha256.Sum256([]byte(strings.Join(pairs, "|")))
	return base64.StdEncoding.EncodeToString(sum[:])
}

func placeholderGithubID(owner, name string) int64 {
	u := uuid.NewMD5(uuid.Nil, []byte(strings.ToLower(owner)+"/"+strings.ToLower(name)))
	msb := int64(binary.BigEndian.Uint64(u[:8]))
	return msb | (-1 << 63) // negative 64-bit synthetic ID
}

func ptrIfNotEmpty(s string) *string {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	v := s
	return &v
}
