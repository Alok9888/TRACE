package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"trace/backend-go/internal/ingestion"
	"trace/backend-go/internal/middleware"
	"trace/backend-go/internal/model"
	"trace/backend-go/internal/store"
)

var githubRepoRe = regexp.MustCompile(`^(?:https://github\.com/)?([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+?)(?:\.git)?/?$`)

type RepoHandler struct {
	repos   *store.RepoStore
	indexer *ingestion.RepoIndexer
}

func (h *RepoHandler) List(w http.ResponseWriter, r *http.Request) {
	wsID := middleware.WorkspaceID(r.Context())
	list, err := h.repos.ListByUser(r.Context(), wsID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, list)
}

func (h *RepoHandler) Analyze(w http.ResponseWriter, r *http.Request) {
	var req model.AnalyzeRepoRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "Invalid JSON payload")
		return
	}
	m := githubRepoRe.FindStringSubmatch(strings.TrimSpace(req.RepoURL))
	if len(m) != 3 {
		writeError(w, http.StatusBadRequest, "Enter a valid public GitHub repository URL")
		return
	}
	force := strings.EqualFold(r.URL.Query().Get("force"), "true")
	wsID := middleware.WorkspaceID(r.Context())
	owner, name := m[1], m[2]

	decision, err := h.indexer.PrepareAnalyze(r.Context(), wsID, owner, name, force)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if decision.ShouldStart {
		h.indexer.AnalyzeAndIndexAsync(wsID, owner, name, decision.Repo.ID, force)
	}

	status := http.StatusOK
	if decision.Repo.IndexStatus == model.StatusIndexing || decision.ShouldStart {
		status = http.StatusAccepted
	}
	writeJSON(w, status, decision.Repo.ToResponse())
}

func (h *RepoHandler) AnalyzeStatus(w http.ResponseWriter, r *http.Request) {
	setNoStore(w)
	wsID := middleware.WorkspaceID(r.Context())

	if rawID := strings.TrimSpace(r.URL.Query().Get("repoId")); rawID != "" {
		id, err := uuid.Parse(rawID)
		if err != nil {
			writeError(w, http.StatusBadRequest, "Invalid repoId")
			return
		}
		resp, err := h.repos.StatusByID(r.Context(), id, wsID)
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "Repository not found")
			return
		}
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, resp)
		return
	}

	m := githubRepoRe.FindStringSubmatch(strings.TrimSpace(r.URL.Query().Get("url")))
	if len(m) != 3 {
		writeError(w, http.StatusBadRequest, "Invalid URL")
		return
	}
	resp, err := h.repos.StatusByOwnerName(r.Context(), wsID, m[1], m[2])
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

func (h *RepoHandler) Get(w http.ResponseWriter, r *http.Request) {
	setNoStore(w)
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "Invalid repository ID")
		return
	}
	repo, err := h.repos.FindByIDAndUser(r.Context(), id, middleware.WorkspaceID(r.Context()))
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "Repository not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, repo.ToResponse())
}

func (h *RepoHandler) Reindex(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "Invalid repository ID")
		return
	}
	repo, err := h.indexer.StartReindex(r.Context(), id, middleware.WorkspaceID(r.Context()))
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "Repository not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusAccepted, repo.ToResponse())
}

func (h *RepoHandler) Status(w http.ResponseWriter, r *http.Request) {
	setNoStore(w)
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "Invalid repository ID")
		return
	}
	resp, err := h.repos.StatusByID(r.Context(), id, middleware.WorkspaceID(r.Context()))
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "Repository not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, resp)
}
