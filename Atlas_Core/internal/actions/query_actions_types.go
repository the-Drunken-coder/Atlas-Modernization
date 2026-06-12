package actions

import (
	"fmt"
	"strings"
	"time"

	"github.com/the-drunken-coder/atlas/atlas_core/internal/models"
)

// FullDatasetResult contains all entities, tasks, and objects returned by the action layer.
// If any HasMore* field is true, that stream hit its cap and more rows exist in the database.
// Pass the corresponding next_*_cursor value as entity_cursor / task_cursor / object_cursor on the next request to continue.
type FullDatasetResult struct {
	Entities         []*models.Entity
	Tasks            []*models.Task
	Objects          []*models.MediaObject
	HasMoreEntities  bool
	HasMoreTasks     bool
	HasMoreObjects   bool
	NextEntityCursor string
	NextTaskCursor   string
	NextObjectCursor string
}

// DeletedResource represents a tombstone for a deleted resource.
// Type is always "entity", "task", or "object" (redundant with which response array it appears in, but uniform for clients).
type DeletedResource struct {
	ID   string
	Type string
	// EntityID is populated only for deleted tasks to identify the parent entity.
	// Nil means "not applicable", including deleted entities/objects and tasks whose parent entity is NULL.
	EntityID  *string
	DeletedAt string
	Version   int64
}

// ChangedSinceResult contains resources modified after a given change version.
// If any HasMore* field is true, pass the matching next_*_cursor on the next request (with the same `since_version`)
// to fetch the remaining rows for that stream without skipping data.
type ChangedSinceResult struct {
	Entities                []*models.Entity
	Tasks                   []*models.Task
	Objects                 []*models.MediaObject
	DeletedEntities         []DeletedResource
	DeletedTasks            []DeletedResource
	DeletedObjects          []DeletedResource
	HasMoreEntities         bool
	HasMoreTasks            bool
	HasMoreObjects          bool
	HasMoreDeletedEntities  bool
	HasMoreDeletedTasks     bool
	HasMoreDeletedObjects   bool
	NextEntityCursor        string
	NextTaskCursor          string
	NextObjectCursor        string
	NextDeletedEntityCursor string
	NextDeletedTaskCursor   string
	NextDeletedObjectCursor string
	Version                 int64
	Timestamp               string
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

// ChangedSinceCursors continues per-type streams for GetDataChangedSince (same `since_version`, version DESC order).
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

type parsedVersionCursor struct {
	version      int64
	id           string
	upperBound   int64
	sinceVersion int64
}

type labeledVersionCursor struct {
	label  string
	cursor *parsedVersionCursor
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

func parseVersionQueryCursor(raw, label string) (*parsedVersionCursor, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, nil
	}
	version, id, upperBound, sinceVersion, err := decodeVersionCursor(raw)
	if err != nil {
		return nil, NewValidationErrorWithDetails("Invalid query cursor", []string{fmt.Sprintf("invalid %s: %v", label, err)})
	}
	return &parsedVersionCursor{
		version:      version,
		id:           id,
		upperBound:   upperBound,
		sinceVersion: sinceVersion,
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
	return clampCursorUpperBound(sharedUpperBound, currentSnapshot), true, nil
}

func effectiveCursorUpperBound(cursor *parsedQueryCursor, snapshotUpperBound time.Time) time.Time {
	if cursor == nil {
		return snapshotUpperBound
	}
	return clampCursorUpperBound(cursor.upperBound, snapshotUpperBound)
}

func continuationVersionUpperBound(currentSnapshot int64, cursors ...*parsedVersionCursor) (int64, bool, error) {
	continuation := false
	var sharedUpperBound int64
	for _, cursor := range cursors {
		if cursor == nil {
			continue
		}
		continuation = true
		if cursor.upperBound == 0 {
			continue
		}
		if sharedUpperBound == 0 {
			sharedUpperBound = cursor.upperBound
			continue
		}
		if sharedUpperBound != cursor.upperBound {
			return 0, false, NewValidationErrorWithDetails(
				"Invalid query cursor",
				[]string{"query cursors must come from the same snapshot"},
			)
		}
	}
	if !continuation {
		return currentSnapshot, false, nil
	}
	if sharedUpperBound == 0 {
		return currentSnapshot, true, nil
	}
	return clampVersionCursorUpperBound(sharedUpperBound, currentSnapshot), true, nil
}

func validateVersionCursorsSinceVersion(sinceVersion int64, cursors ...labeledVersionCursor) error {
	for _, item := range cursors {
		if item.cursor == nil {
			continue
		}
		if item.cursor.sinceVersion != sinceVersion {
			return NewValidationErrorWithDetails(
				"Invalid query cursor",
				[]string{fmt.Sprintf("%s was created for since_version %d, got %d", item.label, item.cursor.sinceVersion, sinceVersion)},
			)
		}
	}
	return nil
}

func effectiveVersionCursorUpperBound(cursor *parsedVersionCursor, snapshotUpperBound int64) int64 {
	if cursor == nil {
		return snapshotUpperBound
	}
	return clampVersionCursorUpperBound(cursor.upperBound, snapshotUpperBound)
}

func clampVersionCursorUpperBound(candidate, ceiling int64) int64 {
	if candidate <= 0 {
		return ceiling
	}
	if ceiling <= 0 || candidate <= ceiling {
		return candidate
	}
	return ceiling
}

func clampCursorUpperBound(candidate, ceiling time.Time) time.Time {
	if candidate.IsZero() {
		return ceiling
	}
	if ceiling.IsZero() || candidate.Before(ceiling) || candidate.Equal(ceiling) {
		return candidate
	}
	return ceiling
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
