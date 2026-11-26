package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"trace/backend-go/internal/config"
	"trace/backend-go/internal/mcp"
	"trace/backend-go/internal/model"
	"trace/backend-go/internal/store"
)

type stubKeyRepo struct{}

func (stubKeyRepo) FindActiveByWorkspace(context.Context, uuid.UUID) (model.McpAPIKey, error) {
	return model.McpAPIKey{}, store.ErrNotFound
}
func (stubKeyRepo) FindActiveByHash(context.Context, string) (model.McpAPIKey, error) {
	return model.McpAPIKey{}, store.ErrNotFound
}
func (stubKeyRepo) ReplaceKey(context.Context, *model.McpAPIKey) error     { return nil }
func (stubKeyRepo) RevokeAll(context.Context, uuid.UUID) (int64, error)    { return 0, nil }
func (stubKeyRepo) TouchLastUsed(context.Context, uuid.UUID, time.Time) error { return nil }

func TestRoutesMatchWithoutTrailingSlash(t *testing.T) {
	h := NewRouter(Dependencies{
		Config:  config.Config{CorsAllowedOrigins: []string{"http://localhost:3000"}},
		McpAuth: mcp.NewAuthService(stubKeyRepo{}),
	})

	tests := []struct {
		method     string
		path       string
		body       string
		wantStatus int
	}{
		{http.MethodGet, "/health", "", http.StatusOK},
		{http.MethodGet, "/api/health", "", http.StatusOK},
		{http.MethodGet, "/api/health/", "", http.StatusOK},
		{http.MethodGet, "/api/mcp/keys", "", http.StatusOK},
		{http.MethodGet, "/api/mcp/keys/", "", http.StatusOK},
		{http.MethodPost, "/api/mcp/keys", `{}`, http.StatusCreated},
		{http.MethodDelete, "/api/mcp/keys", "", http.StatusNoContent},
		{http.MethodPost, "/api/mcp", `{"jsonrpc":"2.0","id":1,"method":"ping"}`, http.StatusUnauthorized},
		{http.MethodPost, "/mcp", `{"jsonrpc":"2.0","id":1,"method":"ping"}`, http.StatusUnauthorized},
		{http.MethodPost, "/api/repos/analyze", `{"repoUrl":"bad"}`, http.StatusBadRequest},
		{http.MethodPost, "/api/chat/sessions", `{}`, http.StatusBadRequest},
		{http.MethodPost, "/api/chat/messages/stream", `{"content":"hi"}`, http.StatusBadRequest},
	}

	for _, tc := range tests {
		req := httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != tc.wantStatus {
			t.Errorf("%s %s -> status %d, want %d (body: %s)", tc.method, tc.path, rec.Code, tc.wantStatus, rec.Body.String())
		}
	}
}
