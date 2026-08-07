package handlers

import (
	"net/http"
	"strings"

	commandcatalog "github.com/the-drunken-coder/atlas/atlas_core/command_catalog"
	protocol "github.com/the-drunken-coder/atlas/atlas_protocol/generated/go/atlasprotocol"
)

// GetCommandCatalog serves the exact catalog embedded into the running Core
// binary. The strong ETag changes only when that source changes.
func (h *Handler) GetCommandCatalog(w http.ResponseWriter, r *http.Request) {
	data, err := commandcatalog.JSON()
	if err != nil {
		h.logger.Error().Err(err).Msg("read embedded command catalog")
		h.writeErrorWithCause(w, r, http.StatusInternalServerError, "read command catalog failed", protocol.ErrorCodeInternalServerError, err)
		return
	}
	etag, err := commandcatalog.ETag()
	if err != nil {
		h.logger.Error().Err(err).Msg("hash embedded command catalog")
		h.writeErrorWithCause(w, r, http.StatusInternalServerError, "hash command catalog failed", protocol.ErrorCodeInternalServerError, err)
		return
	}
	w.Header().Set("Cache-Control", "private, no-cache")
	w.Header().Set("ETag", etag)
	if etagMatches(r.Header.Get("If-None-Match"), etag) {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	if _, err := w.Write(data); err != nil {
		h.logger.Error().Err(err).Msg("write embedded command catalog")
	}
}

func etagMatches(header, etag string) bool {
	etag = strings.TrimPrefix(etag, "W/")
	for candidate := range strings.SplitSeq(header, ",") {
		candidate = strings.TrimSpace(candidate)
		if candidate == "*" || strings.TrimPrefix(candidate, "W/") == etag {
			return true
		}
	}
	return false
}
