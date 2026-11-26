package store

import (
	"context"
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"trace/backend-go/internal/model"
)

var ErrNotFound = errors.New("not found")

type RepoStore struct {
	pool *pgxpool.Pool
}

func NewRepoStore(pool *pgxpool.Pool) *RepoStore {
	return &RepoStore{pool: pool}
}

const repoSelectCols = `
	id, user_id, COALESCE(source_type, 'GITHUB_REPO'), github_repo_id,
	owner, name, full_name, is_private, default_branch, language, html_url, description,
	index_status, indexed_at, chunk_count, files_total, files_processed,
	chunks_total, chunks_processed, indexing_stage, indexing_detail, error_message,
	tree_sha, indexed_files_json, file_name, file_size_bytes, page_count,
	storage_key, source_metadata_json, created_at, updated_at`

func scanRepo(row pgx.Row) (model.Repository, error) {
	var r model.Repository
	var st string
	var status string
	err := row.Scan(
		&r.ID, &r.UserID, &st, &r.GithubRepoID,
		&r.Owner, &r.Name, &r.FullName, &r.IsPrivate, &r.DefaultBranch, &r.Language, &r.HTMLURL, &r.Description,
		&status, &r.IndexedAt, &r.ChunkCount, &r.FilesTotal, &r.FilesProcessed,
		&r.ChunksTotal, &r.ChunksProcessed, &r.IndexingStage, &r.IndexingDetail, &r.ErrorMessage,
		&r.TreeSHA, &r.IndexedFilesJSON, &r.FileName, &r.FileSizeBytes, &r.PageCount,
		&r.StorageKey, &r.SourceMetadataJSON, &r.CreatedAt, &r.UpdatedAt,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return r, ErrNotFound
		}
		return r, err
	}
	r.SourceType = model.SourceType(st).Effective()
	r.IndexStatus = model.IndexStatus(status)
	return r, nil
}

func (s *RepoStore) ListByUser(ctx context.Context, userID uuid.UUID) ([]model.RepositoryResponse, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT `+repoSelectCols+` FROM repositories WHERE user_id = $1 ORDER BY updated_at DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]model.RepositoryResponse, 0)
	for rows.Next() {
		r, err := scanRepo(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r.ToResponse())
	}
	return out, rows.Err()
}

func (s *RepoStore) FindByIDAndUser(ctx context.Context, id, userID uuid.UUID) (model.Repository, error) {
	row := s.pool.QueryRow(ctx, `SELECT `+repoSelectCols+` FROM repositories WHERE id = $1 AND user_id = $2`, id, userID)
	return scanRepo(row)
}

func (s *RepoStore) FindByID(ctx context.Context, id uuid.UUID) (model.Repository, error) {
	row := s.pool.QueryRow(ctx, `SELECT `+repoSelectCols+` FROM repositories WHERE id = $1`, id)
	return scanRepo(row)
}

func (s *RepoStore) FindByUserAndGithubID(ctx context.Context, userID uuid.UUID, githubRepoID int64) (model.Repository, error) {
	row := s.pool.QueryRow(ctx,
		`SELECT `+repoSelectCols+` FROM repositories WHERE user_id = $1 AND github_repo_id = $2`,
		userID, githubRepoID)
	return scanRepo(row)
}

func (s *RepoStore) FindByUserAndOwnerName(ctx context.Context, userID uuid.UUID, owner, name string) (model.Repository, error) {
	row := s.pool.QueryRow(ctx,
		`SELECT `+repoSelectCols+` FROM repositories
		 WHERE user_id = $1 AND lower(owner) = lower($2) AND lower(name) = lower($3)
		 ORDER BY CASE WHEN indexing_stage = 'creating' THEN 1 ELSE 0 END ASC, updated_at DESC
		 LIMIT 1`,
		userID, owner, name)
	return scanRepo(row)
}

func (s *RepoStore) FindReadyByDedup(ctx context.Context, userID uuid.UUID, sha string, st model.SourceType) (model.Repository, error) {
	row := s.pool.QueryRow(ctx,
		`SELECT `+repoSelectCols+` FROM repositories
		 WHERE user_id = $1 AND tree_sha = $2 AND source_type = $3 AND index_status = 'READY'
		 LIMIT 1`,
		userID, sha, string(st))
	return scanRepo(row)
}

func (s *RepoStore) Insert(ctx context.Context, r *model.Repository) error {
	now := time.Now().UTC()
	if r.ID == uuid.Nil {
		r.ID = uuid.New()
	}
	if r.CreatedAt.IsZero() {
		r.CreatedAt = now
	}
	r.UpdatedAt = now
	if r.SourceType == "" {
		r.SourceType = model.SourceGitHub
	}
	if r.IndexStatus == "" {
		r.IndexStatus = model.StatusPending
	}
	_, err := s.pool.Exec(ctx, `
		INSERT INTO repositories (
			id, user_id, source_type, github_repo_id, owner, name, full_name,
			is_private, default_branch, language, html_url, description,
			index_status, indexed_at, chunk_count, files_total, files_processed,
			chunks_total, chunks_processed, indexing_stage, indexing_detail, error_message,
			tree_sha, indexed_files_json, file_name, file_size_bytes, page_count,
			storage_key, source_metadata_json, created_at, updated_at
		) VALUES (
			$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
			$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31
		)`,
		r.ID, r.UserID, string(r.SourceType), r.GithubRepoID, r.Owner, r.Name, r.FullName,
		r.IsPrivate, r.DefaultBranch, r.Language, r.HTMLURL, r.Description,
		string(r.IndexStatus), r.IndexedAt, r.ChunkCount, r.FilesTotal, r.FilesProcessed,
		r.ChunksTotal, r.ChunksProcessed, r.IndexingStage, r.IndexingDetail, r.ErrorMessage,
		r.TreeSHA, r.IndexedFilesJSON, r.FileName, r.FileSizeBytes, r.PageCount,
		r.StorageKey, r.SourceMetadataJSON, r.CreatedAt, r.UpdatedAt,
	)
	return err
}

func (s *RepoStore) Update(ctx context.Context, r *model.Repository) error {
	r.UpdatedAt = time.Now().UTC()
	_, err := s.pool.Exec(ctx, `
		UPDATE repositories SET
			source_type=$2, github_repo_id=$3, owner=$4, name=$5, full_name=$6,
			is_private=$7, default_branch=$8, language=$9, html_url=$10, description=$11,
			index_status=$12, indexed_at=$13, chunk_count=$14, files_total=$15, files_processed=$16,
			chunks_total=$17, chunks_processed=$18, indexing_stage=$19, indexing_detail=$20, error_message=$21,
			tree_sha=$22, indexed_files_json=$23, file_name=$24, file_size_bytes=$25, page_count=$26,
			storage_key=$27, source_metadata_json=$28, updated_at=$29
		WHERE id = $1`,
		r.ID, string(r.SourceType.Effective()), r.GithubRepoID, r.Owner, r.Name, r.FullName,
		r.IsPrivate, r.DefaultBranch, r.Language, r.HTMLURL, r.Description,
		string(r.IndexStatus), r.IndexedAt, r.ChunkCount, r.FilesTotal, r.FilesProcessed,
		r.ChunksTotal, r.ChunksProcessed, r.IndexingStage, r.IndexingDetail, r.ErrorMessage,
		r.TreeSHA, r.IndexedFilesJSON, r.FileName, r.FileSizeBytes, r.PageCount,
		r.StorageKey, r.SourceMetadataJSON, r.UpdatedAt,
	)
	return err
}

func (s *RepoStore) DeleteByID(ctx context.Context, id uuid.UUID) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM repositories WHERE id = $1`, id)
	return err
}

func (s *RepoStore) UpdateProgress(ctx context.Context, repoID uuid.UUID, stage, detail string, filesDone, filesTotal, chunksDone, chunksTotal int) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE repositories
		SET indexing_stage = $2,
			indexing_detail = $3,
			files_processed = CASE WHEN $4 >= 0 THEN $4 ELSE files_processed END,
			files_total = CASE WHEN $5 >= 0 THEN $5 ELSE files_total END,
			chunks_processed = CASE WHEN $6 >= 0 THEN $6 ELSE chunks_processed END,
			chunks_total = CASE WHEN $7 >= 0 THEN $7 ELSE chunks_total END,
			updated_at = $8
		WHERE id = $1`,
		repoID, stage, detail, filesDone, filesTotal, chunksDone, chunksTotal, time.Now().UTC(),
	)
	return err
}

func (s *RepoStore) MarkFailed(ctx context.Context, repoID uuid.UUID, message string) error {
	message = sanitizeDBText(message, 2000)
	_, err := s.pool.Exec(ctx, `
		UPDATE repositories
		SET index_status = 'FAILED',
			indexing_stage = 'failed',
			indexing_detail = 'Indexing failed',
			error_message = $2,
			updated_at = $3
		WHERE id = $1`,
		repoID, message, time.Now().UTC(),
	)
	return err
}

func sanitizeDBText(s string, maxBytes int) string {
	s = strings.ToValidUTF8(strings.ReplaceAll(s, "\x00", ""), "")
	if maxBytes > 0 && len(s) > maxBytes {
		end := maxBytes
		for end > 0 && !utf8.RuneStart(s[end]) {
			end--
		}
		s = s[:end]
	}
	return s
}

func (s *RepoStore) StatusByID(ctx context.Context, id, userID uuid.UUID) (model.IndexStatusResponse, error) {
	var resp model.IndexStatusResponse
	var repoID uuid.UUID
	var status string
	err := s.pool.QueryRow(ctx, `
		SELECT id, index_status, files_total, files_processed, chunk_count,
		       chunks_total, chunks_processed, indexing_stage, indexing_detail, indexed_at, error_message
		FROM repositories
		WHERE id = $1 AND user_id = $2`, id, userID).
		Scan(&repoID, &status, &resp.FilesTotal, &resp.FilesProcessed, &resp.ChunkCount,
			&resp.ChunksTotal, &resp.ChunksProcessed, &resp.IndexingStage, &resp.IndexingDetail,
			&resp.IndexedAt, &resp.ErrorMessage)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return resp, ErrNotFound
		}
		return resp, err
	}
	resp.RepositoryID = &repoID
	resp.IndexStatus = model.IndexStatus(status)
	return resp, nil
}

func (s *RepoStore) StatusByOwnerName(ctx context.Context, userID uuid.UUID, owner, name string) (model.IndexStatusResponse, error) {
	var resp model.IndexStatusResponse
	var repoID uuid.UUID
	var status string
	err := s.pool.QueryRow(ctx, `
		SELECT id, index_status, files_total, files_processed, chunk_count,
		       chunks_total, chunks_processed, indexing_stage, indexing_detail, indexed_at, error_message
		FROM repositories
		WHERE user_id = $1 AND lower(owner) = lower($2) AND lower(name) = lower($3)
		ORDER BY CASE WHEN indexing_stage = 'creating' THEN 1 ELSE 0 END ASC, updated_at DESC
		LIMIT 1`, userID, owner, name).
		Scan(&repoID, &status, &resp.FilesTotal, &resp.FilesProcessed, &resp.ChunkCount,
			&resp.ChunksTotal, &resp.ChunksProcessed, &resp.IndexingStage, &resp.IndexingDetail,
			&resp.IndexedAt, &resp.ErrorMessage)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			stage := "creating"
			detail := "Creating repo row..."
			return model.IndexStatusResponse{
				IndexStatus:    model.StatusIndexing,
				IndexingStage:  &stage,
				IndexingDetail: &detail,
			}, nil
		}
		return resp, err
	}
	resp.RepositoryID = &repoID
	resp.IndexStatus = model.IndexStatus(status)
	return resp, nil
}
