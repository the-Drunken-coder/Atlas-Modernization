package actions

import (
	"fmt"
	"strings"
	"time"

	"github.com/the-drunken-coder/atlas/services/core/internal/models"
	protocol "github.com/the-drunken-coder/atlas/packages/protocol/generated/go/atlasprotocol"
)

// FullDatasetResult contains all entities, tasks, and objects returned by the action layer.
// If any HasMore* field is true, that stream hit its cap and more rows exist in the database.
// Pass the corresponding next_*_cursor value as entity_cursor / task_cursor / object_cursor on the next request to continue.
type FullDatasetResult struct {
	Entities []*models.Entity
	Tasks    []*models.Task
	Objects  []*models.MediaObject
	// Version is the committed global change baseline captured by the first page and repeated by every continuation.
	Version          int64
	HasMoreEntities  bool
	HasMoreTasks     bool
	HasMoreObjects   bool
	NextEntityCursor string
	NextTaskCursor   string
	NextObjectCursor string
}

// ChangedSinceResult is one globally ordered page from the durable change log.
type ChangedSinceResult struct {
	Events     []protocol.FeedEvent
	Version    int64
	HasMore    bool
	NextCursor string
}

// MaxFullQueryLimit is the maximum number of records per type returned by GetFullDataset.
const MaxFullQueryLimit = 1000

// A full-query page stops before retaining more than this much raw JSON for
// any one resource stream. Per-stream budgets keep every stream independently
// cursorable when another stream contains larger records.
const maxQueryJSONBytesPerType = 8 * maxStoredJSONBlobBytes

// DefaultChangedSinceLimit keeps ordinary recovery pages small enough to apply
// incrementally. Clients may request more events, but the byte budget below is
// always authoritative.
const DefaultChangedSinceLimit = 100

// MaxChangedSinceLimit caps an explicit changed-since event count.
const MaxChangedSinceLimit = 5000

// A changed-since page stops before retaining more than this much serialized
// event JSON. The first event is always returned so an oversized event cannot
// prevent cursor progress.
const maxChangedSinceJSONBytes = 8 * maxStoredJSONBlobBytes

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

type parsedQueryCursor struct {
	timestamp    time.Time
	id           string
	upperBound   time.Time
	upperVersion int64
}

type parsedVersionCursor struct {
	version      int64
	upperBound   int64
	sinceVersion int64
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

func parseFullDatasetCursor(raw, label string) (*parsedQueryCursor, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, nil
	}
	timestamp, id, upperBound, upperVersion, err := decodeFullDatasetCursor(raw)
	if err != nil {
		return nil, NewValidationErrorWithDetails("Invalid query cursor", []string{fmt.Sprintf("invalid %s: %v", label, err)})
	}
	return &parsedQueryCursor{
		timestamp:    timestamp,
		id:           id,
		upperBound:   upperBound,
		upperVersion: upperVersion,
	}, nil
}

func parseVersionQueryCursor(raw, label string) (*parsedVersionCursor, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, nil
	}
	version, upperBound, sinceVersion, err := decodeVersionCursor(raw)
	if err != nil {
		return nil, NewValidationErrorWithDetails("Invalid query cursor", []string{fmt.Sprintf("invalid %s: %v", label, err)})
	}
	return &parsedVersionCursor{
		version:      version,
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
			return time.Time{}, false, NewValidationErrorWithDetails(
				"Invalid query cursor",
				[]string{"query cursors must include a snapshot time"},
			)
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
	return clampCursorUpperBound(sharedUpperBound, currentSnapshot), true, nil
}

func fullDatasetSnapshotVersion(currentSnapshot int64, cursors ...*parsedQueryCursor) (int64, error) {
	var sharedVersion int64
	for _, cursor := range cursors {
		if cursor == nil {
			continue
		}
		if cursor.upperVersion <= 0 {
			return 0, NewValidationErrorWithDetails(
				"Invalid query cursor",
				[]string{"full dataset cursors must include a snapshot version"},
			)
		}
		if sharedVersion == 0 {
			sharedVersion = cursor.upperVersion
			continue
		}
		if sharedVersion != cursor.upperVersion {
			return 0, NewValidationErrorWithDetails(
				"Invalid query cursor",
				[]string{"query cursors must come from the same version snapshot"},
			)
		}
	}
	if sharedVersion == 0 {
		return currentSnapshot, nil
	}
	if sharedVersion > currentSnapshot {
		return 0, NewValidationErrorWithDetails(
			"Invalid query cursor",
			[]string{fmt.Sprintf("query cursor snapshot version %d is newer than current version %d", sharedVersion, currentSnapshot)},
		)
	}
	return sharedVersion, nil
}

func clampCursorUpperBound(candidate, ceiling time.Time) time.Time {
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
