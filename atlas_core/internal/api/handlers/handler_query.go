package handlers

import (
	"fmt"
	"net/http"
	"strings"

	"github.com/the-drunken-coder/atlas/atlas_core/internal/actions"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/serializers"
	protocol "github.com/the-drunken-coder/atlas/atlas_protocol/generated/go/atlasprotocol"
)

type fullDatasetResponse struct {
	Entities         []*serializers.EntityResponse    `json:"entities"`
	Tasks            []*serializers.TaskResponse      `json:"tasks"`
	Objects          []*protocol.ObjectDetailResource `json:"objects"`
	Version          int64                            `json:"version"`
	HasMoreEntities  bool                             `json:"has_more_entities"`
	HasMoreTasks     bool                             `json:"has_more_tasks"`
	HasMoreObjects   bool                             `json:"has_more_objects"`
	NextEntityCursor string                           `json:"next_entity_cursor,omitempty"`
	NextTaskCursor   string                           `json:"next_task_cursor,omitempty"`
	NextObjectCursor string                           `json:"next_object_cursor,omitempty"`
}

type changedSinceResponse struct {
	Events     []protocol.FeedEvent `json:"events"`
	Version    int64                `json:"version"`
	HasMore    bool                 `json:"has_more"`
	NextCursor string               `json:"next_cursor,omitempty"`
}

func serializeFullDatasetResult(result *actions.FullDatasetResult) *fullDatasetResponse {
	if result == nil {
		return nil
	}
	return &fullDatasetResponse{
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

func serializeChangedSinceResult(result *actions.ChangedSinceResult) *changedSinceResponse {
	if result == nil {
		return nil
	}
	return &changedSinceResponse{
		Events:     result.Events,
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
