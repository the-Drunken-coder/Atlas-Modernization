package handlers

import (
	"net/http"

	"github.com/the-drunken-coder/atlas/atlas_core/internal/feed"
)

// Feed upgrades the request to the Atlas change-feed websocket.
func (h *Handler) Feed(w http.ResponseWriter, r *http.Request) {
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
