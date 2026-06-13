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
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		writeJSON(w, http.StatusMethodNotAllowed, protocol.ErrorResponse{
			Success:   false,
			Message:   "method not allowed",
			ErrorCode: protocol.ErrorCodeValidationError,
			Path:      r.URL.Path,
		})
		return
	}
	writeJSON(w, http.StatusOK, protocolRevisionResponse{ProtocolRevision: protocol.ProtocolRevision})
}
