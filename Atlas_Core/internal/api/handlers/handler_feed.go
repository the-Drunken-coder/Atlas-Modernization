package handlers

import (
	"net/http"
	"net/url"
	"strings"

	custommiddleware "github.com/the-drunken-coder/atlas/atlas_core/internal/api/middleware"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/config"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/feed"
	protocol "github.com/the-drunken-coder/atlas/atlas_protocol/generated/go/atlasprotocol"
)

// Feed upgrades the request to the Atlas change-feed websocket.
func (h *Handler) Feed(w http.ResponseWriter, r *http.Request) {
	if h.feedHub == nil {
		h.logger.Error().Str("method", r.Method).Str("path", r.URL.Path).Msg("Atlas feed handler is missing feed hub")
		h.writeError(w, r, http.StatusServiceUnavailable, "feed hub is not configured", protocol.ErrorCodeFeedUnavailable)
		return
	}
	if h.config == nil {
		h.logger.Error().Str("method", r.Method).Str("path", r.URL.Path).Msg("Atlas feed handler is missing config")
		h.writeError(w, r, http.StatusServiceUnavailable, "feed config is not configured", protocol.ErrorCodeFeedUnavailable)
		return
	}
	serverConfig := feedServerConfig(h.config)
	if h.adminAuth != nil {
		if _, err := h.adminAuth.AuthenticateRequest(r.Context(), r); err == nil {
			if !custommiddleware.TrustedOrigin(r.Header.Get("Origin"), h.config.CORSOrigins) {
				h.writeError(w, r, http.StatusUnauthorized, "unauthorized", protocol.ErrorCodeUnauthorized)
				return
			}
			serverConfig.EnableAPIAuth = false
			serverConfig.APIKey = ""
		}
	}
	if serverConfig.EnableAPIAuth && custommiddleware.ValidAPIKey(r, serverConfig.APIKey) {
		serverConfig.EnableAPIAuth = false
		serverConfig.APIKey = ""
	}
	if serverConfig.EnableAPIAuth && serverConfig.APIKey == "" {
		h.logger.Error().Str("method", r.Method).Str("path", r.URL.Path).Msg("Atlas feed handler has auth enabled without an API key")
		h.writeError(w, r, http.StatusServiceUnavailable, "feed API key is not configured", protocol.ErrorCodeFeedUnavailable)
		return
	}
	server := feed.Server{
		Hub:    h.feedHub,
		Config: serverConfig,
	}
	server.ServeHTTP(w, r)
}

func feedServerConfig(cfg *config.Config) feed.ServerConfig {
	return feed.ServerConfig{
		EnableAPIAuth:  cfg.EnableAPIAuth,
		APIKey:         strings.TrimSpace(cfg.APIAuthKey),
		OriginPatterns: websocketOriginPatterns(cfg.CORSOrigins),
	}
}

func websocketOriginPatterns(origins []string) []string {
	patterns := make([]string, 0, len(origins))
	for _, origin := range origins {
		origin = strings.TrimSpace(origin)
		if origin == "" {
			continue
		}
		parsed, err := url.Parse(origin)
		if err == nil && parsed.Host != "" {
			patterns = append(patterns, parsed.Host)
			continue
		}
		patterns = append(patterns, origin)
	}
	return patterns
}
