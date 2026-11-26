package mcp

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"trace/backend-go/internal/model"
	"trace/backend-go/internal/store"
)

type memKeyRepo struct {
	mu   sync.Mutex
	keys map[uuid.UUID]model.McpAPIKey
}

func newMemKeyRepo() *memKeyRepo {
	return &memKeyRepo{keys: make(map[uuid.UUID]model.McpAPIKey)}
}

func (m *memKeyRepo) FindActiveByWorkspace(_ context.Context, wsID uuid.UUID) (model.McpAPIKey, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, k := range m.keys {
		if k.WorkspaceID == wsID && !k.Revoked {
			return k, nil
		}
	}
	return model.McpAPIKey{}, store.ErrNotFound
}

func (m *memKeyRepo) FindActiveByHash(_ context.Context, hash string) (model.McpAPIKey, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, k := range m.keys {
		if k.KeyHash == hash && !k.Revoked {
			return k, nil
		}
	}
	return model.McpAPIKey{}, store.ErrNotFound
}

func (m *memKeyRepo) ReplaceKey(_ context.Context, key *model.McpAPIKey) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := time.Now().UTC()
	for id, k := range m.keys {
		if k.WorkspaceID == key.WorkspaceID && !k.Revoked {
			k.Revoked = true
			k.RevokedAt = &now
			m.keys[id] = k
		}
	}
	m.keys[key.ID] = *key
	return nil
}

func (m *memKeyRepo) RevokeAll(_ context.Context, wsID uuid.UUID) (int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var n int64
	now := time.Now().UTC()
	for id, k := range m.keys {
		if k.WorkspaceID == wsID && !k.Revoked {
			k.Revoked = true
			k.RevokedAt = &now
			m.keys[id] = k
			n++
		}
	}
	return n, nil
}

func (m *memKeyRepo) TouchLastUsed(_ context.Context, id uuid.UUID, usedAt time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if k, ok := m.keys[id]; ok {
		k.LastUsedAt = &usedAt
		m.keys[id] = k
	}
	return nil
}

type fakeSourceBackend struct {
	repos map[uuid.UUID]model.Repository
}

func (f *fakeSourceBackend) ListByUser(_ context.Context, userID uuid.UUID) ([]model.RepositoryResponse, error) {
	var out []model.RepositoryResponse
	for _, r := range f.repos {
		if r.UserID == userID {
			out = append(out, r.ToResponse())
		}
	}
	return out, nil
}

func (f *fakeSourceBackend) FindByIDAndUser(_ context.Context, id, userID uuid.UUID) (model.Repository, error) {
	r, ok := f.repos[id]
	if !ok || r.UserID != userID {
		return model.Repository{}, store.ErrNotFound
	}
	return r, nil
}

func (f *fakeSourceBackend) SearchVectors(_ context.Context, userID uuid.UUID, optionalSourceID *uuid.UUID, _ string, _ int, _ float64) ([]model.SearchHit, error) {
	page := 4
	pdfType := "PDF"
	var out []model.SearchHit
	for _, r := range f.repos {
		if r.UserID != userID {
			continue
		}
		if optionalSourceID != nil && r.ID != *optionalSourceID {
			continue
		}
		out = append(out, model.SearchHit{
			Content:  "Tenant secret for " + r.FullName,
			Score:    0.91,
			SourceID: r.ID.String(),
			Citation: model.Citation{FilePath: r.FullName, SourceType: &pdfType, PageNumber: &page},
		})
	}
	return out, nil
}

func (f *fakeSourceBackend) FetchSourceChunks(_ context.Context, _, _ uuid.UUID, _ string, _ *int, _, _ int) ([]model.SearchHit, error) {
	return nil, nil
}

func TestMcpAuthLifecycleAndHashOnlyStorage(t *testing.T) {
	ctx := context.Background()
	repo := newMemKeyRepo()
	auth := NewAuthService(repo)
	wsA := uuid.New()

	gen1, err := auth.GenerateOrRegenerate(ctx, wsA, "Cursor")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(gen1.APIKey, KeyPrefix) {
		t.Fatalf("expected prefix %s, got %s", KeyPrefix, gen1.APIKey)
	}

	// Verify plaintext is NEVER stored in repository
	stored := repo.keys[gen1.ID]
	if stored.KeyHash == gen1.APIKey || len(stored.KeyHash) != 64 {
		t.Fatalf("key was not stored as 64-char SHA-256 hex")
	}

	// Bearer and X-API-Key both authenticate to wsA
	gotWS, err := auth.Authenticate(ctx, "Bearer "+gen1.APIKey, "")
	if err != nil || gotWS != wsA {
		t.Fatalf("Bearer auth failed: ws=%v err=%v", gotWS, err)
	}
	gotWS, err = auth.Authenticate(ctx, "", gen1.APIKey)
	if err != nil || gotWS != wsA {
		t.Fatalf("X-API-Key auth failed: ws=%v err=%v", gotWS, err)
	}

	// Regeneration immediately revokes key 1
	gen2, err := auth.GenerateOrRegenerate(ctx, wsA, "Rotated")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := auth.Authenticate(ctx, "Bearer "+gen1.APIKey, ""); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("expected old key to be rejected with ErrUnauthorized, got %v", err)
	}
	if gotWS, err := auth.Authenticate(ctx, "Bearer "+gen2.APIKey, ""); err != nil || gotWS != wsA {
		t.Fatalf("rotated key should succeed, got ws=%v err=%v", gotWS, err)
	}

	// Revoke all rejects key 2
	if err := auth.RevokeAll(ctx, wsA); err != nil {
		t.Fatal(err)
	}
	if _, err := auth.Authenticate(ctx, "Bearer "+gen2.APIKey, ""); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("expected revoked key to fail, got %v", err)
	}
}

func TestMcpTenantIsolationAndProtocol(t *testing.T) {
	ctx := context.Background()
	wsA, wsB := uuid.New(), uuid.New()
	srcA, srcB := uuid.New(), uuid.New()

	srv := NewServer(&fakeSourceBackend{
		repos: map[uuid.UUID]model.Repository{
			srcA: {ID: srcA, UserID: wsA, FullName: "alpha-spec.pdf", SourceType: model.SourcePDF, IndexStatus: model.StatusReady, ChunkCount: 12},
			srcB: {ID: srcB, UserID: wsB, FullName: "beta-secret.pdf", SourceType: model.SourcePDF, IndexStatus: model.StatusReady, ChunkCount: 9},
		},
	})

	// 1. initialize
	initResp, isNotif := srv.HandleJSONRPC(ctx, wsA, map[string]any{
		"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": map[string]any{"protocolVersion": "2025-03-26"},
	})
	if isNotif || initResp["error"] != nil {
		t.Fatalf("initialize failed: %+v", initResp)
	}

	// 2. tools/list returns all 4 tools
	listResp, _ := srv.HandleJSONRPC(ctx, wsA, map[string]any{"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
	tools := listResp["result"].(map[string]any)["tools"].([]map[string]any)
	if len(tools) != 4 {
		t.Fatalf("expected 4 tools, got %d", len(tools))
	}

	// 3. Workspace A cannot read Workspace B's source details
	crossResp, _ := srv.HandleJSONRPC(ctx, wsA, map[string]any{
		"jsonrpc": "2.0", "id": 3, "method": "tools/call",
		"params": map[string]any{"name": "get_source_details", "arguments": map[string]any{"sourceId": srcB.String()}},
	})
	resMap := crossResp["result"].(map[string]any)
	if resMap["isError"] != true {
		t.Fatalf("expected cross-tenant get_source_details to return isError=true, got %+v", resMap)
	}

	// 4. Workspace A search_knowledge never returns Workspace B content
	searchResp, _ := srv.HandleJSONRPC(ctx, wsA, map[string]any{
		"jsonrpc": "2.0", "id": 4, "method": "tools/call",
		"params": map[string]any{"name": "search_knowledge", "arguments": map[string]any{"query": "secret"}},
	})
	content := searchResp["result"].(map[string]any)["content"].([]map[string]any)[0]["text"].(string)
	if strings.Contains(content, "beta-secret.pdf") || !strings.Contains(content, "alpha-spec.pdf") {
		t.Fatalf("tenant isolation violation in search_knowledge: %s", content)
	}
}
