package api

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/google/uuid"

	"trace/backend-go/internal/mcp"
	"trace/backend-go/internal/middleware"
)

type McpHandler struct {
	auth   *mcp.AuthService
	server *mcp.Server
}

func (h *McpHandler) KeyStatus(w http.ResponseWriter, r *http.Request) {
	setNoStore(w)
	status, err := h.auth.GetStatus(r.Context(), middleware.WorkspaceID(r.Context()))
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, status)
}

func (h *McpHandler) GenerateKey(w http.ResponseWriter, r *http.Request) {
	setNoStore(w)
	var body map[string]any
	_ = json.NewDecoder(r.Body).Decode(&body)
	label, _ := body["label"].(string)

	generated, err := h.auth.GenerateOrRegenerate(r.Context(), middleware.WorkspaceID(r.Context()), label)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, generated)
}

func (h *McpHandler) RevokeKey(w http.ResponseWriter, r *http.Request) {
	setNoStore(w)
	if err := h.auth.RevokeAll(r.Context(), middleware.WorkspaceID(r.Context())); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *McpHandler) HandlePost(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	wsID, err := h.auth.Authenticate(r.Context(), r.Header.Get("Authorization"), r.Header.Get("X-API-Key"))
	if err != nil {
		writeError(w, http.StatusUnauthorized, err.Error())
		return
	}

	var payload map[string]any
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeJSON(w, http.StatusOK, map[string]any{
			"jsonrpc": "2.0",
			"id":      nil,
			"error":   map[string]any{"code": -32700, "message": "Parse error: invalid JSON"},
		})
		return
	}

	result, isNotification := h.server.HandleJSONRPC(r.Context(), wsID, payload)
	if isNotification {
		w.WriteHeader(http.StatusAccepted)
		return
	}

	sessionID := strings.TrimSpace(r.Header.Get("Mcp-Session-Id"))
	if sessionID == "" {
		sessionID = uuid.New().String()
	}
	w.Header().Set("Mcp-Session-Id", sessionID)
	writeJSON(w, http.StatusOK, result)
}

func (h *McpHandler) HandleGet(w http.ResponseWriter, r *http.Request) {
	if _, err := h.auth.Authenticate(r.Context(), r.Header.Get("Authorization"), r.Header.Get("X-API-Key")); err != nil {
		writeError(w, http.StatusUnauthorized, err.Error())
		return
	}
	writeJSON(w, http.StatusMethodNotAllowed, map[string]any{
		"server":          mcp.ServerName,
		"protocolVersion": mcp.ProtocolVersion,
		"message":         "Send JSON-RPC 2.0 requests via HTTP POST to this MCP endpoint.",
	})
}

func (h *McpHandler) HandleDelete(w http.ResponseWriter, r *http.Request) {
	if _, err := h.auth.Authenticate(r.Context(), r.Header.Get("Authorization"), r.Header.Get("X-API-Key")); err != nil {
		writeError(w, http.StatusUnauthorized, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
