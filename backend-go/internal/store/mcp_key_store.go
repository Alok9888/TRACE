package store

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"trace/backend-go/internal/model"
)

type McpKeyStore struct {
	pool *pgxpool.Pool
}

func NewMcpKeyStore(pool *pgxpool.Pool) *McpKeyStore {
	return &McpKeyStore{pool: pool}
}

func (s *McpKeyStore) FindActiveByWorkspace(ctx context.Context, workspaceID uuid.UUID) (model.McpAPIKey, error) {
	var k model.McpAPIKey
	err := s.pool.QueryRow(ctx, `
		SELECT id, workspace_id, key_hash, key_prefix, key_last4, label, revoked, created_at, last_used_at, revoked_at
		FROM mcp_api_keys
		WHERE workspace_id = $1 AND revoked = FALSE
		ORDER BY created_at DESC
		LIMIT 1`, workspaceID).
		Scan(&k.ID, &k.WorkspaceID, &k.KeyHash, &k.KeyPrefix, &k.KeyLast4, &k.Label, &k.Revoked, &k.CreatedAt, &k.LastUsedAt, &k.RevokedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return k, ErrNotFound
	}
	return k, err
}

func (s *McpKeyStore) FindActiveByHash(ctx context.Context, keyHash string) (model.McpAPIKey, error) {
	var k model.McpAPIKey
	err := s.pool.QueryRow(ctx, `
		SELECT id, workspace_id, key_hash, key_prefix, key_last4, label, revoked, created_at, last_used_at, revoked_at
		FROM mcp_api_keys
		WHERE key_hash = $1 AND revoked = FALSE`, keyHash).
		Scan(&k.ID, &k.WorkspaceID, &k.KeyHash, &k.KeyPrefix, &k.KeyLast4, &k.Label, &k.Revoked, &k.CreatedAt, &k.LastUsedAt, &k.RevokedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return k, ErrNotFound
	}
	return k, err
}

// ReplaceKey atomically revokes all active keys for workspaceID and inserts the new hashed key.
func (s *McpKeyStore) ReplaceKey(ctx context.Context, key *model.McpAPIKey) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	now := time.Now().UTC()
	if _, err := tx.Exec(ctx,
		`UPDATE mcp_api_keys SET revoked = TRUE, revoked_at = $2 WHERE workspace_id = $1 AND revoked = FALSE`,
		key.WorkspaceID, now); err != nil {
		return err
	}

	if key.ID == uuid.Nil {
		key.ID = uuid.New()
	}
	if key.CreatedAt.IsZero() {
		key.CreatedAt = now
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO mcp_api_keys (id, workspace_id, key_hash, key_prefix, key_last4, label, revoked, created_at)
		VALUES ($1,$2,$3,$4,$5,$6,FALSE,$7)`,
		key.ID, key.WorkspaceID, key.KeyHash, key.KeyPrefix, key.KeyLast4, key.Label, key.CreatedAt); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *McpKeyStore) RevokeAll(ctx context.Context, workspaceID uuid.UUID) (int64, error) {
	tag, err := s.pool.Exec(ctx,
		`UPDATE mcp_api_keys SET revoked = TRUE, revoked_at = $2 WHERE workspace_id = $1 AND revoked = FALSE`,
		workspaceID, time.Now().UTC())
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

func (s *McpKeyStore) TouchLastUsed(ctx context.Context, id uuid.UUID, usedAt time.Time) error {
	_, err := s.pool.Exec(ctx, `UPDATE mcp_api_keys SET last_used_at = $2 WHERE id = $1`, id, usedAt)
	return err
}
