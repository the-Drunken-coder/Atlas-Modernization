package actions

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/models"
)

// QueryActions handles query operations across multiple resource types.
type QueryActions struct {
	pool *pgxpool.Pool
	// changedSinceSafetyLag holds the returned changed-since watermark behind the
	// read snapshot so a row whose write commits just after a poller's snapshot is
	// re-offered on a later poll instead of being skipped forever.
	changedSinceSafetyLag time.Duration
}

// NewQueryActions creates a new QueryActions instance.
// safetyLag lags the changed-since watermark behind the read snapshot; pass 0 to disable.
func NewQueryActions(pool *pgxpool.Pool, safetyLag time.Duration) *QueryActions {
	if safetyLag < 0 {
		safetyLag = 0
	}
	return &QueryActions{pool: pool, changedSinceSafetyLag: safetyLag}
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

	entCur, err := parseQueryCursor(entCurRaw, "entity_cursor")
	if err != nil {
		return nil, err
	}
	taskCur, err := parseQueryCursor(taskCurRaw, "task_cursor")
	if err != nil {
		return nil, err
	}
	objCur, err := parseQueryCursor(objCurRaw, "object_cursor")
	if err != nil {
		return nil, err
	}
	snapshotUpperBound, continuation, err := continuationUpperBound(txUpperBound, entCur, taskCur, objCur)
	if err != nil {
		return nil, err
	}

	var entities []*models.Entity
	var hasMoreEnt bool
	if !skipCursorStream(continuation, entCur) {
		entities, hasMoreEnt, err = queryEntities(ctx, tx, "created_at", time.Time{}, snapshotUpperBound, entCur != nil, entCur, entityLimit)
		if err != nil {
			return nil, err
		}
	}

	var tasks []*models.Task
	var hasMoreTasks bool
	if !skipCursorStream(continuation, taskCur) {
		tasks, hasMoreTasks, err = queryTasks(ctx, tx, "created_at", time.Time{}, snapshotUpperBound, taskCur != nil, taskCur, taskLimit)
		if err != nil {
			return nil, err
		}
	}

	var objects []*models.MediaObject
	var hasMoreObj bool
	if !skipCursorStream(continuation, objCur) {
		objects, hasMoreObj, err = queryObjects(ctx, tx, "created_at", time.Time{}, snapshotUpperBound, objCur != nil, objCur, objectLimit)
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
		HasMoreEntities: hasMoreEnt,
		HasMoreTasks:    hasMoreTasks,
		HasMoreObjects:  hasMoreObj,
	}
	if hasMoreEnt && len(entities) > 0 {
		last := entities[len(entities)-1]
		cur, err := encodeRowCursor(last.CreatedAt, last.EntityID, snapshotUpperBound)
		if err != nil {
			return nil, fmt.Errorf("encode entity cursor: %w", err)
		}
		resp.NextEntityCursor = cur
	}
	if hasMoreTasks && len(tasks) > 0 {
		last := tasks[len(tasks)-1]
		cur, err := encodeRowCursor(last.CreatedAt, last.TaskID, snapshotUpperBound)
		if err != nil {
			return nil, fmt.Errorf("encode task cursor: %w", err)
		}
		resp.NextTaskCursor = cur
	}
	if hasMoreObj && len(objects) > 0 {
		last := objects[len(objects)-1]
		cur, err := encodeRowCursor(last.CreatedAt, last.ObjectID, snapshotUpperBound)
		if err != nil {
			return nil, fmt.Errorf("encode object cursor: %w", err)
		}
		resp.NextObjectCursor = cur
	}
	return resp, nil
}

// GetDataChangedSince retrieves resources modified since the given timestamp.
// Optional cursors continue pagination for each stream (same since, updated_at DESC, id DESC).
func (a *QueryActions) GetDataChangedSince(ctx context.Context, since time.Time, limitPerType int, cursors *ChangedSinceCursors) (*ChangedSinceResult, error) {
	limit := effectiveLimit(limitPerType, MaxChangedSinceLimit)

	var entCurRaw, taskCurRaw, objCurRaw, delEntCurRaw, delTaskCurRaw, delObjCurRaw string
	if cursors != nil {
		if cursors.EntityCursor != nil {
			entCurRaw = *cursors.EntityCursor
		}
		if cursors.TaskCursor != nil {
			taskCurRaw = *cursors.TaskCursor
		}
		if cursors.ObjectCursor != nil {
			objCurRaw = *cursors.ObjectCursor
		}
		if cursors.DeletedEntityCursor != nil {
			delEntCurRaw = *cursors.DeletedEntityCursor
		}
		if cursors.DeletedTaskCursor != nil {
			delTaskCurRaw = *cursors.DeletedTaskCursor
		}
		if cursors.DeletedObjectCursor != nil {
			delObjCurRaw = *cursors.DeletedObjectCursor
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
	entCur, err := parseQueryCursor(entCurRaw, "entity_cursor")
	if err != nil {
		return nil, err
	}
	taskCur, err := parseQueryCursor(taskCurRaw, "task_cursor")
	if err != nil {
		return nil, err
	}
	objCur, err := parseQueryCursor(objCurRaw, "object_cursor")
	if err != nil {
		return nil, err
	}
	delEntCur, err := parseQueryCursor(delEntCurRaw, "deleted_entity_cursor")
	if err != nil {
		return nil, err
	}
	delTaskCur, err := parseQueryCursor(delTaskCurRaw, "deleted_task_cursor")
	if err != nil {
		return nil, err
	}
	delObjCur, err := parseQueryCursor(delObjCurRaw, "deleted_object_cursor")
	if err != nil {
		return nil, err
	}
	snapshotUpperBound, continuation, err := continuationUpperBound(txUpperBound, entCur, taskCur, objCur, delEntCur, delTaskCur, delObjCur)
	if err != nil {
		return nil, err
	}
	// Rows and cursors keep filtering against the true snapshot ceiling so freshly
	// committed rows are still returned immediately. Only the watermark handed back
	// to the client is lagged: a row stamped before the snapshot but committed just
	// after it gets re-offered on a later poll (bounded duplicate) rather than being
	// permanently skipped once `since` advances past it.
	watermark := snapshotUpperBound.Add(-a.changedSinceSafetyLag)
	responseTimestamp := watermark.UTC().Format(time.RFC3339Nano)

	var entities []*models.Entity
	var hasMoreEnt bool
	if !skipCursorStream(continuation, entCur) {
		entities, hasMoreEnt, err = queryEntities(ctx, tx, "updated_at", since, snapshotUpperBound, entCur != nil, entCur, limit)
		if err != nil {
			return nil, err
		}
	}

	var tasks []*models.Task
	var hasMoreTasks bool
	if !skipCursorStream(continuation, taskCur) {
		tasks, hasMoreTasks, err = queryTasks(ctx, tx, "updated_at", since, snapshotUpperBound, taskCur != nil, taskCur, limit)
		if err != nil {
			return nil, err
		}
	}

	var objects []*models.MediaObject
	var hasMoreObj bool
	if !skipCursorStream(continuation, objCur) {
		objects, hasMoreObj, err = queryObjects(ctx, tx, "updated_at", since, snapshotUpperBound, objCur != nil, objCur, limit)
		if err != nil {
			return nil, err
		}
	}

	deletedEntities, deletedTasks, deletedObjects, moreDE, moreDT, moreDO, err := a.getDeletionsSince(
		ctx, tx, since, snapshotUpperBound, limit, continuation, delEntCur, delTaskCur, delObjCur,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to query deletions: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit transaction: %w", err)
	}

	resp := &ChangedSinceResult{
		Entities:               entities,
		Tasks:                  tasks,
		Objects:                objects,
		DeletedEntities:        deletedEntities,
		DeletedTasks:           deletedTasks,
		DeletedObjects:         deletedObjects,
		HasMoreEntities:        hasMoreEnt,
		HasMoreTasks:           hasMoreTasks,
		HasMoreObjects:         hasMoreObj,
		HasMoreDeletedEntities: moreDE,
		HasMoreDeletedTasks:    moreDT,
		HasMoreDeletedObjects:  moreDO,
		Timestamp:              responseTimestamp,
	}
	if hasMoreEnt && len(entities) > 0 {
		last := entities[len(entities)-1]
		cur, err := encodeRowCursor(last.UpdatedAt, last.EntityID, snapshotUpperBound)
		if err != nil {
			return nil, fmt.Errorf("encode entity cursor: %w", err)
		}
		resp.NextEntityCursor = cur
	}
	if hasMoreTasks && len(tasks) > 0 {
		last := tasks[len(tasks)-1]
		cur, err := encodeRowCursor(last.UpdatedAt, last.TaskID, snapshotUpperBound)
		if err != nil {
			return nil, fmt.Errorf("encode task cursor: %w", err)
		}
		resp.NextTaskCursor = cur
	}
	if hasMoreObj && len(objects) > 0 {
		last := objects[len(objects)-1]
		cur, err := encodeRowCursor(last.UpdatedAt, last.ObjectID, snapshotUpperBound)
		if err != nil {
			return nil, fmt.Errorf("encode object cursor: %w", err)
		}
		resp.NextObjectCursor = cur
	}
	if moreDE && len(deletedEntities) > 0 {
		last := deletedEntities[len(deletedEntities)-1]
		cur, err := encodeDeletedCursor(last, snapshotUpperBound, "next_deleted_entity_cursor")
		if err != nil {
			return nil, err
		}
		resp.NextDeletedEntityCursor = cur
	}
	if moreDT && len(deletedTasks) > 0 {
		last := deletedTasks[len(deletedTasks)-1]
		cur, err := encodeDeletedCursor(last, snapshotUpperBound, "next_deleted_task_cursor")
		if err != nil {
			return nil, err
		}
		resp.NextDeletedTaskCursor = cur
	}
	if moreDO && len(deletedObjects) > 0 {
		last := deletedObjects[len(deletedObjects)-1]
		cur, err := encodeDeletedCursor(last, snapshotUpperBound, "next_deleted_object_cursor")
		if err != nil {
			return nil, err
		}
		resp.NextDeletedObjectCursor = cur
	}
	return resp, nil
}

func encodeDeletedCursor(resource DeletedResource, snapshotUpperBound time.Time, cursorField string) (string, error) {
	deletedAt, err := parseDeletedAtCursor(resource.DeletedAt)
	if err != nil {
		return "", fmt.Errorf("build %s: %w", cursorField, err)
	}
	cursor, err := encodeRowCursor(deletedAt, resource.ID, snapshotUpperBound)
	if err != nil {
		return "", fmt.Errorf("build %s: %w", cursorField, err)
	}
	return cursor, nil
}

func skipCursorStream(continuation bool, cursor *parsedQueryCursor) bool {
	return continuation && cursor == nil
}

// getDeletionsSince queries the deletions table for tombstones after the given timestamp.
func (a *QueryActions) getDeletionsSince(ctx context.Context, tx pgx.Tx, since, snapshotUpper time.Time, limitPerType int, continuation bool, cursorEntity, cursorTask, cursorObject *parsedQueryCursor) ([]DeletedResource, []DeletedResource, []DeletedResource, bool, bool, bool, error) {
	var deletedEntities []DeletedResource
	var moreE bool
	var err error
	if !skipCursorStream(continuation, cursorEntity) {
		deletedEntities, moreE, err = queryDeletionsByType(ctx, tx, "entity", since, snapshotUpper, cursorEntity != nil, cursorEntity, limitPerType)
		if err != nil {
			return nil, nil, nil, false, false, false, err
		}
	}

	var deletedTasks []DeletedResource
	var moreT bool
	if !skipCursorStream(continuation, cursorTask) {
		deletedTasks, moreT, err = queryDeletionsByType(ctx, tx, "task", since, snapshotUpper, cursorTask != nil, cursorTask, limitPerType)
		if err != nil {
			return nil, nil, nil, false, false, false, err
		}
	}

	var deletedObjects []DeletedResource
	var moreO bool
	if !skipCursorStream(continuation, cursorObject) {
		deletedObjects, moreO, err = queryDeletionsByType(ctx, tx, "object", since, snapshotUpper, cursorObject != nil, cursorObject, limitPerType)
		if err != nil {
			return nil, nil, nil, false, false, false, err
		}
	}

	return deletedEntities, deletedTasks, deletedObjects, moreE, moreT, moreO, nil
}
