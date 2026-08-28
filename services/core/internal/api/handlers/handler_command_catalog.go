package handlers

import (
	"crypto/sha256"
	"fmt"
	"net/http"
	"strings"

	protocol "github.com/the-drunken-coder/atlas/packages/protocol/generated/go/atlasprotocol"
)

// GetCommandCatalog serves the exact catalog embedded into the running Core
// binary. The strong ETag changes only when that source changes.
func (h *Handler) GetCommandCatalog(w http.ResponseWriter, r *http.Request) {
	data := []byte(protocol.CommandCatalogJSON)
	etag := fmt.Sprintf(`"%x"`, sha256.Sum256(data))
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
