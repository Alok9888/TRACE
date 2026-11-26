package store

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"trace/backend-go/internal/model"
)

type SessionRepoSummary struct {
	SessionID          uuid.UUID
	RepositoryID       uuid.UUID
	RepositoryFullName string
	IndexStatus        model.IndexStatus
	TreeSHA            *string
	IndexedAt          *time.Time
	SourceType         model.SourceType
}

type PendingMessage struct {
	ID        uuid.UUID
	SessionID uuid.UUID
	Role      model.MessageRole
	Content   string
	Citations *string
	CreatedAt time.Time
}

type ChatStore struct {
	pool *pgxpool.Pool
}

func NewChatStore(pool *pgxpool.Pool) *ChatStore {
	return &ChatStore{pool: pool}
}

func (s *ChatStore) CreateSession(ctx context.Context, userID, repoID uuid.UUID, title string) (model.ChatSessionResponse, error) {
	id := uuid.New()
	now := time.Now().UTC()
	if title == "" {
		title = "New chat"
	}
	if len(title) > 200 {
		title = title[:200]
	}
	_, err := s.pool.Exec(ctx,
		`INSERT INTO chat_sessions (id, user_id, repository_id, title, created_at) VALUES ($1, $2, $3, $4, $5)`,
		id, userID, repoID, title, now)
	if err != nil {
		return model.ChatSessionResponse{}, err
	}
	return model.ChatSessionResponse{
		ID:           id,
		RepositoryID: repoID,
		Title:        title,
		CreatedAt:    now,
	}, nil
}

func (s *ChatStore) ListSessions(ctx context.Context, userID, repoID uuid.UUID) ([]model.ChatSessionResponse, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id, repository_id, title, created_at FROM chat_sessions
		 WHERE user_id = $1 AND repository_id = $2
		 ORDER BY created_at DESC`, userID, repoID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]model.ChatSessionResponse, 0)
	for rows.Next() {
		var item model.ChatSessionResponse
		if err := rows.Scan(&item.ID, &item.RepositoryID, &item.Title, &item.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

func (s *ChatStore) VerifySessionOwned(ctx context.Context, userID, sessionID uuid.UUID) error {
	var id uuid.UUID
	err := s.pool.QueryRow(ctx,
		`SELECT id FROM chat_sessions WHERE id = $1 AND user_id = $2`, sessionID, userID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	return err
}

func (s *ChatStore) FindSessionWithRepo(ctx context.Context, sessionID, userID uuid.UUID) (SessionRepoSummary, error) {
	var out SessionRepoSummary
	var status, sourceType string
	err := s.pool.QueryRow(ctx, `
		SELECT s.id, r.id, r.full_name, r.index_status, r.tree_sha, r.indexed_at,
		       COALESCE(r.source_type, 'GITHUB_REPO')
		FROM chat_sessions s
		JOIN repositories r ON r.id = s.repository_id
		WHERE s.id = $1 AND s.user_id = $2 AND r.user_id = $2`,
		sessionID, userID).
		Scan(&out.SessionID, &out.RepositoryID, &out.RepositoryFullName, &status, &out.TreeSHA, &out.IndexedAt, &sourceType)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return out, ErrNotFound
		}
		return out, err
	}
	out.IndexStatus = model.IndexStatus(status)
	out.SourceType = model.SourceType(sourceType).Effective()
	return out, nil
}

func (s *ChatStore) ListMessages(ctx context.Context, sessionID uuid.UUID) ([]model.ChatMessageResponse, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id, role, content, citations, created_at FROM chat_messages
		 WHERE session_id = $1 ORDER BY created_at ASC`, sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]model.ChatMessageResponse, 0)
	for rows.Next() {
		var m model.ChatMessageResponse
		var role string
		var citationsRaw *string
		if err := rows.Scan(&m.ID, &role, &m.Content, &citationsRaw, &m.CreatedAt); err != nil {
			return nil, err
		}
		m.Role = model.MessageRole(role)
		m.Citations = parseCitationsJSON(citationsRaw)
		out = append(out, m)
	}
	return out, rows.Err()
}

func (s *ChatStore) InsertMessagesBatch(ctx context.Context, msgs []PendingMessage) error {
	if len(msgs) == 0 {
		return nil
	}
	batch := &pgx.Batch{}
	for _, m := range msgs {
		batch.Queue(
			`INSERT INTO chat_messages (id, session_id, role, content, citations, created_at) VALUES ($1,$2,$3,$4,$5,$6)`,
			m.ID, m.SessionID, string(m.Role), m.Content, m.Citations, m.CreatedAt,
		)
	}
	br := s.pool.SendBatch(ctx, batch)
	defer br.Close()
	for range msgs {
		if _, err := br.Exec(); err != nil {
			return err
		}
	}
	return nil
}

func parseCitationsJSON(raw *string) []model.Citation {
	if raw == nil || *raw == "" {
		return []model.Citation{}
	}
	var out []model.Citation
	if err := json.Unmarshal([]byte(*raw), &out); err != nil || out == nil {
		return []model.Citation{}
	}
	return out
}
