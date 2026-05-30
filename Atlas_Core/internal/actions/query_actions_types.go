package actions

import (
	"fmt"
	"strings"
	"time"

	"github.com/the-drunken-coder/atlas/atlas_core/internal/serializers"
)

// FullDatasetResponse contains all entities, tasks, and objects.
// If any HasMore* field is true, that stream hit its cap and more rows exist in the database.
// Pass the corresponding next_*_cursor value as entity_cursor / task_cursor / object_cursor on the next request to continue.
type FullDatasetResponse struct {
	Entities         []*serializers.EntityResponse `json:"entities"`
	Tasks            []*serializers.TaskResponse   `json:"tasks"`
	Objects          []*serializers.ObjectResponse `json:"objects"`
	HasMoreEntities  bool                          `json:"has_more_entities,omitempty"`
	HasMoreTasks     bool                          `json:"has_more_tasks,omitempty"`
	HasMoreObjects   bool                          `json:"has_more_objects,omitempty"`
	NextEntityCursor string                        `json:"next_entity_cursor,omitempty"`
	NextTaskCursor   string                        `json:"next_task_cursor,omitempty"`
	NextObjectCursor string                        `json:"next_object_cursor,omitempty"`
}

// DeletedResource represents a tombstone for a deleted resource.
// Type is always "entity", "task", or "object" (redundant with which response array it appears in, but uniform for clients).
type DeletedResource struct {
	ID        string `json:"id"`
	Type      string `json:"type"`
	DeletedAt string `json:"deleted_at,omitempty"`
}

// ChangedSinceResponse contains resources modified since a given timestamp.
// If any HasMore* field is true, pass the matching next_*_cursor on the next request (with the same `since`)
// to fetch the remaining rows for that stream without skipping data.
type ChangedSinceResponse struct {
	Entities                []*serializers.EntityResponse `json:"entities"`
	Tasks                   []*serializers.TaskResponse   `json:"tasks"`
	Objects                 []*serializers.ObjectResponse `json:"objects"`
	DeletedEntities         []DeletedResource             `json:"deleted_entities,omitempty"`
	DeletedTasks            []DeletedResource             `json:"deleted_tasks,omitempty"`
	DeletedObjects          []DeletedResource             `json:"deleted_objects,omitempty"`
	HasMoreEntities         bool                          `json:"has_more_entities,omitempty"`
	HasMoreTasks            bool                          `json:"has_more_tasks,omitempty"`
	HasMoreObjects          bool                          `json:"has_more_objects,omitempty"`
	HasMoreDeletedEntities  bool                          `json:"has_more_deleted_entities,omitempty"`
	HasMoreDeletedTasks     bool                          `json:"has_more_deleted_tasks,omitempty"`
	HasMoreDeletedObjects   bool                          `json:"has_more_deleted_objects,omitempty"`
	NextEntityCursor        string                        `json:"next_entity_cursor,omitempty"`
	NextTaskCursor          string                        `json:"next_task_cursor,omitempty"`
	NextObjectCursor        string                        `json:"next_object_cursor,omitempty"`
	NextDeletedEntityCursor string                        `json:"next_deleted_entity_cursor,omitempty"`
	NextDeletedTaskCursor   string                        `json:"next_deleted_task_cursor,omitempty"`
	NextDeletedObjectCursor string                        `json:"next_deleted_object_cursor,omitempty"`
	Timestamp               string                        `json:"timestamp"`
}

// MaxFullQueryLimit is the maximum number of records per type returned by GetFullDataset.
const MaxFullQueryLimit = 1000

// MaxChangedSinceLimit is the default safety cap for changed-since queries.
const MaxChangedSinceLimit = 5000

// FullDatasetLimits holds per-type limits for GetFullDataset.
// Optional cursors continue pagination in created_at DESC, id DESC order (from a prior next_*_cursor).
type FullDatasetLimits struct {
	EntityLimit  int
	TaskLimit    int
	ObjectLimit  int
	EntityCursor *string
	TaskCursor   *string
	ObjectCursor *string
}

// ChangedSinceCursors continues per-type streams for GetDataChangedSince (same `since`, updated_at DESC order).
type ChangedSinceCursors struct {
	EntityCursor        *string
	TaskCursor          *string
	ObjectCursor        *string
	DeletedEntityCursor *string
	DeletedTaskCursor   *string
	DeletedObjectCursor *string
}

type parsedQueryCursor struct {
	timestamp  time.Time
	id         string
	upperBound time.Time
}

func parseQueryCursor(raw, label string) (*parsedQueryCursor, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, nil
	}
	ts, id, upperBound, err := decodeRowCursor(raw)
	if err != nil {
		return nil, NewValidationErrorWithDetails("Invalid query cursor", []string{fmt.Sprintf("invalid %s: %v", label, err)})
	}
	return &parsedQueryCursor{
		timestamp:  ts,
		id:         id,
		upperBound: upperBound,
	}, nil
}

func continuationUpperBound(currentSnapshot time.Time, cursors ...*parsedQueryCursor) (time.Time, bool, error) {
	continuation := false
	var sharedUpperBound time.Time
	for _, cursor := range cursors {
		if cursor == nil {
			continue
		}
		continuation = true
		if cursor.upperBound.IsZero() {
			continue
		}
		if sharedUpperBound.IsZero() {
			sharedUpperBound = cursor.upperBound
			continue
		}
		if !sharedUpperBound.Equal(cursor.upperBound) {
			return time.Time{}, false, NewValidationErrorWithDetails(
				"Invalid query cursor",
				[]string{"query cursors must come from the same snapshot"},
			)
		}
	}
	if !continuation {
		return currentSnapshot, false, nil
	}
	if sharedUpperBound.IsZero() {
		return currentSnapshot, true, nil
	}
	return sharedUpperBound, true, nil
}

// effectiveLimit returns the requested limit capped to the provided max,
// or max if the requested limit is zero or negative.
func effectiveLimit(requested, maxLimit int) int {
	if requested <= 0 || requested > maxLimit {
		return maxLimit
	}
	return requested
}

func trimToLimitWithMore[T any](items []T, limit int) ([]T, bool) {
	if limit < 0 {
		limit = 0
	}
	if len(items) > limit {
		return items[:limit], true
	}
	return items, false
}
