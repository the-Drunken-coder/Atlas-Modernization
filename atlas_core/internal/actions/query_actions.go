package actions

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/models"
	protocol "github.com/the-drunken-coder/atlas/atlas_protocol/generated/go/atlasprotocol"
)

// QueryActions handles query operations across multiple resource types.
type QueryActions struct {
	pool *pgxpool.Pool
}

// NewQueryActions creates a new QueryActions instance.
func NewQueryActions(pool *pgxpool.Pool) *QueryActions {
	return &QueryActions{pool: pool}
}

// GetFullDataset retrieves all entities, tasks, and objects (up to limit each).
func (a *QueryActions) GetFullDataset(ctx context.Context, limits *FullDatasetLimits) (*FullDatasetResult, error) {
	entityLimit := MaxFullQueryLimit
	taskLimit := MaxFullQueryLimit
	objectLimit := MaxFullQueryLimit
	var entCurRaw, taskCurRaw, objCurRaw string
	if limits != nil {
		entityLimit = effectiveLimit(limits.EntityLimit, MaxFullQueryLimit)
		taskLimit = effectiveLimit(limits.TaskLimit, MaxFullQueryLimit)
		objectLimit = effectiveLimit(limits.ObjectLimit, MaxFullQueryLimit)
		if limits.EntityCursor != nil {
			entCurRaw = *limits.EntityCursor
		}
		if limits.TaskCursor != nil {
			taskCurRaw = *limits.TaskCursor
		}
		if limits.ObjectCursor != nil {
			objCurRaw = *limits.ObjectCursor
		}
	}

	tx, err := a.pool.BeginTx(ctx, pgx.TxOptions{
		IsoLevel:   pgx.RepeatableRead,
		AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return nil, fmt.Errorf("begin transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var txUpperBound time.Time
	if err := tx.QueryRow(ctx, `SELECT statement_timestamp()`).Scan(&txUpperBound); err != nil {
		return nil, fmt.Errorf("read snapshot timestamp: %w", err)
	}
	txSnapshotVersion, err := readSnapshotVersion(ctx, tx)
	if err != nil {
		return nil, err
	}

	entCur, err := parseFullDatasetCursor(entCurRaw, "entity_cursor")
	if err != nil {
		return nil, err
	}
	taskCur, err := parseFullDatasetCursor(taskCurRaw, "task_cursor")
	if err != nil {
		return nil, err
	}
	objCur, err := parseFullDatasetCursor(objCurRaw, "object_cursor")
	if err != nil {
		return nil, err
	}
	snapshotUpperBound, continuation, err := continuationUpperBound(txUpperBound, entCur, taskCur, objCur)
	if err != nil {
		return nil, err
	}
	snapshotVersion, err := fullDatasetSnapshotVersion(txSnapshotVersion, entCur, taskCur, objCur)
	if err != nil {
		return nil, err
	}

	var entities []*models.Entity
	var hasMoreEnt bool
	if !skipCursorStream(continuation, entCur) {
		entities, hasMoreEnt, err = queryEntities(ctx, tx, "created_at", time.Time{}, snapshotUpperBound, entCur != nil, entCur, entityLimit, maxQueryJSONBytesPerType)
		if err != nil {
			return nil, err
		}
	}

	var tasks []*models.Task
	var hasMoreTasks bool
	if !skipCursorStream(continuation, taskCur) {
		tasks, hasMoreTasks, err = queryTasks(ctx, tx, "created_at", time.Time{}, snapshotUpperBound, taskCur != nil, taskCur, taskLimit, maxQueryJSONBytesPerType)
		if err != nil {
			return nil, err
		}
	}

	var objects []*models.MediaObject
	var hasMoreObj bool
	if !skipCursorStream(continuation, objCur) {
		objects, hasMoreObj, err = queryObjects(ctx, tx, "created_at", time.Time{}, snapshotUpperBound, objCur != nil, objCur, objectLimit, maxQueryJSONBytesPerType)
		if err != nil {
			return nil, err
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit transaction: %w", err)
	}

	resp := &FullDatasetResult{
		Entities:        entities,
		Tasks:           tasks,
		Objects:         objects,
		Version:         snapshotVersion,
		HasMoreEntities: hasMoreEnt,
		HasMoreTasks:    hasMoreTasks,
		HasMoreObjects:  hasMoreObj,
	}
	if hasMoreEnt && len(entities) > 0 {
		last := entities[len(entities)-1]
		cur, err := encodeFullDatasetCursor(last.CreatedAt, last.EntityID, snapshotUpperBound, snapshotVersion)
		if err != nil {
			return nil, fmt.Errorf("encode entity cursor: %w", err)
		}
		resp.NextEntityCursor = cur
	}
	if hasMoreTasks && len(tasks) > 0 {
		last := tasks[len(tasks)-1]
		cur, err := encodeFullDatasetCursor(last.CreatedAt, last.TaskID, snapshotUpperBound, snapshotVersion)
		if err != nil {
			return nil, fmt.Errorf("encode task cursor: %w", err)
		}
		resp.NextTaskCursor = cur
	}
	if hasMoreObj && len(objects) > 0 {
		last := objects[len(objects)-1]
		cur, err := encodeFullDatasetCursor(last.CreatedAt, last.ObjectID, snapshotUpperBound, snapshotVersion)
		if err != nil {
			return nil, fmt.Errorf("encode object cursor: %w", err)
		}
		resp.NextObjectCursor = cur
	}
	return resp, nil
}

// GetDataChangedSince retrieves one globally ordered page of committed events.
func (a *QueryActions) GetDataChangedSince(ctx context.Context, sinceVersion int64, limit int, cursor *string) (*ChangedSinceResult, error) {
	limit = effectiveLimit(limit, MaxChangedSinceLimit)

	tx, err := a.pool.BeginTx(ctx, pgx.TxOptions{
		IsoLevel:   pgx.RepeatableRead,
		AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return nil, fmt.Errorf("begin transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	snapshotVersion, err := readSnapshotVersion(ctx, tx)
	if err != nil {
		return nil, err
	}
	if sinceVersion > snapshotVersion {
		return nil, NewValidationErrorWithDetails("Invalid since_version", []string{fmt.Sprintf("since_version %d is newer than the current change version %d", sinceVersion, snapshotVersion)})
	}

	afterVersion := sinceVersion
	snapshotUpperVersion := snapshotVersion
	if cursor != nil {
		parsed, err := parseVersionQueryCursor(*cursor, "cursor")
		if err != nil {
			return nil, err
		}
		if parsed == nil {
			return nil, NewValidationErrorWithDetails("Invalid query cursor", []string{"cursor must not be empty"})
		}
		if parsed.sinceVersion != sinceVersion {
			return nil, NewValidationErrorWithDetails("Invalid query cursor", []string{fmt.Sprintf("cursor was created for since_version %d, got %d", parsed.sinceVersion, sinceVersion)})
		}
		if parsed.upperBound > snapshotVersion {
			return nil, NewValidationErrorWithDetails("Invalid query cursor", []string{"cursor snapshot is newer than the current change version"})
		}
		afterVersion = parsed.version
		snapshotUpperVersion = parsed.upperBound
	}

	records, hasMore, err := ReadChangeRecords(ctx, tx, afterVersion, snapshotUpperVersion, limit)
	if err != nil {
		return nil, err
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit transaction: %w", err)
	}

	events := make([]protocol.FeedEvent, len(records))
	for index := range records {
		events[index] = records[index].Event
	}
	result := &ChangedSinceResult{Events: events, Version: snapshotUpperVersion, HasMore: hasMore}
	if hasMore {
		lastVersion := events[len(events)-1].Version
		result.NextCursor, err = encodeVersionCursor(lastVersion, snapshotUpperVersion, sinceVersion)
		if err != nil {
			return nil, fmt.Errorf("encode change cursor: %w", err)
		}
	}
	return result, nil
}

func readSnapshotVersion(ctx context.Context, tx pgx.Tx) (int64, error) {
	var version int64
	err := tx.QueryRow(ctx, visibleChangeVersionSQL).Scan(&version)
	if err != nil {
		return 0, fmt.Errorf("read snapshot version: %w", err)
	}
	return version, nil
}

const visibleChangeVersionSQL = `SELECT version FROM atlas_change_clock WHERE singleton`
const currentChangeVersionSQL = visibleChangeVersionSQL

// CurrentChangeVersion reads the current global high-water mark.
func CurrentChangeVersion(ctx context.Context, pool *pgxpool.Pool) (int64, error) {
	var version int64
	err := pool.QueryRow(ctx, currentChangeVersionSQL).Scan(&version)
	if err != nil {
		return 0, fmt.Errorf("read current change version: %w", err)
	}
	return version, nil
}

func skipCursorStream[T any](continuation bool, cursor *T) bool {
	return continuation && cursor == nil
}
