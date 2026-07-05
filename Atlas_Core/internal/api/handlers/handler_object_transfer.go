package handlers

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	chimiddleware "github.com/go-chi/chi/v5/middleware"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/serializers"
	protocol "github.com/the-drunken-coder/atlas/atlas_protocol/generated/go/atlasprotocol"
)

func requestClientIP(r *http.Request) string {
	if clientIP := chimiddleware.GetClientIP(r.Context()); clientIP != "" {
		return clientIP
	}
	return r.RemoteAddr
}

// DownloadObject handles GET /objects/{object_id}/download.
func (h *Handler) DownloadObject(w http.ResponseWriter, r *http.Request) {
	if h.storage == nil {
		h.writeError(w, r, http.StatusServiceUnavailable, "Storage service is not configured", protocol.ErrorCodeStorageUnavailable)
		return
	}

	objectID := chi.URLParam(r, "object_id")

	reader, contentType, size, err := h.objectActions.Download(r.Context(), objectID)
	if err != nil {
		h.handleActionError(w, r, err)
		return
	}
	defer func() { _ = reader.Close() }()

	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Length", strconv.FormatInt(size, 10))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	ext := getExtensionForContentType(contentType)
	w.Header().Set("Content-Disposition", attachmentContentDisposition(objectID+ext))
	w.WriteHeader(http.StatusOK)

	written, err := io.Copy(w, reader)
	if err != nil {
		h.logger.Error().
			Err(err).
			Str("object_id", objectID).
			Int64("bytes_written", written).
			Int64("bytes_expected", size).
			Str("client_ip", requestClientIP(r)).
			Str("remote_addr", r.RemoteAddr).
			Msg("Failed to stream object to client")
	}
}

// ViewObject handles GET /objects/{object_id}/view.
// Returns the object content inline for viewable text-based formats (JSON, plain text, etc.).
// Returns an error for binary or non-viewable content types.
func (h *Handler) ViewObject(w http.ResponseWriter, r *http.Request) {
	if h.storage == nil {
		h.writeError(w, r, http.StatusServiceUnavailable, "Storage service is not configured", protocol.ErrorCodeStorageUnavailable)
		return
	}

	objectID := chi.URLParam(r, "object_id")

	reader, contentType, size, err := h.objectActions.Download(r.Context(), objectID)
	if err != nil {
		h.handleActionError(w, r, err)
		return
	}
	defer func() { _ = reader.Close() }()

	if !isViewableContentType(contentType) {
		if !isUnsafeInlineContentType(contentType) {
			h.writeError(w, r, http.StatusUnsupportedMediaType, "Content type is not viewable (only safe text-based formats are supported)", protocol.ErrorCodeContentTypeNotViewable)
			return
		}

		ext := getExtensionForContentType(contentType)
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Length", strconv.FormatInt(size, 10))
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Content-Disposition", attachmentContentDisposition(objectID+ext))
		w.WriteHeader(http.StatusOK)
		written, err := io.Copy(w, reader)
		if err != nil {
			h.logger.Error().
				Err(err).
				Str("object_id", objectID).
				Str("content_type", contentType).
				Str("ext", ext).
				Int64("bytes_written", written).
				Int64("bytes_expected", size).
				Str("client_ip", requestClientIP(r)).
				Str("remote_addr", r.RemoteAddr).
				Msg("Failed to stream object to client")
		}
		return
	}

	effectiveMaxViewSizeMB := h.config.MaxViewSizeMB
	maxViewSize := int64(effectiveMaxViewSizeMB) * 1024 * 1024
	if size > maxViewSize {
		h.writeError(w, r, http.StatusBadRequest, fmt.Sprintf("File is too large to view (maximum %dMB)", effectiveMaxViewSizeMB), protocol.ErrorCodeFileTooLarge)
		return
	}

	// Hard-cap the read: the size guard above relies on object metadata, which may
	// understate the actual stored blob. Read at most maxViewSize+1 bytes so a
	// larger-than-reported blob cannot be buffered unbounded into memory.
	content, err := io.ReadAll(io.LimitReader(reader, maxViewSize+1))
	if err != nil {
		h.writeError(w, r, http.StatusInternalServerError, "Failed to read object content", protocol.ErrorCodeReadError)
		return
	}
	if int64(len(content)) > maxViewSize {
		h.writeError(w, r, http.StatusBadRequest, fmt.Sprintf("File is too large to view (maximum %dMB)", effectiveMaxViewSizeMB), protocol.ErrorCodeFileTooLarge)
		return
	}

	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Length", strconv.FormatInt(int64(len(content)), 10))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)

	// nosemgrep: go.lang.security.audit.xss.no-direct-write-to-responsewriter.no-direct-write-to-responsewriter -- object bytes from storage, not HTML
	n, err := w.Write(content)
	if err != nil {
		h.logger.Error().
			Err(err).
			Str("object_id", objectID).
			Int("bytes_written", n).
			Int64("bytes_expected", int64(len(content))).
			Str("client_ip", requestClientIP(r)).
			Str("remote_addr", r.RemoteAddr).
			Msg("Failed to write object content to client")
	}
}

// UploadObject handles POST /objects/upload.
func (h *Handler) UploadObject(w http.ResponseWriter, r *http.Request) {
	if h.storage == nil {
		h.writeError(w, r, http.StatusServiceUnavailable, "Storage service is not configured", protocol.ErrorCodeStorageUnavailable)
		return
	}

	effectiveMaxUploadSizeMB := h.config.MaxUploadSizeMB
	maxUploadSize := int64(effectiveMaxUploadSizeMB) * 1024 * 1024
	const maxMultipartOverhead = 1 * 1024 * 1024
	r.Body = http.MaxBytesReader(w, r.Body, maxUploadSize+maxMultipartOverhead)
	const maxMultipartMemory = 32 * 1024 * 1024
	if err := r.ParseMultipartForm(maxMultipartMemory); err != nil {
		var maxBytesErr *http.MaxBytesError
		if errors.As(err, &maxBytesErr) {
			h.writeError(w, r, http.StatusRequestEntityTooLarge, fmt.Sprintf("Request body too large (maximum %dMB)", effectiveMaxUploadSizeMB), protocol.ErrorCodeBodyTooLarge)
			return
		}
		h.writeError(w, r, http.StatusBadRequest, fmt.Sprintf("Failed to parse multipart form (maximum %dMB)", effectiveMaxUploadSizeMB), protocol.ErrorCodeInvalidForm)
		return
	}
	defer func() {
		if r.MultipartForm != nil {
			_ = r.MultipartForm.RemoveAll()
		}
	}()

	objectID := r.FormValue("object_id")
	if objectID == "" {
		h.writeError(w, r, http.StatusBadRequest, "object_id is required", protocol.ErrorCodeValidationError)
		return
	}

	usageHint := r.FormValue("usage_hint")
	objType := r.FormValue("type")

	file, header, err := r.FormFile("file")
	if err != nil {
		h.writeError(w, r, http.StatusBadRequest, "file is required", protocol.ErrorCodeValidationError)
		return
	}
	defer func() {
		if err := file.Close(); err != nil {
			h.logger.Error().Err(err).Msg("failed to close uploaded file")
		}
	}()

	if header.Size > maxUploadSize {
		h.writeError(w, r, http.StatusRequestEntityTooLarge, fmt.Sprintf("File size exceeds maximum allowed (%dMB)", effectiveMaxUploadSizeMB), protocol.ErrorCodeFileTooLarge)
		return
	}

	contentType := header.Header.Get("Content-Type")
	if contentType == "" {
		contentType = "application/octet-stream"
	}

	var usageHintPtr *string
	if usageHint != "" {
		usageHintPtr = &usageHint
	}

	obj, err := h.objectActions.Upload(r.Context(), objectID, file, header.Size, contentType, objType, usageHintPtr)
	if err != nil {
		h.handleActionError(w, r, err)
		return
	}

	setResourceETag(w, obj.Version)
	writeJSON(w, http.StatusCreated, serializers.SerializeObject(obj))
}
