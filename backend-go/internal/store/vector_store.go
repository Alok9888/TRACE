package store

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"trace/backend-go/internal/model"
)

// VectorStore executes direct, tenant-scoped PgVector operations against trace_vectors_cf_384.
// Every read and delete enforces (metadata->>'userId') = $userId at the SQL layer.
type VectorStore struct {
	pool  *pgxpool.Pool
	table string
}

func NewVectorStore(pool *pgxpool.Pool, table string) *VectorStore {
	return &VectorStore{pool: pool, table: table}
}

func (v *VectorStore) InsertBatch(ctx context.Context, chunks []model.VectorChunk) error {
	if len(chunks) == 0 {
		return nil
	}
	query := fmt.Sprintf(
		`INSERT INTO %s (id, content, metadata, embedding) VALUES ($1, $2, $3::json, $4::vector)`,
		v.table,
	)
	batch := &pgx.Batch{}
	for _, c := range chunks {
		id := c.ID
		if id == uuid.Nil {
			id = uuid.New()
		}
		cleanContent := strings.ToValidUTF8(strings.ReplaceAll(c.Content, "\x00", ""), "")
		metaBytes, err := json.Marshal(c.Metadata)
		if err != nil {
			return fmt.Errorf("marshal chunk metadata: %w", err)
		}
		cleanMeta := strings.ToValidUTF8(strings.ReplaceAll(string(metaBytes), "\x00", ""), "")
		batch.Queue(query, id, cleanContent, cleanMeta, FormatVectorLiteral(c.Embedding))
	}
	br := v.pool.SendBatch(ctx, batch)
	defer br.Close()
	for range chunks {
		if _, err := br.Exec(); err != nil {
			return err
		}
	}
	return nil
}

func (v *VectorStore) DeleteByRepo(ctx context.Context, userID, repoID uuid.UUID) error {
	sql := fmt.Sprintf(
		`DELETE FROM %s WHERE (metadata->>'repoId') = $1 AND (metadata->>'userId') = $2`,
		v.table,
	)
	_, err := v.pool.Exec(ctx, sql, repoID.String(), userID.String())
	return err
}

func (v *VectorStore) DeleteByFilePaths(ctx context.Context, userID, repoID uuid.UUID, paths []string) error {
	if len(paths) == 0 {
		return nil
	}
	const batchSize = 50
	sql := fmt.Sprintf(
		`DELETE FROM %s WHERE (metadata->>'repoId') = $1 AND (metadata->>'userId') = $2 AND (metadata->>'filePath') = ANY($3)`,
		v.table,
	)
	for i := 0; i < len(paths); i += batchSize {
		end := min(i+batchSize, len(paths))
		if _, err := v.pool.Exec(ctx, sql, repoID.String(), userID.String(), paths[i:end]); err != nil {
			return err
		}
	}
	return nil
}

// CountByRepo returns exact retained vector count for a source (fixes Java incremental chunk_count overwrite bug).
func (v *VectorStore) CountByRepo(ctx context.Context, userID, repoID uuid.UUID) (int, error) {
	sql := fmt.Sprintf(
		`SELECT COUNT(*) FROM %s WHERE (metadata->>'repoId') = $1 AND (metadata->>'userId') = $2`,
		v.table,
	)
	var count int
	err := v.pool.QueryRow(ctx, sql, repoID.String(), userID.String()).Scan(&count)
	return count, err
}

// Search executes the single-vector CTE cosine search with late TOAST join.
// When optionalSourceID is nil, searches across all sources owned by userID.
func (v *VectorStore) Search(
	ctx context.Context,
	userID uuid.UUID,
	optionalSourceID *uuid.UUID,
	queryVec []float32,
	topK int,
	similarityThreshold float64,
) ([]model.SearchHit, error) {
	if len(queryVec) == 0 {
		return nil, nil
	}
	if topK < 1 {
		topK = 5
	}
	if similarityThreshold < 0 {
		similarityThreshold = 0
	} else if similarityThreshold > 1 {
		similarityThreshold = 1
	}
	maxDist := 1.0 - similarityThreshold
	vecLit := FormatVectorLiteral(queryVec)

	var rows pgx.Rows
	var err error
	if optionalSourceID != nil {
		sql := fmt.Sprintf(`
			WITH q AS (SELECT $1::vector AS v),
			ranked AS (
				SELECT id, (embedding <=> q.v) AS dist
				FROM %s, q
				WHERE (metadata->>'repoId') = $2
				  AND (metadata->>'userId') = $3
				  AND (embedding <=> q.v) <= $4
				ORDER BY dist ASC
				LIMIT $5
			)
			SELECT t.content, t.metadata::text AS metadata_json, (1 - r.dist) AS score
			FROM ranked r
			JOIN %s t ON t.id = r.id
			ORDER BY r.dist ASC`, v.table, v.table)
		rows, err = v.pool.Query(ctx, sql, vecLit, optionalSourceID.String(), userID.String(), maxDist, topK)
	} else {
		sql := fmt.Sprintf(`
			WITH q AS (SELECT $1::vector AS v),
			ranked AS (
				SELECT id, (embedding <=> q.v) AS dist
				FROM %s, q
				WHERE (metadata->>'userId') = $2
				  AND (embedding <=> q.v) <= $3
				ORDER BY dist ASC
				LIMIT $4
			)
			SELECT t.content, t.metadata::text AS metadata_json, (1 - r.dist) AS score
			FROM ranked r
			JOIN %s t ON t.id = r.id
			ORDER BY r.dist ASC`, v.table, v.table)
		rows, err = v.pool.Query(ctx, sql, vecLit, userID.String(), maxDist, topK)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	hits := make([]model.SearchHit, 0, topK)
	for rows.Next() {
		var content, metaJSON string
		var score float64
		if err := rows.Scan(&content, &metaJSON, &score); err != nil {
			return nil, err
		}
		hits = append(hits, buildSearchHit(content, metaJSON, score))
	}
	return hits, rows.Err()
}

// FetchSourceChunks reads ordered chunks from one owned source for MCP get_source_excerpts.
func (v *VectorStore) FetchSourceChunks(
	ctx context.Context,
	userID, sourceID uuid.UUID,
	filePath string,
	unitNumber *int,
	offset, limit int,
) ([]model.SearchHit, error) {
	if limit < 1 {
		limit = 6
	} else if limit > 20 {
		limit = 20
	}
	if offset < 0 {
		offset = 0
	}

	var sb strings.Builder
	args := []any{sourceID.String(), userID.String()}
	argIdx := 3

	fmt.Fprintf(&sb, `SELECT content, metadata::text AS metadata_json FROM %s WHERE (metadata->>'repoId') = $1 AND (metadata->>'userId') = $2`, v.table)

	if fp := strings.TrimSpace(filePath); fp != "" {
		fmt.Fprintf(&sb, ` AND (metadata->>'filePath') = $%d`, argIdx)
		args = append(args, fp)
		argIdx++
	}
	if unitNumber != nil && *unitNumber > 0 {
		u := strconv.Itoa(*unitNumber)
		fmt.Fprintf(&sb, ` AND ((metadata->>'pageNumber') = $%d OR (metadata->>'startLine') = $%d)`, argIdx, argIdx+1)
		args = append(args, u, u)
		argIdx += 2
	}
	fmt.Fprintf(&sb, ` ORDER BY COALESCE(NULLIF(metadata->>'chunkIndex', '')::int, 0) ASC LIMIT $%d OFFSET $%d`, argIdx, argIdx+1)
	args = append(args, limit, offset)

	rows, err := v.pool.Query(ctx, sb.String(), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	hits := make([]model.SearchHit, 0, limit)
	for rows.Next() {
		var content, metaJSON string
		if err := rows.Scan(&content, &metaJSON); err != nil {
			return nil, err
		}
		hits = append(hits, buildSearchHit(content, metaJSON, 1.0))
	}
	return hits, rows.Err()
}

func FormatVectorLiteral(vec []float32) string {
	var sb strings.Builder
	sb.Grow(len(vec)*10 + 2)
	sb.WriteByte('[')
	for i, val := range vec {
		if i > 0 {
			sb.WriteByte(',')
		}
		sb.WriteString(strconv.FormatFloat(float64(val), 'f', -1, 32))
	}
	sb.WriteByte(']')
	return sb.String()
}

func buildSearchHit(content, metaJSON string, score float64) model.SearchHit {
	meta := make(map[string]any)
	if metaJSON != "" {
		_ = json.Unmarshal([]byte(metaJSON), &meta)
	}
	sourceID := metaString(meta, "repoId")
	return model.SearchHit{
		Content:  content,
		Score:    score,
		SourceID: sourceID,
		Metadata: meta,
		Citation: CitationFromMetadata(meta),
	}
}

func CitationFromMetadata(meta map[string]any) model.Citation {
	return model.Citation{
		FilePath:       metaString(meta, "filePath"),
		StartLine:      metaIntPtr(meta, "startLine"),
		EndLine:        metaIntPtr(meta, "endLine"),
		Language:       metaStringPtr(meta, "language"),
		SourceType:     metaStringPtr(meta, "sourceType"),
		PageNumber:     metaIntPtr(meta, "pageNumber"),
		SectionHeading: metaStringPtr(meta, "sectionHeading"),
		ChunkIndex:     metaIntPtr(meta, "chunkIndex"),
	}
}

func metaString(m map[string]any, key string) string {
	v, ok := m[key]
	if !ok || v == nil {
		return ""
	}
	if s, ok := v.(string); ok {
		return s
	}
	return fmt.Sprint(v)
}

func metaStringPtr(m map[string]any, key string) *string {
	s := metaString(m, key)
	if s == "" {
		return nil
	}
	return &s
}

func metaIntPtr(m map[string]any, key string) *int {
	v, ok := m[key]
	if !ok || v == nil {
		return nil
	}
	switch n := v.(type) {
	case float64:
		val := int(n)
		return &val
	case int:
		return &n
	case int64:
		val := int(n)
		return &val
	case string:
		if parsed, err := strconv.Atoi(n); err == nil {
			return &parsed
		}
	}
	return nil
}
