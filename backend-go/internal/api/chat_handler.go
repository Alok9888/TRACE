package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"trace/backend-go/internal/ai"
	"trace/backend-go/internal/middleware"
	"trace/backend-go/internal/model"
	"trace/backend-go/internal/store"
)

type ChatHandler struct {
	repos    *store.RepoStore
	chats    *store.ChatStore
	streamer *ai.ChatStreamer
}

func (h *ChatHandler) CreateSession(w http.ResponseWriter, r *http.Request) {
	var req model.CreateChatSessionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.RepositoryID == uuid.Nil {
		writeError(w, http.StatusBadRequest, "repositoryId is required")
		return
	}
	wsID := middleware.WorkspaceID(r.Context())
	repo, err := h.repos.FindByIDAndUser(r.Context(), req.RepositoryID, wsID)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "Repository not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if repo.IndexStatus != model.StatusReady {
		writeError(w, http.StatusBadRequest, "Source must be indexed before chatting")
		return
	}

	title := strings.TrimSpace(req.Title)
	if title == "" {
		title = "Chat with " + repo.FullName
	}
	session, err := h.chats.CreateSession(r.Context(), wsID, repo.ID, title)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	// Pre-populate ChatContextCache immediately so the first message skips a DB lookup
	repoVer := "v0"
	if repo.TreeSHA != nil && *repo.TreeSHA != "" {
		repoVer = *repo.TreeSHA
	} else if repo.IndexedAt != nil {
		repoVer = repo.IndexedAt.Format(time.RFC3339Nano)
	}
	h.streamer.PutSessionContext(wsID, session.ID, ai.StreamContext{
		UserID:            wsID,
		SessionID:         session.ID,
		RepositoryID:      repo.ID,
		RepositoryName:    repo.FullName,
		RepositoryVersion: repoVer,
		SourceType:        repo.SourceType.Effective(),
	})

	writeJSON(w, http.StatusOK, session)
}

func (h *ChatHandler) ListSessions(w http.ResponseWriter, r *http.Request) {
	repoID, err := uuid.Parse(strings.TrimSpace(r.URL.Query().Get("repositoryId")))
	if err != nil {
		writeError(w, http.StatusBadRequest, "Valid repositoryId is required")
		return
	}
	wsID := middleware.WorkspaceID(r.Context())
	if _, err := h.repos.FindByIDAndUser(r.Context(), repoID, wsID); errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "Repository not found")
		return
	} else if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	sessions, err := h.chats.ListSessions(r.Context(), wsID, repoID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, sessions)
}

func (h *ChatHandler) GetMessages(w http.ResponseWriter, r *http.Request) {
	sessionID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "Invalid session ID")
		return
	}
	wsID := middleware.WorkspaceID(r.Context())
	if err := h.chats.VerifySessionOwned(r.Context(), wsID, sessionID); errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "Chat session not found")
		return
	} else if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	msgs, err := h.chats.ListMessages(r.Context(), sessionID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, msgs)
}

func (h *ChatHandler) StreamSessionMessage(w http.ResponseWriter, r *http.Request) {
	sessionID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "Invalid session ID")
		return
	}
	var req model.ChatMessageRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || strings.TrimSpace(req.Content) == "" {
		writeError(w, http.StatusBadRequest, "content is required")
		return
	}
	h.streamer.StreamReply(w, r, middleware.WorkspaceID(r.Context()), sessionID, req)
}

func (h *ChatHandler) StreamMessage(w http.ResponseWriter, r *http.Request) {
	var req model.ChatMessageRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || strings.TrimSpace(req.Content) == "" {
		writeError(w, http.StatusBadRequest, "content is required")
		return
	}
	if req.SessionID == nil || *req.SessionID == uuid.Nil {
		writeError(w, http.StatusBadRequest, "sessionId is required")
		return
	}
	h.streamer.StreamReply(w, r, middleware.WorkspaceID(r.Context()), *req.SessionID, req)
}
