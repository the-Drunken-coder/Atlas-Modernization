package actions

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/serializers"
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
func (a *QueryActions) GetFullDataset(ctx context.Context, limits *FullDatasetLimits) (*FullDatasetResponse, error) {
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

	entities, hasMoreEnt, err := queryEntities(ctx, tx, "created_at", time.Time{}, snapshotUpperBound, continuation, entCur, entityLimit)
	if err != nil {
		return nil, err
	}
	tasks, hasMoreTasks, err := queryTasks(ctx, tx, "created_at", time.Time{}, snapshotUpperBound, continuation, taskCur, taskLimit)
	if err != nil {
		return nil, err
	}
	objects, hasMoreObj, err := queryObjects(ctx, tx, "created_at", time.Time{}, snapshotUpperBound, continuation, objCur, objectLimit)
	if err != nil {
		return nil, err
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit transaction: %w", err)
	}

	resp := &FullDatasetResponse{
		Entities:        serializers.SerializeEntities(entities),
		Tasks:           serializers.SerializeTasks(tasks),
		Objects:         serializers.SerializeObjects(objects),
		HasMoreEntities: hasMoreEnt,
		HasMoreTasks:    hasMoreTasks,
		HasMoreObjects:  hasMoreObj,
	}
	if hasMoreEnt && len(entities) > 0 {
		last := entities[len(entities)-1]
		resp.NextEntityCursor = encodeRowCursor(last.CreatedAt, last.EntityID, snapshotUpperBound)
	}
	if hasMoreTasks && len(tasks) > 0 {
		last := tasks[len(tasks)-1]
		resp.NextTaskCursor = encodeRowCursor(last.CreatedAt, last.TaskID, snapshotUpperBound)
	}
	if hasMoreObj && len(objects) > 0 {
		last := objects[len(objects)-1]
		resp.NextObjectCursor = encodeRowCursor(last.CreatedAt, last.ObjectID, snapshotUpperBound)
	}
	return resp, nil
}

// GetDataChangedSince retrieves resources modified since the given timestamp.
// Optional cursors continue pagination for each stream (same since, updated_at DESC, id DESC).
func (a *QueryActions) GetDataChangedSince(ctx context.Context, since time.Time, limitPerType int, cursors *ChangedSinceCursors) (*ChangedSinceResponse, error) {
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
	responseTimestamp := watermark.UTC().Format(time.RFC3339)

	entities, hasMoreEnt, err := queryEntities(ctx, tx, "updated_at", since, snapshotUpperBound, continuation, entCur, limit)
	if err != nil {
		return nil, err
	}
	tasks, hasMoreTasks, err := queryTasks(ctx, tx, "updated_at", since, snapshotUpperBound, continuation, taskCur, limit)
	if err != nil {
		return nil, err
	}
	objects, hasMoreObj, err := queryObjects(ctx, tx, "updated_at", since, snapshotUpperBound, continuation, objCur, limit)
	if err != nil {
		return nil, err
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

	resp := &ChangedSinceResponse{
		Entities:               serializers.SerializeEntities(entities),
		Tasks:                  serializers.SerializeTasks(tasks),
		Objects:                serializers.SerializeObjects(objects),
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
		resp.NextEntityCursor = encodeRowCursor(last.UpdatedAt, last.EntityID, snapshotUpperBound)
	}
	if hasMoreTasks && len(tasks) > 0 {
		last := tasks[len(tasks)-1]
		resp.NextTaskCursor = encodeRowCursor(last.UpdatedAt, last.TaskID, snapshotUpperBound)
	}
	if hasMoreObj && len(objects) > 0 {
		last := objects[len(objects)-1]
		resp.NextObjectCursor = encodeRowCursor(last.UpdatedAt, last.ObjectID, snapshotUpperBound)
	}
	if moreDE && len(deletedEntities) > 0 {
		last := deletedEntities[len(deletedEntities)-1]
		dt, err := parseDeletedAtCursor(last.DeletedAt)
		if err == nil {
			resp.NextDeletedEntityCursor = encodeRowCursor(dt, last.ID, snapshotUpperBound)
		} else {
			log.Warn().
				Err(err).
				Str("cursor_field", "next_deleted_entity_cursor").
				Str("resource_id", last.ID).
				Str("deleted_at", last.DeletedAt).
				Msg("failed to parse deleted entity cursor timestamp")
		}
	}
	if moreDT && len(deletedTasks) > 0 {
		last := deletedTasks[len(deletedTasks)-1]
		dt, err := parseDeletedAtCursor(last.DeletedAt)
		if err == nil {
			resp.NextDeletedTaskCursor = encodeRowCursor(dt, last.ID, snapshotUpperBound)
		} else {
			log.Warn().
				Err(err).
				Str("cursor_field", "next_deleted_task_cursor").
				Str("resource_id", last.ID).
				Str("deleted_at", last.DeletedAt).
				Msg("failed to parse deleted task cursor timestamp")
		}
	}
	if moreDO && len(deletedObjects) > 0 {
		last := deletedObjects[len(deletedObjects)-1]
		dt, err := parseDeletedAtCursor(last.DeletedAt)
		if err == nil {
			resp.NextDeletedObjectCursor = encodeRowCursor(dt, last.ID, snapshotUpperBound)
		} else {
			log.Warn().
				Err(err).
				Str("cursor_field", "next_deleted_object_cursor").
				Str("resource_id", last.ID).
				Str("deleted_at", last.DeletedAt).
				Msg("failed to parse deleted object cursor timestamp")
		}
	}
	return resp, nil
}

// getDeletionsSince queries the deletions table for tombstones after the given timestamp.
func (a *QueryActions) getDeletionsSince(ctx context.Context, tx pgx.Tx, since, snapshotUpper time.Time, limitPerType int, continuation bool, cursorEntity, cursorTask, cursorObject *parsedQueryCursor) ([]DeletedResource, []DeletedResource, []DeletedResource, bool, bool, bool, error) {
	deletedEntities, moreE, err := queryDeletionsByType(ctx, tx, "entity", since, snapshotUpper, continuation, cursorEntity, limitPerType)
	if err != nil {
		return nil, nil, nil, false, false, false, err
	}

	deletedTasks, moreT, err := queryDeletionsByType(ctx, tx, "task", since, snapshotUpper, continuation, cursorTask, limitPerType)
	if err != nil {
		return nil, nil, nil, false, false, false, err
	}

	deletedObjects, moreO, err := queryDeletionsByType(ctx, tx, "object", since, snapshotUpper, continuation, cursorObject, limitPerType)
	if err != nil {
		return nil, nil, nil, false, false, false, err
	}

	return deletedEntities, deletedTasks, deletedObjects, moreE, moreT, moreO, nil
}
