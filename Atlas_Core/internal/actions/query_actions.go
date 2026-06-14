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

// GetDataChangedSince retrieves resources modified after the given change version.
// Optional cursors continue pagination for each stream (same since_version, version DESC, id DESC).
func (a *QueryActions) GetDataChangedSince(ctx context.Context, sinceVersion int64, limitPerType int, cursors *ChangedSinceCursors) (*ChangedSinceResult, error) {
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

	var responseTimestamp time.Time
	if err := tx.QueryRow(ctx, `SELECT statement_timestamp()`).Scan(&responseTimestamp); err != nil {
		return nil, fmt.Errorf("read snapshot timestamp: %w", err)
	}
	snapshotVersion, err := readSnapshotVersion(ctx, tx)
	if err != nil {
		return nil, err
	}

	entCur, err := parseVersionQueryCursor(entCurRaw, "entity_cursor")
	if err != nil {
		return nil, err
	}
	taskCur, err := parseVersionQueryCursor(taskCurRaw, "task_cursor")
	if err != nil {
		return nil, err
	}
	objCur, err := parseVersionQueryCursor(objCurRaw, "object_cursor")
	if err != nil {
		return nil, err
	}
	delEntCur, err := parseVersionQueryCursor(delEntCurRaw, "deleted_entity_cursor")
	if err != nil {
		return nil, err
	}
	delTaskCur, err := parseVersionQueryCursor(delTaskCurRaw, "deleted_task_cursor")
	if err != nil {
		return nil, err
	}
	delObjCur, err := parseVersionQueryCursor(delObjCurRaw, "deleted_object_cursor")
	if err != nil {
		return nil, err
	}
	if err := validateVersionCursorsSinceVersion(
		sinceVersion,
		labeledVersionCursor{label: "entity_cursor", cursor: entCur},
		labeledVersionCursor{label: "task_cursor", cursor: taskCur},
		labeledVersionCursor{label: "object_cursor", cursor: objCur},
		labeledVersionCursor{label: "deleted_entity_cursor", cursor: delEntCur},
		labeledVersionCursor{label: "deleted_task_cursor", cursor: delTaskCur},
		labeledVersionCursor{label: "deleted_object_cursor", cursor: delObjCur},
	); err != nil {
		return nil, err
	}
	snapshotUpperVersion, continuation, err := continuationVersionUpperBound(snapshotVersion, entCur, taskCur, objCur, delEntCur, delTaskCur, delObjCur)
	if err != nil {
		return nil, err
	}

	var entities []*models.Entity
	var hasMoreEnt bool
	if !skipCursorStream(continuation, entCur) {
		entities, hasMoreEnt, err = queryEntitiesByVersion(ctx, tx, sinceVersion, snapshotUpperVersion, entCur != nil, entCur, limit)
		if err != nil {
			return nil, err
		}
	}

	var tasks []*models.Task
	var hasMoreTasks bool
	if !skipCursorStream(continuation, taskCur) {
		tasks, hasMoreTasks, err = queryTasksByVersion(ctx, tx, sinceVersion, snapshotUpperVersion, taskCur != nil, taskCur, limit)
		if err != nil {
			return nil, err
		}
	}

	var objects []*models.MediaObject
	var hasMoreObj bool
	if !skipCursorStream(continuation, objCur) {
		objects, hasMoreObj, err = queryObjectsByVersion(ctx, tx, sinceVersion, snapshotUpperVersion, objCur != nil, objCur, limit)
		if err != nil {
			return nil, err
		}
	}

	deletedEntities, deletedTasks, deletedObjects, moreDE, moreDT, moreDO, err := a.getDeletionsSince(
		ctx, tx, sinceVersion, snapshotUpperVersion, limit, continuation, delEntCur, delTaskCur, delObjCur,
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
		Version:                snapshotUpperVersion,
		Timestamp:              responseTimestamp.UTC().Format(time.RFC3339Nano),
	}
	if hasMoreEnt && len(entities) > 0 {
		last := entities[len(entities)-1]
		cur, err := encodeVersionCursor(last.Version, last.EntityID, snapshotUpperVersion, sinceVersion)
		if err != nil {
			return nil, fmt.Errorf("encode entity cursor: %w", err)
		}
		resp.NextEntityCursor = cur
	}
	if hasMoreTasks && len(tasks) > 0 {
		last := tasks[len(tasks)-1]
		cur, err := encodeVersionCursor(last.Version, last.TaskID, snapshotUpperVersion, sinceVersion)
		if err != nil {
			return nil, fmt.Errorf("encode task cursor: %w", err)
		}
		resp.NextTaskCursor = cur
	}
	if hasMoreObj && len(objects) > 0 {
		last := objects[len(objects)-1]
		cur, err := encodeVersionCursor(last.Version, last.ObjectID, snapshotUpperVersion, sinceVersion)
		if err != nil {
			return nil, fmt.Errorf("encode object cursor: %w", err)
		}
		resp.NextObjectCursor = cur
	}
	if moreDE && len(deletedEntities) > 0 {
		last := deletedEntities[len(deletedEntities)-1]
		cur, err := encodeDeletedCursor(last, snapshotUpperVersion, sinceVersion, "next_deleted_entity_cursor")
		if err != nil {
			return nil, err
		}
		resp.NextDeletedEntityCursor = cur
	}
	if moreDT && len(deletedTasks) > 0 {
		last := deletedTasks[len(deletedTasks)-1]
		cur, err := encodeDeletedCursor(last, snapshotUpperVersion, sinceVersion, "next_deleted_task_cursor")
		if err != nil {
			return nil, err
		}
		resp.NextDeletedTaskCursor = cur
	}
	if moreDO && len(deletedObjects) > 0 {
		last := deletedObjects[len(deletedObjects)-1]
		cur, err := encodeDeletedCursor(last, snapshotUpperVersion, sinceVersion, "next_deleted_object_cursor")
		if err != nil {
			return nil, err
		}
		resp.NextDeletedObjectCursor = cur
	}
	return resp, nil
}

func readSnapshotVersion(ctx context.Context, tx pgx.Tx) (int64, error) {
	var version int64
	err := tx.QueryRow(ctx, currentChangeVersionSQL).Scan(&version)
	if err != nil {
		return 0, fmt.Errorf("read snapshot version: %w", err)
	}
	return version, nil
}

const currentChangeVersionSQL = `
		SELECT GREATEST(
				COALESCE((SELECT MAX(version) FROM entities), 0),
				COALESCE((SELECT MAX(version) FROM tasks), 0),
				COALESCE((SELECT MAX(version) FROM objects), 0),
				COALESCE((SELECT MAX(version) FROM deletions), 0),
				COALESCE((SELECT CASE WHEN is_called THEN last_value ELSE 0 END FROM atlas_change_version_seq), 0)
			)
		`

// CurrentChangeVersion reads the current global high-water mark.
func CurrentChangeVersion(ctx context.Context, pool *pgxpool.Pool) (int64, error) {
	var version int64
	err := pool.QueryRow(ctx, currentChangeVersionSQL).Scan(&version)
	if err != nil {
		return 0, fmt.Errorf("read current change version: %w", err)
	}
	return version, nil
}

func encodeDeletedCursor(resource DeletedResource, snapshotUpperVersion, sinceVersion int64, cursorField string) (string, error) {
	cursor, err := encodeVersionCursor(resource.Version, resource.ID, snapshotUpperVersion, sinceVersion)
	if err != nil {
		return "", fmt.Errorf("build %s: %w", cursorField, err)
	}
	return cursor, nil
}

func skipCursorStream[T any](continuation bool, cursor *T) bool {
	return continuation && cursor == nil
}

// getDeletionsSince queries the deletions table for tombstones after the given version.
func (a *QueryActions) getDeletionsSince(ctx context.Context, tx pgx.Tx, sinceVersion, snapshotUpperVersion int64, limitPerType int, continuation bool, cursorEntity, cursorTask, cursorObject *parsedVersionCursor) ([]DeletedResource, []DeletedResource, []DeletedResource, bool, bool, bool, error) {
	var deletedEntities []DeletedResource
	var moreE bool
	var err error
	if !skipCursorStream(continuation, cursorEntity) {
		deletedEntities, moreE, err = queryDeletionsByTypeAndVersion(ctx, tx, "entity", sinceVersion, snapshotUpperVersion, cursorEntity != nil, cursorEntity, limitPerType)
		if err != nil {
			return nil, nil, nil, false, false, false, err
		}
	}

	var deletedTasks []DeletedResource
	var moreT bool
	if !skipCursorStream(continuation, cursorTask) {
		deletedTasks, moreT, err = queryDeletionsByTypeAndVersion(ctx, tx, "task", sinceVersion, snapshotUpperVersion, cursorTask != nil, cursorTask, limitPerType)
		if err != nil {
			return nil, nil, nil, false, false, false, err
		}
	}

	var deletedObjects []DeletedResource
	var moreO bool
	if !skipCursorStream(continuation, cursorObject) {
		deletedObjects, moreO, err = queryDeletionsByTypeAndVersion(ctx, tx, "object", sinceVersion, snapshotUpperVersion, cursorObject != nil, cursorObject, limitPerType)
		if err != nil {
			return nil, nil, nil, false, false, false, err
		}
	}

	return deletedEntities, deletedTasks, deletedObjects, moreE, moreT, moreO, nil
}
