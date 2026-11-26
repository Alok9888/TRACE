package api

import (
	"errors"
	"net/http"

	"trace/backend-go/internal/ingestion"
	"trace/backend-go/internal/middleware"
	"trace/backend-go/internal/model"
)

type SourceHandler struct {
	ingestor        *ingestion.FileIngestor
	maxRequestBytes int64
}

func (h *SourceHandler) Upload(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, h.maxRequestBytes)
	// Keep at most 256 KB in memory; spill remainder to temp disk (heap-safe)
	if err := r.ParseMultipartForm(256 * 1024); err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			writeError(w, http.StatusRequestEntityTooLarge, "File exceeds maximum upload size of 20 MB.")
			return
		}
		writeError(w, http.StatusBadRequest, "Invalid file upload request. Please upload a supported document.")
		return
	}
	if r.MultipartForm != nil {
		defer r.MultipartForm.RemoveAll()
	}

	_, header, err := r.FormFile("file")
	if err != nil {
		writeError(w, http.StatusBadRequest, "Please select a non-empty file to upload.")
		return
	}

	wsID := middleware.WorkspaceID(r.Context())
	source, err := h.ingestor.Ingest(r.Context(), wsID, header)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	status := http.StatusAccepted
	if source.IndexStatus == model.StatusReady {
		status = http.StatusOK
	}
	writeJSON(w, status, source.ToResponse())
}
