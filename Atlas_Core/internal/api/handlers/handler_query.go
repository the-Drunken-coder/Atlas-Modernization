package handlers

import (
	"fmt"
	"net/http"

	"github.com/the-drunken-coder/atlas/atlas_core/internal/actions"
)

// GetFullDataset handles GET /queries/full.
func (h *Handler) GetFullDataset(w http.ResponseWriter, r *http.Request) {
	limits, invalidField, err := parseFullDatasetLimits(r)
	if err != nil {
		h.writeError(w, r, http.StatusBadRequest, "Invalid "+invalidField+" parameter", "VALIDATION_ERROR")
		return
	}

	data, err := h.queryActions.GetFullDataset(r.Context(), limits)
	if err != nil {
		h.handleActionError(w, r, err)
		return
	}

	writeJSON(w, http.StatusOK, data)
}

// GetChangedSince handles GET /queries/changed-since.
func (h *Handler) GetChangedSince(w http.ResponseWriter, r *http.Request) {
	sinceStr := r.URL.Query().Get("since")
	if sinceStr == "" {
		h.writeError(w, r, http.StatusBadRequest, "since parameter is required", "VALIDATION_ERROR")
		return
	}

	since, err := parseRFC3339Timestamp(sinceStr)
	if err != nil {
		h.writeValidationError(w, r, &actions.ValidationError{
			ActionError: actions.ActionError{
				Message: "Invalid since timestamp format (use RFC3339)",
				Code:    "VALIDATION_ERROR",
			},
			Details: []string{fmt.Sprintf("since: %v", err)},
		})
		return
	}

	limitPerType, err := parseNonNegativeIntQuery(r, "limit_per_type", 0)
	if err != nil {
		h.writeError(w, r, http.StatusBadRequest, "Invalid limit_per_type parameter", "VALIDATION_ERROR")
		return
	}

	cursors := changedSinceCursorsFromQuery(r.URL.Query())
	data, err := h.queryActions.GetDataChangedSince(r.Context(), since, limitPerType, &cursors)
	if err != nil {
		h.handleActionError(w, r, err)
		return
	}

	writeJSON(w, http.StatusOK, data)
}
