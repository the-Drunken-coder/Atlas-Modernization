package handlers

import (
	"net/http"

	protocol "github.com/the-drunken-coder/atlas/packages/protocol/generated/go/atlasprotocol"
)

// ProtocolRevision returns the generated Atlas Protocol revision used by Core.
func (h *Handler) ProtocolRevision(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, r, http.StatusOK, protocol.ProtocolRevisionResponse{ProtocolRevision: protocol.ProtocolRevision})
}
