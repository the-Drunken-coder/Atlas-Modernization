package handlers

import (
	"fmt"
	"net/http"
	"strings"

	protocol "github.com/the-drunken-coder/atlas/packages/protocol/generated/go/atlasprotocol"
	"github.com/the-drunken-coder/atlas/services/core/internal/actions"
	"github.com/the-drunken-coder/atlas/services/core/internal/serializers"
)

func serializeFullDatasetResult(result *actions.FullDatasetResult) *protocol.FullDatasetResponse {
	if result == nil {
		return nil
	}
	return &protocol.FullDatasetResponse{
		Entities:         serializers.SerializeEntities(result.Entities),
		Tasks:            serializers.SerializeTasks(result.Tasks),
		Objects:          serializers.SerializeObjects(result.Objects),
		Version:          result.Version,
		HasMoreEntities:  result.HasMoreEntities,
		HasMoreTasks:     result.HasMoreTasks,
		HasMoreObjects:   result.HasMoreObjects,
		NextEntityCursor: result.NextEntityCursor,
		NextTaskCursor:   result.NextTaskCursor,
		NextObjectCursor: result.NextObjectCursor,
	}
}

func serializeChangedSinceResult(result *actions.ChangedSinceResult) *protocol.ChangedSinceResponse {
	if result == nil {
		return nil
	}
	events := result.Events
	if events == nil {
		events = []protocol.FeedEvent{}
	}
	return &protocol.ChangedSinceResponse{
		Events:     events,
		Version:    result.Version,
		HasMore:    result.HasMore,
		NextCursor: result.NextCursor,
	}
}

// GetFullDataset handles GET /queries/full.
func (h *Handler) GetFullDataset(w http.ResponseWriter, r *http.Request) {
	limits, invalidField, err := parseFullDatasetLimits(r)
	if err != nil {
		h.writeError(w, r, http.StatusBadRequest, "Invalid "+invalidField+" parameter", protocol.ErrorCodeValidationError)
		return
	}

	data, err := h.queryActions.GetFullDataset(r.Context(), limits)
	if err != nil {
		h.handleActionError(w, r, err)
		return
	}

	writeJSON(w, r, http.StatusOK, serializeFullDatasetResult(data))
}

// GetChangedSince handles GET /queries/changed-since.
func (h *Handler) GetChangedSince(w http.ResponseWriter, r *http.Request) {
	if _, present := r.URL.Query()["offset"]; present {
		h.writeError(w, r, http.StatusBadRequest, "offset is not supported for changed-since queries", protocol.ErrorCodeValidationError)
		return
	}
	if strings.TrimSpace(r.URL.Query().Get("since_version")) == "" {
		h.writeError(w, r, http.StatusBadRequest, "since_version parameter is required", protocol.ErrorCodeValidationError)
		return
	}

	sinceVersion, err := parseNonNegativeInt64Query(r, "since_version", 0)
	if err != nil {
		h.writeValidationError(w, r, &actions.ValidationError{
			ActionError: actions.ActionError{
				Message: "Invalid since_version format (use non-negative integer)",
				Code:    protocol.ErrorCodeValidationError,
			},
			Details: []string{fmt.Sprintf("since_version: %v", err)},
		})
		return
	}

	limit, err := parseNonNegativeIntQuery(r, "limit", 0)
	if err != nil {
		h.writeError(w, r, http.StatusBadRequest, "Invalid limit parameter", protocol.ErrorCodeValidationError)
		return
	}

	cursor := optionalQueryString(r.URL.Query(), "cursor")
	data, err := h.queryActions.GetDataChangedSince(r.Context(), sinceVersion, limit, cursor)
	if err != nil {
		h.handleActionError(w, r, err)
		return
	}

	writeJSON(w, r, http.StatusOK, serializeChangedSinceResult(data))
}
