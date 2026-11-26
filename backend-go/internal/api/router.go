package api

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	chimw "github.com/go-chi/chi/v5/middleware"

	"trace/backend-go/internal/ai"
	"trace/backend-go/internal/config"
	"trace/backend-go/internal/ingestion"
	"trace/backend-go/internal/mcp"
	"trace/backend-go/internal/middleware"
	"trace/backend-go/internal/store"
)

type Dependencies struct {
	Config       config.Config
	Repos        *store.RepoStore
	Chats        *store.ChatStore
	RepoIndexer  *ingestion.RepoIndexer
	FileIngestor *ingestion.FileIngestor
	Streamer     *ai.ChatStreamer
	McpAuth      *mcp.AuthService
	McpServer    *mcp.Server
}

// NewRouter wires all TRACE HTTP routes explicitly using chi.
// Every route matches the existing Spring Boot API contract 1:1 so client/ needs zero changes.
func NewRouter(deps Dependencies) http.Handler {
	r := chi.NewRouter()
	r.Use(chimw.Recoverer)
	r.Use(chimw.RealIP)
	r.Use(chimw.StripSlashes)
	r.Use(middleware.CORS(deps.Config.CorsAllowedOrigins))
	r.Use(middleware.Workspace)

	r.Get("/health", func(w http.ResponseWriter, r *http.Request) {
		setNoStore(w)
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	r.Get("/api/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("TRACE backend is running!"))
	})
	r.Get("/actuator/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "UP"})
	})

	repoH := &RepoHandler{repos: deps.Repos, indexer: deps.RepoIndexer}
	r.Get("/api/repos", repoH.List)
	r.Post("/api/repos/analyze", repoH.Analyze)
	r.Get("/api/repos/analyze/status", repoH.AnalyzeStatus)
	r.Get("/api/repos/{id}", repoH.Get)
	r.Post("/api/repos/{id}/index", repoH.Reindex)
	r.Get("/api/repos/{id}/status", repoH.Status)

	sourceH := &SourceHandler{ingestor: deps.FileIngestor, maxRequestBytes: 25 * 1024 * 1024}
	r.Post("/api/sources/upload", sourceH.Upload)
	r.Post("/api/sources/pdf", sourceH.Upload)
	r.Post("/api/repos/pdf", sourceH.Upload)

	chatH := &ChatHandler{repos: deps.Repos, chats: deps.Chats, streamer: deps.Streamer}
	r.Post("/api/chat/sessions", chatH.CreateSession)
	r.Get("/api/chat/sessions", chatH.ListSessions)
	r.Get("/api/chat/sessions/{id}", chatH.GetMessages)
	r.Post("/api/chat/sessions/{id}/messages", chatH.StreamSessionMessage)
	r.Post("/api/chat/messages/stream", chatH.StreamMessage)

	mcpH := &McpHandler{auth: deps.McpAuth, server: deps.McpServer}
	r.Get("/api/mcp/keys", mcpH.KeyStatus)
	r.Post("/api/mcp/keys", mcpH.GenerateKey)
	r.Delete("/api/mcp/keys", mcpH.RevokeKey)

	for _, base := range []string{"/api/mcp", "/mcp"} {
		r.Post(base, mcpH.HandlePost)
		r.Get(base, mcpH.HandleGet)
		r.Delete(base, mcpH.HandleDelete)
	}

	return r
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]any{
		"status":    status,
		"error":     http.StatusText(status),
		"message":   message,
		"timestamp": time.Now().UTC().Format(time.RFC3339Nano),
	})
}

func setNoStore(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-store, no-cache, must-revalidate")
}
