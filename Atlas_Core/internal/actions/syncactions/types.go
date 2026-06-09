package syncactions

import (
	"github.com/the-drunken-coder/atlas/atlas_core/internal/actions"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/models"
)

// MaxFullQueryLimit is the maximum number of records per type returned by GetFullDataset.
const MaxFullQueryLimit = 1000

// MaxChangedSinceLimit is the default safety cap for changed-since queries.
const MaxChangedSinceLimit = 5000

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

// ChangedSinceResult contains resources modified after a given change version.
// If any HasMore* field is true, pass the matching next_*_cursor on the next request (with the same `since_version`)
// to fetch the remaining rows for that stream without skipping data.
type ChangedSinceResult struct {
	Entities                []*models.Entity
	Tasks                   []*models.Task
	Objects                 []*models.MediaObject
	DeletedEntities         []actions.DeletedResource
	DeletedTasks            []actions.DeletedResource
	DeletedObjects          []actions.DeletedResource
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

// effectiveLimit returns the requested limit capped to the provided max,
// or max if the requested limit is zero or negative.
func effectiveLimit(requested, maxLimit int) int {
	if requested <= 0 || requested > maxLimit {
		return maxLimit
	}
	return requested
}

func skipCursorStream[T any](continuation bool, cursor *T) bool {
	return continuation && cursor == nil
}
