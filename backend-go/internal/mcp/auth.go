package mcp

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"

	"trace/backend-go/internal/model"
	"trace/backend-go/internal/store"
)

const (
	KeyPrefix    = "trc_live_"
	entropyBytes = 32 // 256-bit cryptographic entropy
)

var ErrUnauthorized = errors.New("invalid or revoked MCP API key")

// KeyRepository abstracts persistence so auth & key lifecycle can be unit-tested without Postgres.
type KeyRepository interface {
	FindActiveByWorkspace(ctx context.Context, workspaceID uuid.UUID) (model.McpAPIKey, error)
	FindActiveByHash(ctx context.Context, keyHash string) (model.McpAPIKey, error)
	ReplaceKey(ctx context.Context, key *model.McpAPIKey) error
	RevokeAll(ctx context.Context, workspaceID uuid.UUID) (int64, error)
	TouchLastUsed(ctx context.Context, id uuid.UUID, usedAt time.Time) error
}

// AuthService manages 256-bit MCP API key generation, SHA-256 hash-only storage,
// revocation/regeneration, and strict Bearer / X-API-Key authentication.
type AuthService struct {
	keys KeyRepository
}

func NewAuthService(keys KeyRepository) *AuthService {
	return &AuthService{keys: keys}
}

func (a *AuthService) GetStatus(ctx context.Context, workspaceID uuid.UUID) (model.McpKeyStatusResponse, error) {
	k, err := a.keys.FindActiveByWorkspace(ctx, workspaceID)
	if errors.Is(err, store.ErrNotFound) {
		return model.EmptyMcpKeyStatus(), nil
	}
	if err != nil {
		return model.McpKeyStatusResponse{}, err
	}
	masked := k.MaskedPreview()
	return model.McpKeyStatusResponse{
		HasActiveKey:    true,
		ID:              &k.ID,
		MaskedKey:       &masked,
		KeyPrefix:       &k.KeyPrefix,
		KeyLast4:        &k.KeyLast4,
		Label:           k.Label,
		CreatedAt:       &k.CreatedAt,
		LastUsedAt:      k.LastUsedAt,
		McpEndpointPath: "/api/mcp",
	}, nil
}

// GenerateOrRegenerate revokes any existing workspace keys and returns a fresh plaintext key ONCE.
func (a *AuthService) GenerateOrRegenerate(ctx context.Context, workspaceID uuid.UUID, label string) (model.McpKeyGeneratedResponse, error) {
	raw := make([]byte, entropyBytes)
	if _, err := rand.Read(raw); err != nil {
		return model.McpKeyGeneratedResponse{}, err
	}
	plaintext := KeyPrefix + base64.RawURLEncoding.EncodeToString(raw)
	keyHash := SHA256Hex(plaintext)
	displayPrefix := plaintext[:min(len(KeyPrefix)+4, len(plaintext))]
	last4 := plaintext[len(plaintext)-4:]

	cleanLabel := strings.TrimSpace(label)
	if cleanLabel == "" {
		cleanLabel = "Workspace MCP Key"
	}
	if len(cleanLabel) > 100 {
		cleanLabel = cleanLabel[:100]
	}

	entity := model.McpAPIKey{
		ID:          uuid.New(),
		WorkspaceID: workspaceID,
		KeyHash:     keyHash,
		KeyPrefix:   displayPrefix,
		KeyLast4:    last4,
		Label:       &cleanLabel,
		Revoked:     false,
		CreatedAt:   time.Now().UTC(),
	}
	if err := a.keys.ReplaceKey(ctx, &entity); err != nil {
		return model.McpKeyGeneratedResponse{}, err
	}

	return model.McpKeyGeneratedResponse{
		ID:              entity.ID,
		APIKey:          plaintext,
		MaskedKey:       entity.MaskedPreview(),
		KeyPrefix:       entity.KeyPrefix,
		KeyLast4:        entity.KeyLast4,
		Label:           entity.Label,
		CreatedAt:       entity.CreatedAt,
		McpEndpointPath: "/api/mcp",
	}, nil
}

func (a *AuthService) RevokeAll(ctx context.Context, workspaceID uuid.UUID) error {
	_, err := a.keys.RevokeAll(ctx, workspaceID)
	return err
}

// Authenticate resolves the strict owner workspace UUID solely from Authorization: Bearer or X-API-Key.
// Never falls back to AnonymousWorkspaceID or X-Workspace-Id.
func (a *AuthService) Authenticate(ctx context.Context, authorizationHeader, xAPIKeyHeader string) (uuid.UUID, error) {
	rawKey := ExtractRawKey(authorizationHeader, xAPIKeyHeader)
	if rawKey == "" || !strings.HasPrefix(rawKey, KeyPrefix) || len(rawKey) < len(KeyPrefix)+24 {
		return uuid.Nil, ErrUnauthorized
	}

	hash := SHA256Hex(rawKey)
	k, err := a.keys.FindActiveByHash(ctx, hash)
	if err != nil {
		return uuid.Nil, ErrUnauthorized
	}

	// Defense-in-depth constant-time digest comparison
	if subtle.ConstantTimeCompare([]byte(hash), []byte(k.KeyHash)) != 1 {
		return uuid.Nil, ErrUnauthorized
	}

	// Async non-blocking last_used_at touch so MCP tool latency stays minimal
	go func(keyID uuid.UUID) {
		touchCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = a.keys.TouchLastUsed(touchCtx, keyID, time.Now().UTC())
	}(k.ID)

	return k.WorkspaceID, nil
}

func ExtractRawKey(authorizationHeader, xAPIKeyHeader string) string {
	trimmed := strings.TrimSpace(authorizationHeader)
	if len(trimmed) >= 7 && strings.EqualFold(trimmed[:7], "Bearer ") {
		if tok := strings.TrimSpace(trimmed[7:]); tok != "" {
			return tok
		}
	}
	return strings.TrimSpace(xAPIKeyHeader)
}

func SHA256Hex(plaintext string) string {
	sum := sha256.Sum256([]byte(plaintext))
	return hex.EncodeToString(sum[:])
}
