package handlers

import (
	"net/http"

	"github.com/the-drunken-coder/atlas/atlas_core/internal/feed"
	protocol "github.com/the-drunken-coder/atlas/atlas_protocol/generated/go/atlasprotocol"
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
	server := feed.Server{
		Hub: h.feedHub,
		Config: feed.ServerConfig{
			EnableAPIAuth:  h.config.EnableAPIAuth,
			APIKey:         h.config.APIAuthKey,
			OriginPatterns: h.config.CORSOrigins,
		},
	}
	server.ServeHTTP(w, r)
}
