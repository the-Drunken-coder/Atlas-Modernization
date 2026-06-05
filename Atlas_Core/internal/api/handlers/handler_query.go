package handlers

import (
	"fmt"
	"net/http"

	"github.com/the-drunken-coder/atlas/atlas_core/internal/actions"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/serializers"
)

type fullDatasetResponse struct {
	Entities         []*serializers.EntityResponse `json:"entities"`
	Tasks            []*serializers.TaskResponse   `json:"tasks"`
	Objects          []*serializers.ObjectResponse `json:"objects"`
	HasMoreEntities  bool                          `json:"has_more_entities"`
	HasMoreTasks     bool                          `json:"has_more_tasks"`
	HasMoreObjects   bool                          `json:"has_more_objects"`
	NextEntityCursor string                        `json:"next_entity_cursor,omitempty"`
	NextTaskCursor   string                        `json:"next_task_cursor,omitempty"`
	NextObjectCursor string                        `json:"next_object_cursor,omitempty"`
}

type deletedResourceResponse struct {
	ID        string `json:"id"`
	Type      string `json:"type"`
	DeletedAt string `json:"deleted_at,omitempty"`
	Version   int64  `json:"version,omitempty"`
}

type changedSinceResponse struct {
	Entities                []*serializers.EntityResponse `json:"entities"`
	Tasks                   []*serializers.TaskResponse   `json:"tasks"`
	Objects                 []*serializers.ObjectResponse `json:"objects"`
	DeletedEntities         []deletedResourceResponse     `json:"deleted_entities,omitempty"`
	DeletedTasks            []deletedResourceResponse     `json:"deleted_tasks,omitempty"`
	DeletedObjects          []deletedResourceResponse     `json:"deleted_objects,omitempty"`
	HasMoreEntities         bool                          `json:"has_more_entities"`
	HasMoreTasks            bool                          `json:"has_more_tasks"`
	HasMoreObjects          bool                          `json:"has_more_objects"`
	HasMoreDeletedEntities  bool                          `json:"has_more_deleted_entities"`
	HasMoreDeletedTasks     bool                          `json:"has_more_deleted_tasks"`
	HasMoreDeletedObjects   bool                          `json:"has_more_deleted_objects"`
	NextEntityCursor        string                        `json:"next_entity_cursor,omitempty"`
	NextTaskCursor          string                        `json:"next_task_cursor,omitempty"`
	NextObjectCursor        string                        `json:"next_object_cursor,omitempty"`
	NextDeletedEntityCursor string                        `json:"next_deleted_entity_cursor,omitempty"`
	NextDeletedTaskCursor   string                        `json:"next_deleted_task_cursor,omitempty"`
	NextDeletedObjectCursor string                        `json:"next_deleted_object_cursor,omitempty"`
	Version                 int64                         `json:"version"`
	Timestamp               string                        `json:"timestamp"`
}

func serializeFullDatasetResult(result *actions.FullDatasetResult) *fullDatasetResponse {
	if result == nil {
		return nil
	}
	return &fullDatasetResponse{
		Entities:         serializers.SerializeEntities(result.Entities),
		Tasks:            serializers.SerializeTasks(result.Tasks),
		Objects:          serializers.SerializeObjects(result.Objects),
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
		Entities:                serializers.SerializeEntities(result.Entities),
		Tasks:                   serializers.SerializeTasks(result.Tasks),
		Objects:                 serializers.SerializeObjects(result.Objects),
		DeletedEntities:         serializeDeletedResources(result.DeletedEntities),
		DeletedTasks:            serializeDeletedResources(result.DeletedTasks),
		DeletedObjects:          serializeDeletedResources(result.DeletedObjects),
		HasMoreEntities:         result.HasMoreEntities,
		HasMoreTasks:            result.HasMoreTasks,
		HasMoreObjects:          result.HasMoreObjects,
		HasMoreDeletedEntities:  result.HasMoreDeletedEntities,
		HasMoreDeletedTasks:     result.HasMoreDeletedTasks,
		HasMoreDeletedObjects:   result.HasMoreDeletedObjects,
		NextEntityCursor:        result.NextEntityCursor,
		NextTaskCursor:          result.NextTaskCursor,
		NextObjectCursor:        result.NextObjectCursor,
		NextDeletedEntityCursor: result.NextDeletedEntityCursor,
		NextDeletedTaskCursor:   result.NextDeletedTaskCursor,
		NextDeletedObjectCursor: result.NextDeletedObjectCursor,
		Version:                 result.Version,
		Timestamp:               result.Timestamp,
	}
}

func serializeDeletedResources(resources []actions.DeletedResource) []deletedResourceResponse {
	result := make([]deletedResourceResponse, len(resources))
	for i, resource := range resources {
		result[i] = deletedResourceResponse{
			ID:        resource.ID,
			Type:      resource.Type,
			DeletedAt: resource.DeletedAt,
			Version:   resource.Version,
		}
	}
	return result
}

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

	writeJSON(w, http.StatusOK, serializeFullDatasetResult(data))
}

// GetChangedSince handles GET /queries/changed-since.
func (h *Handler) GetChangedSince(w http.ResponseWriter, r *http.Request) {
	if r.URL.Query().Get("since_version") == "" {
		h.writeError(w, r, http.StatusBadRequest, "since_version parameter is required", "VALIDATION_ERROR")
		return
	}

	sinceVersion, err := parseNonNegativeInt64Query(r, "since_version", 0)
	if err != nil {
		h.writeValidationError(w, r, &actions.ValidationError{
			ActionError: actions.ActionError{
				Message: "Invalid since_version format (use non-negative integer)",
				Code:    "VALIDATION_ERROR",
			},
			Details: []string{fmt.Sprintf("since_version: %v", err)},
		})
		return
	}

	limitPerType, err := parseNonNegativeIntQuery(r, "limit_per_type", 0)
	if err != nil {
		h.writeError(w, r, http.StatusBadRequest, "Invalid limit_per_type parameter", "VALIDATION_ERROR")
		return
	}

	cursors := changedSinceCursorsFromQuery(r.URL.Query())
	data, err := h.queryActions.GetDataChangedSince(r.Context(), sinceVersion, limitPerType, &cursors)
	if err != nil {
		h.handleActionError(w, r, err)
		return
	}

	writeJSON(w, http.StatusOK, serializeChangedSinceResult(data))
}
