package handlers

import (
	"net/http"

	protocol "github.com/the-drunken-coder/atlas/atlas_protocol/generated/go/atlasprotocol"
)

type protocolRevisionResponse struct {
	ProtocolRevision string `json:"protocol_revision"`
}

// ProtocolRevision returns the generated Atlas Protocol revision used by Core.
func (h *Handler) ProtocolRevision(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, r, http.StatusOK, protocolRevisionResponse{ProtocolRevision: protocol.ProtocolRevision})
}
