package handlers

import (
	"net/http"
	"strings"

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
	apiKey := strings.TrimSpace(h.config.APIAuthKey)
	if h.config.EnableAPIAuth && apiKey == "" {
		h.logger.Error().Str("method", r.Method).Str("path", r.URL.Path).Msg("Atlas feed handler has auth enabled without an API key")
		h.writeError(w, r, http.StatusServiceUnavailable, "feed API key is not configured", protocol.ErrorCodeFeedUnavailable)
		return
	}
	server := feed.Server{
		Hub: h.feedHub,
		Config: feed.ServerConfig{
			EnableAPIAuth:  h.config.EnableAPIAuth,
			APIKey:         apiKey,
			OriginPatterns: h.config.CORSOrigins,
		},
	}
	server.ServeHTTP(w, r)
}
