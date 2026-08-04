package handlers

import (
	"net/http"

	commandcatalog "github.com/the-drunken-coder/atlas/atlas_core/command_catalog"
	protocol "github.com/the-drunken-coder/atlas/atlas_protocol/generated/go/atlasprotocol"
)

type protocolRevisionResponse struct {
	ProtocolRevision string `json:"protocol_revision"`
}

// ProtocolRevision returns the generated Atlas Protocol revision used by Core.
func (h *Handler) ProtocolRevision(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, r, http.StatusOK, protocolRevisionResponse{ProtocolRevision: protocol.ProtocolRevision})
}

// CommandCatalog returns Core's authoritative embedded command definitions.
func (h *Handler) CommandCatalog(w http.ResponseWriter, r *http.Request) {
	catalog, err := commandcatalog.Default()
	if err != nil {
		h.logger.Error().Err(err).Msg("Failed to load embedded command catalog")
		h.writeError(w, r, http.StatusInternalServerError, "Failed to load command catalog", protocol.ErrorCodeInternalServerError)
		return
	}
	writeJSON(w, r, http.StatusOK, catalog)
}
