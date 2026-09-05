package handlers

import (
	"errors"
	"net/http"
	"time"

	protocol "github.com/the-drunken-coder/atlas/packages/protocol/generated/go/atlasprotocol"
	"github.com/the-drunken-coder/atlas/services/core/internal/admin"
	custommiddleware "github.com/the-drunken-coder/atlas/services/core/internal/api/middleware"
)

type adminLoginRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

type adminUserResponse struct {
	Username  string `json:"username"`
	ExpiresAt string `json:"expires_at,omitempty"`
}

type adminMeResponse struct {
	User adminUserResponse `json:"user"`
}

func (h *Handler) AdminLogin(w http.ResponseWriter, r *http.Request) {
	if h.adminAuth == nil {
		h.writeError(w, r, http.StatusServiceUnavailable, "admin auth is not configured", protocol.ErrorCodeInternalServerError)
		return
	}
	if !h.requireTrustedAdminOrigin(w, r) {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 64*1024)
	var req adminLoginRequest
	if !h.decodeJSONRequestBody(w, r, &req, false) {
		return
	}
	token, session, err := h.adminAuth.Login(r.Context(), req.Username, req.Password, admin.ClientIP(r, h.config.TrustedProxyCIDRs), time.Now().UTC())
	if err != nil {
		if errors.Is(err, admin.ErrInvalidCredentials) {
			h.writeError(w, r, http.StatusUnauthorized, "invalid username or password", protocol.ErrorCodeUnauthorized)
			return
		}
		if errors.Is(err, admin.ErrTooManyAttempts) {
			h.writeError(w, r, http.StatusTooManyRequests, "too many login attempts, try again later", protocol.ErrorCodeTooManyAttempts)
			return
		}
		h.writeErrorWithCause(w, r, http.StatusInternalServerError, "admin login failed", protocol.ErrorCodeInternalServerError, err)
		return
	}
	h.adminAuth.SetSessionCookie(w, token, session.ExpiresAt)
	writeJSON(w, r, http.StatusOK, adminMeResponse{User: adminUserResponse{
		Username:  session.Username,
		ExpiresAt: session.ExpiresAt.Format(time.RFC3339),
	}})
}

func (h *Handler) AdminLogout(w http.ResponseWriter, r *http.Request) {
	if h.adminAuth == nil {
		h.writeError(w, r, http.StatusServiceUnavailable, "admin auth is not configured", protocol.ErrorCodeInternalServerError)
		return
	}
	if !h.requireTrustedAdminOrigin(w, r) {
		return
	}
	if err := h.adminAuth.Logout(r.Context(), r); err != nil {
		h.adminAuth.ClearSessionCookie(w)
		h.writeErrorWithCause(w, r, http.StatusInternalServerError, "admin logout failed", protocol.ErrorCodeInternalServerError, err)
		return
	}
	h.adminAuth.ClearSessionCookie(w)
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) AdminMe(w http.ResponseWriter, r *http.Request) {
	if h.adminAuth == nil {
		h.writeError(w, r, http.StatusServiceUnavailable, "admin auth is not configured", protocol.ErrorCodeInternalServerError)
		return
	}
	session, err := h.adminAuth.AuthenticateRequest(r.Context(), r)
	if err != nil {
		h.writeError(w, r, http.StatusUnauthorized, "unauthorized", protocol.ErrorCodeUnauthorized)
		return
	}
	writeJSON(w, r, http.StatusOK, adminMeResponse{User: adminUserResponse{
		Username:  session.Username,
		ExpiresAt: session.ExpiresAt.Format(time.RFC3339),
	}})
}

func (h *Handler) requireTrustedAdminOrigin(w http.ResponseWriter, r *http.Request) bool {
	if h.config == nil {
		h.writeError(w, r, http.StatusServiceUnavailable, "admin config is not configured", protocol.ErrorCodeInternalServerError)
		return false
	}
	if custommiddleware.TrustedOriginWithPatterns(r.Header.Get("Origin"), h.config.CORSOrigins, h.config.CORSOriginPatterns) {
		return true
	}
	h.writeError(w, r, http.StatusUnauthorized, "unauthorized", protocol.ErrorCodeUnauthorized)
	return false
}
