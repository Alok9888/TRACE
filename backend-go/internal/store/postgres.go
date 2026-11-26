package store

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"trace/backend-go/internal/config"
)

// Connect initializes a pgxpool tuned for Neon PostgreSQL (low connection count,
// short lifetime, keepalive health checks) and verifies connectivity.
func Connect(ctx context.Context, cfg config.Config) (*pgxpool.Pool, error) {
	poolCfg, err := pgxpool.ParseConfig(cfg.DatabaseURL)
	if err != nil {
		return nil, fmt.Errorf("parse database url: %w", err)
	}
	poolCfg.MaxConns = cfg.DBMaxConns
	poolCfg.MinConns = cfg.DBMinConns
	poolCfg.MaxConnLifetime = 5 * time.Minute
	poolCfg.MaxConnIdleTime = 2 * time.Minute
	poolCfg.HealthCheckPeriod = 1 * time.Minute
	poolCfg.ConnConfig.ConnectTimeout = 10 * time.Second

	pool, err := pgxpool.NewWithConfig(ctx, poolCfg)
	if err != nil {
		return nil, fmt.Errorf("create pgx pool: %w", err)
	}
	pingCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := pool.Ping(pingCtx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping postgres: %w", err)
	}
	return pool, nil
}

// EnsureSchema ensures all core TRACE tables and PgVector HNSW + metadata indexes exist.
// Safe to run against an existing Neon database created by Hibernate/Spring AI.
func EnsureSchema(ctx context.Context, pool *pgxpool.Pool, vectorTable string) {
	statements := []string{
		`CREATE EXTENSION IF NOT EXISTS vector`,
		`CREATE TABLE IF NOT EXISTS repositories (
			id UUID PRIMARY KEY,
			user_id UUID NOT NULL,
			source_type VARCHAR(20) DEFAULT 'GITHUB_REPO',
			github_repo_id BIGINT NOT NULL,
			owner VARCHAR(100) NOT NULL,
			name VARCHAR(200) NOT NULL,
			full_name VARCHAR(300) NOT NULL,
			is_private BOOLEAN NOT NULL DEFAULT FALSE,
			default_branch VARCHAR(100) NOT NULL DEFAULT 'main',
			language VARCHAR(100),
			html_url VARCHAR(500),
			description TEXT,
			index_status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
			indexed_at TIMESTAMPTZ,
			chunk_count INTEGER NOT NULL DEFAULT 0,
			files_total INTEGER NOT NULL DEFAULT 0,
			files_processed INTEGER NOT NULL DEFAULT 0,
			error_message TEXT,
			indexing_stage VARCHAR(20),
			indexing_detail TEXT,
			chunks_total INTEGER NOT NULL DEFAULT 0,
			chunks_processed INTEGER NOT NULL DEFAULT 0,
			tree_sha TEXT,
			indexed_files_json TEXT,
			file_name VARCHAR(300),
			file_size_bytes BIGINT,
			page_count INTEGER,
			storage_key VARCHAR(500),
			source_metadata_json TEXT,
			created_at TIMESTAMPTZ NOT NULL,
			updated_at TIMESTAMPTZ NOT NULL,
			UNIQUE (user_id, github_repo_id)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_repositories_user_full_name ON repositories (user_id, full_name)`,
		`CREATE INDEX IF NOT EXISTS idx_repositories_user_owner_name ON repositories (user_id, owner, name)`,
		`CREATE INDEX IF NOT EXISTS idx_repositories_user_source_type ON repositories (user_id, source_type)`,
		`CREATE TABLE IF NOT EXISTS chat_sessions (
			id UUID PRIMARY KEY,
			user_id UUID NOT NULL,
			repository_id UUID NOT NULL,
			title VARCHAR(200) NOT NULL,
			created_at TIMESTAMPTZ NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_chat_sessions_user_repo_created ON chat_sessions (user_id, repository_id, created_at)`,
		`CREATE TABLE IF NOT EXISTS chat_messages (
			id UUID PRIMARY KEY,
			session_id UUID NOT NULL,
			role VARCHAR(20) NOT NULL,
			content TEXT NOT NULL,
			citations TEXT,
			created_at TIMESTAMPTZ NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_chat_messages_session_created ON chat_messages (session_id, created_at)`,
		`CREATE TABLE IF NOT EXISTS mcp_api_keys (
			id UUID PRIMARY KEY,
			workspace_id UUID NOT NULL,
			key_hash VARCHAR(64) NOT NULL UNIQUE,
			key_prefix VARCHAR(24) NOT NULL,
			key_last4 VARCHAR(4) NOT NULL,
			label VARCHAR(100),
			revoked BOOLEAN NOT NULL DEFAULT FALSE,
			created_at TIMESTAMPTZ NOT NULL,
			last_used_at TIMESTAMPTZ,
			revoked_at TIMESTAMPTZ
		)`,
		`CREATE INDEX IF NOT EXISTS idx_mcp_api_keys_workspace_revoked ON mcp_api_keys (workspace_id, revoked)`,
		fmt.Sprintf(`CREATE TABLE IF NOT EXISTS %s (
			id UUID PRIMARY KEY,
			content TEXT,
			metadata JSON,
			embedding vector(384)
		)`, vectorTable),
		fmt.Sprintf(`CREATE INDEX IF NOT EXISTS idx_vectors_cf384_embedding_hnsw ON %s USING hnsw (embedding vector_cosine_ops)`, vectorTable),
		fmt.Sprintf(`CREATE INDEX IF NOT EXISTS idx_vectors_cf384_metadata_jsonb_gin ON %s USING gin ((metadata::jsonb) jsonb_path_ops)`, vectorTable),
		fmt.Sprintf(`CREATE INDEX IF NOT EXISTS idx_vectors_cf384_repo_user ON %s ((metadata->>'repoId'), (metadata->>'userId'))`, vectorTable),
		fmt.Sprintf(`CREATE INDEX IF NOT EXISTS idx_vectors_cf384_repo_filepath ON %s ((metadata->>'repoId'), (metadata->>'filePath'))`, vectorTable),
	}

	for _, sql := range statements {
		if _, err := pool.Exec(ctx, sql); err != nil {
			slog.Warn("schema init statement skipped", "err", err)
		}
	}
	slog.Info("verified postgres schema and pgvector indexes", "vectorTable", vectorTable)
}
