package handlers

import (
	"net/http"

	"github.com/the-drunken-coder/atlas/atlas_core/internal/feed"
)

// Feed upgrades the request to the Atlas change-feed websocket.
func (h *Handler) Feed(w http.ResponseWriter, r *http.Request) {
	if h.feedHub == nil {
		http.Error(w, "feed hub is not configured", http.StatusServiceUnavailable)
		return
	}
	if h.config == nil {
		http.Error(w, "feed config is not configured", http.StatusServiceUnavailable)
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
