package handlers

import (
	"context"
	"net/http"
	"strings"

	protocol "github.com/the-drunken-coder/atlas/packages/protocol/generated/go/atlasprotocol"
	"github.com/the-drunken-coder/atlas/services/core/internal/actions"
	custommiddleware "github.com/the-drunken-coder/atlas/services/core/internal/api/middleware"
	"github.com/the-drunken-coder/atlas/services/core/internal/config"
	"github.com/the-drunken-coder/atlas/services/core/internal/feed"
)

// Feed upgrades the request to the Atlas change-feed websocket.
func (h *Handler) Feed(w http.ResponseWriter, r *http.Request) {
	if h.feedHub == nil {
		h.writeError(w, r, http.StatusServiceUnavailable, "feed hub is not configured", protocol.ErrorCodeFeedUnavailable)
		return
	}
	if h.config == nil {
		h.writeError(w, r, http.StatusServiceUnavailable, "feed config is not configured", protocol.ErrorCodeFeedUnavailable)
		return
	}
	serverConfig := feedServerConfig(h.config)
	if h.adminAuth != nil {
		serverConfig.APIKeyValidator = h.adminAuth.AuthenticateAPIKeyResult
	}
	authenticated := false
	if serverConfig.EnableAPIAuth {
		valid, err := custommiddleware.ValidAPIKeyOrManagedResult(r, serverConfig.APIKey, h.adminAuth)
		if err != nil {
			h.requestLogger(r).Warn().Err(err).Msg("managed feed API key authentication failed")
		}
		if valid {
			authenticated = true
			serverConfig.EnableAPIAuth = false
			serverConfig.APIKey = ""
			serverConfig.SkipOriginCheck = true
		}
	}
	if !authenticated && h.adminAuth != nil {
		if _, err := h.adminAuth.AuthenticateRequest(r.Context(), r); err == nil {
			if !custommiddleware.TrustedOriginWithPatterns(r.Header.Get("Origin"), h.config.CORSOrigins, h.config.CORSOriginPatterns) {
				h.writeError(w, r, http.StatusUnauthorized, "unauthorized", protocol.ErrorCodeUnauthorized)
				return
			}
			authenticated = true
			serverConfig.EnableAPIAuth = false
			serverConfig.APIKey = ""
		}
	}
	if serverConfig.EnableAPIAuth && serverConfig.APIKey == "" && serverConfig.APIKeyValidator == nil {
		h.writeError(w, r, http.StatusServiceUnavailable, "feed API key is not configured", protocol.ErrorCodeFeedUnavailable)
		return
	}
	if !serverConfig.EnableAPIAuth && !authenticated {
		h.writeError(w, r, http.StatusUnauthorized, "unauthorized", protocol.ErrorCodeUnauthorized)
		return
	}
	server := feed.Server{
		Hub:    h.feedHub,
		Config: serverConfig,
		CurrentVersion: func(ctx context.Context) (int64, error) {
			return actions.CurrentChangeVersion(ctx, h.db.Pool)
		},
	}
	server.ServeHTTP(w, r)
}

func feedServerConfig(cfg *config.Config) feed.ServerConfig {
	return feed.ServerConfig{
		EnableAPIAuth: cfg.EnableAPIAuth,
		APIKey:        strings.TrimSpace(cfg.APIAuthKey),
		AllowedOrigin: func(origin string) bool {
			return custommiddleware.TrustedOriginWithPatterns(origin, cfg.CORSOrigins, cfg.CORSOriginPatterns)
		},
	}
}
