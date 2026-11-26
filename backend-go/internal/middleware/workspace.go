package middleware

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"

	"trace/backend-go/internal/model"
)

type ctxKey string

const workspaceCtxKey ctxKey = "workspace_id"

// Workspace resolves the browser's X-Workspace-Id header into request context.
// Missing/blank header defaults to model.AnonymousWorkspaceID; invalid UUID returns 400.
// Note: MCP endpoints (/api/mcp, /mcp) intentionally IGNORE this context and authenticate
// exclusively via Bearer / X-API-Key.
func Workspace(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw := strings.TrimSpace(r.Header.Get("X-Workspace-Id"))
		wsID := model.AnonymousWorkspaceID
		if raw != "" {
			parsed, err := uuid.Parse(raw)
			if err != nil {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusBadRequest)
				_ = json.NewEncoder(w).Encode(map[string]any{
					"status":    http.StatusBadRequest,
					"error":     "Bad Request",
					"message":   "Invalid X-Workspace-Id header",
					"timestamp": time.Now().UTC().Format(time.RFC3339Nano),
				})
				return
			}
			wsID = parsed
		}
		ctx := context.WithValue(r.Context(), workspaceCtxKey, wsID)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func WorkspaceID(ctx context.Context) uuid.UUID {
	if id, ok := ctx.Value(workspaceCtxKey).(uuid.UUID); ok && id != uuid.Nil {
		return id
	}
	return model.AnonymousWorkspaceID
}
