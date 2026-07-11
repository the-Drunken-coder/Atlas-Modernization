package handlers

import (
	"errors"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/admin"
	protocol "github.com/the-drunken-coder/atlas/atlas_protocol/generated/go/atlasprotocol"
)

type adminCreateAPIKeyRequest struct {
	Name string `json:"name"`
}

type adminAPIKeyResponse struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	KeyPrefix string `json:"key_prefix"`
	CreatedAt string `json:"created_at"`
	CreatedBy string `json:"created_by"`
}

type adminCreateAPIKeyResponse struct {
	adminAPIKeyResponse
	APIKey string `json:"api_key"`
}

func (h *Handler) AdminListAPIKeys(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.requireAdminSession(w, r); !ok {
		return
	}
	keys, err := h.adminAuth.ListAPIKeys(r.Context())
	if err != nil {
		h.writeErrorWithCause(w, r, http.StatusInternalServerError, "list api keys failed", protocol.ErrorCodeInternalServerError, err)
		return
	}
	resp := make([]adminAPIKeyResponse, 0, len(keys))
	for _, key := range keys {
		resp = append(resp, adminAPIKeyResponseFromMetadata(key))
	}
	writeJSON(w, r, http.StatusOK, resp)
}

func (h *Handler) AdminCreateAPIKey(w http.ResponseWriter, r *http.Request) {
	session, ok := h.requireAdminSession(w, r)
	if !ok {
		return
	}
	if !h.requireTrustedAdminOrigin(w, r) {
		return
	}
	if !h.config.EnableAPIAuth {
		h.writeError(w, r, http.StatusConflict, "API key auth is disabled; set ENABLE_API_AUTH=true before creating managed API keys", protocol.ErrorCodeValidationError)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 64*1024)
	var req adminCreateAPIKeyRequest
	if !h.decodeJSONRequestBody(w, r, &req, false) {
		return
	}
	created, err := h.adminAuth.CreateAPIKey(r.Context(), req.Name, session.Username, time.Now().UTC())
	if err != nil {
		if errors.Is(err, admin.ErrAPIKeyNameRequired) || errors.Is(err, admin.ErrAPIKeyNameTooLong) {
			h.writeError(w, r, http.StatusBadRequest, err.Error(), protocol.ErrorCodeValidationError)
			return
		}
		h.writeErrorWithCause(w, r, http.StatusInternalServerError, "create api key failed", protocol.ErrorCodeInternalServerError, err)
		return
	}
	writeJSON(w, r, http.StatusCreated, adminCreateAPIKeyResponse{
		adminAPIKeyResponse: adminAPIKeyResponseFromMetadata(created.APIKeyMetadata),
		APIKey:              created.APIKey,
	})
}

func (h *Handler) AdminRevokeAPIKey(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.requireAdminSession(w, r); !ok {
		return
	}
	if !h.requireTrustedAdminOrigin(w, r) {
		return
	}
	keyID := chi.URLParam(r, "key_id")
	if err := h.adminAuth.RevokeAPIKey(r.Context(), keyID, time.Now().UTC()); err != nil {
		if errors.Is(err, admin.ErrAPIKeyNotFound) {
			h.writeError(w, r, http.StatusNotFound, "api key not found", protocol.ErrorCodeValidationError)
			return
		}
		h.writeErrorWithCause(w, r, http.StatusInternalServerError, "revoke api key failed", protocol.ErrorCodeInternalServerError, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) requireAdminSession(w http.ResponseWriter, r *http.Request) (admin.AuthenticatedSession, bool) {
	if h.adminAuth == nil {
		h.writeError(w, r, http.StatusServiceUnavailable, "admin auth is not configured", protocol.ErrorCodeInternalServerError)
		return admin.AuthenticatedSession{}, false
	}
	session, err := h.adminAuth.AuthenticateRequest(r.Context(), r)
	if err != nil {
		h.writeError(w, r, http.StatusUnauthorized, "unauthorized", protocol.ErrorCodeUnauthorized)
		return admin.AuthenticatedSession{}, false
	}
	return session, true
}

func adminAPIKeyResponseFromMetadata(metadata admin.APIKeyMetadata) adminAPIKeyResponse {
	return adminAPIKeyResponse{
		ID:        metadata.ID,
		Name:      metadata.Name,
		KeyPrefix: metadata.KeyPrefix,
		CreatedAt: metadata.CreatedAt.Format(time.RFC3339),
		CreatedBy: metadata.CreatedBy,
	}
}
