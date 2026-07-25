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

// GetDataChangedSince retrieves resources modified after the given change version.
// Optional cursors continue pagination for each stream (same since_version, version DESC, id DESC).
func (a *QueryActions) GetDataChangedSince(ctx context.Context, sinceVersion int64, limitPerType int, cursors *ChangedSinceCursors) (*ChangedSinceResult, error) {
	limit := effectiveLimit(limitPerType, MaxChangedSinceLimit)

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

	parsedCursors, err := parseChangedSinceCursors(cursors)
	if err != nil {
		return nil, err
	}
	snapshotUpperVersion, continuation, err := parsedCursors.snapshot(sinceVersion, snapshotVersion)
	if err != nil {
		return nil, err
	}

	page, err := a.queryChangedSinceStreams(ctx, tx, sinceVersion, snapshotUpperVersion, limit, continuation, parsedCursors)
	if err != nil {
		return nil, err
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit transaction: %w", err)
	}

	return assembleChangedSinceResult(page, responseTimestamp, snapshotUpperVersion, sinceVersion)
}

type changedSinceCursors struct {
	entity        *parsedVersionCursor
	task          *parsedVersionCursor
	object        *parsedVersionCursor
	deletedEntity *parsedVersionCursor
	deletedTask   *parsedVersionCursor
	deletedObject *parsedVersionCursor
}

func parseChangedSinceCursors(cursors *ChangedSinceCursors) (*changedSinceCursors, error) {
	if cursors == nil {
		return &changedSinceCursors{}, nil
	}

	parsed := &changedSinceCursors{}
	var err error
	parsed.entity, err = parseChangedSinceCursor(cursors.EntityCursor, "entity_cursor")
	if err != nil {
		return nil, err
	}
	parsed.task, err = parseChangedSinceCursor(cursors.TaskCursor, "task_cursor")
	if err != nil {
		return nil, err
	}
	parsed.object, err = parseChangedSinceCursor(cursors.ObjectCursor, "object_cursor")
	if err != nil {
		return nil, err
	}
	parsed.deletedEntity, err = parseChangedSinceCursor(cursors.DeletedEntityCursor, "deleted_entity_cursor")
	if err != nil {
		return nil, err
	}
	parsed.deletedTask, err = parseChangedSinceCursor(cursors.DeletedTaskCursor, "deleted_task_cursor")
	if err != nil {
		return nil, err
	}
	parsed.deletedObject, err = parseChangedSinceCursor(cursors.DeletedObjectCursor, "deleted_object_cursor")
	if err != nil {
		return nil, err
	}
	return parsed, nil
}

func parseChangedSinceCursor(raw *string, label string) (*parsedVersionCursor, error) {
	if raw == nil {
		return nil, nil
	}
	return parseVersionQueryCursor(*raw, label)
}

func (c *changedSinceCursors) snapshot(sinceVersion, snapshotVersion int64) (int64, bool, error) {
	if err := validateVersionCursorsSinceVersion(sinceVersion, c.labeled()...); err != nil {
		return 0, false, err
	}
	return continuationVersionUpperBound(snapshotVersion, c.all()...)
}

func (c *changedSinceCursors) labeled() []labeledVersionCursor {
	return []labeledVersionCursor{
		{label: "entity_cursor", cursor: c.entity},
		{label: "task_cursor", cursor: c.task},
		{label: "object_cursor", cursor: c.object},
		{label: "deleted_entity_cursor", cursor: c.deletedEntity},
		{label: "deleted_task_cursor", cursor: c.deletedTask},
		{label: "deleted_object_cursor", cursor: c.deletedObject},
	}
}

func (c *changedSinceCursors) all() []*parsedVersionCursor {
	return []*parsedVersionCursor{c.entity, c.task, c.object, c.deletedEntity, c.deletedTask, c.deletedObject}
}

type changedSincePage struct {
	entities               []*models.Entity
	tasks                  []*models.Task
	objects                []*models.MediaObject
	deletedEntities        []DeletedResource
	deletedTasks           []DeletedResource
	deletedObjects         []DeletedResource
	hasMoreEntities        bool
	hasMoreTasks           bool
	hasMoreObjects         bool
	hasMoreDeletedEntities bool
	hasMoreDeletedTasks    bool
	hasMoreDeletedObjects  bool
}

func (a *QueryActions) queryChangedSinceStreams(ctx context.Context, tx pgx.Tx, sinceVersion, snapshotUpperVersion int64, limit int, continuation bool, cursors *changedSinceCursors) (*changedSincePage, error) {
	page := &changedSincePage{}
	var err error
	if !skipCursorStream(continuation, cursors.entity) {
		page.entities, page.hasMoreEntities, err = queryEntitiesByVersion(ctx, tx, sinceVersion, snapshotUpperVersion, cursors.entity != nil, cursors.entity, limit, maxQueryJSONBytesPerType)
		if err != nil {
			return nil, err
		}
	}
	if !skipCursorStream(continuation, cursors.task) {
		page.tasks, page.hasMoreTasks, err = queryTasksByVersion(ctx, tx, sinceVersion, snapshotUpperVersion, cursors.task != nil, cursors.task, limit, maxQueryJSONBytesPerType)
		if err != nil {
			return nil, err
		}
	}
	if !skipCursorStream(continuation, cursors.object) {
		page.objects, page.hasMoreObjects, err = queryObjectsByVersion(ctx, tx, sinceVersion, snapshotUpperVersion, cursors.object != nil, cursors.object, limit, maxQueryJSONBytesPerType)
		if err != nil {
			return nil, err
		}
	}

	page.deletedEntities, page.deletedTasks, page.deletedObjects, page.hasMoreDeletedEntities, page.hasMoreDeletedTasks, page.hasMoreDeletedObjects, err = a.getDeletionsSince(
		ctx, tx, sinceVersion, snapshotUpperVersion, limit, continuation, cursors.deletedEntity, cursors.deletedTask, cursors.deletedObject,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to query deletions: %w", err)
	}
	return page, nil
}

func assembleChangedSinceResult(page *changedSincePage, responseTimestamp time.Time, snapshotUpperVersion, sinceVersion int64) (*ChangedSinceResult, error) {
	resp := &ChangedSinceResult{
		Entities:               page.entities,
		Tasks:                  page.tasks,
		Objects:                page.objects,
		DeletedEntities:        page.deletedEntities,
		DeletedTasks:           page.deletedTasks,
		DeletedObjects:         page.deletedObjects,
		HasMoreEntities:        page.hasMoreEntities,
		HasMoreTasks:           page.hasMoreTasks,
		HasMoreObjects:         page.hasMoreObjects,
		HasMoreDeletedEntities: page.hasMoreDeletedEntities,
		HasMoreDeletedTasks:    page.hasMoreDeletedTasks,
		HasMoreDeletedObjects:  page.hasMoreDeletedObjects,
		Version:                snapshotUpperVersion,
		Timestamp:              responseTimestamp.UTC().Format(time.RFC3339Nano),
	}
	var err error
	resp.NextEntityCursor, err = encodeChangedSinceResourceCursor(page.entities, page.hasMoreEntities, snapshotUpperVersion, sinceVersion, "entity", func(entity *models.Entity) (int64, string) {
		return entity.Version, entity.EntityID
	})
	if err != nil {
		return nil, err
	}
	resp.NextTaskCursor, err = encodeChangedSinceResourceCursor(page.tasks, page.hasMoreTasks, snapshotUpperVersion, sinceVersion, "task", func(task *models.Task) (int64, string) {
		return task.Version, task.TaskID
	})
	if err != nil {
		return nil, err
	}
	resp.NextObjectCursor, err = encodeChangedSinceResourceCursor(page.objects, page.hasMoreObjects, snapshotUpperVersion, sinceVersion, "object", func(object *models.MediaObject) (int64, string) {
		return object.Version, object.ObjectID
	})
	if err != nil {
		return nil, err
	}
	resp.NextDeletedEntityCursor, err = encodeChangedSinceDeletedCursor(page.deletedEntities, page.hasMoreDeletedEntities, snapshotUpperVersion, sinceVersion, "next_deleted_entity_cursor")
	if err != nil {
		return nil, err
	}
	resp.NextDeletedTaskCursor, err = encodeChangedSinceDeletedCursor(page.deletedTasks, page.hasMoreDeletedTasks, snapshotUpperVersion, sinceVersion, "next_deleted_task_cursor")
	if err != nil {
		return nil, err
	}
	resp.NextDeletedObjectCursor, err = encodeChangedSinceDeletedCursor(page.deletedObjects, page.hasMoreDeletedObjects, snapshotUpperVersion, sinceVersion, "next_deleted_object_cursor")
	if err != nil {
		return nil, err
	}
	return resp, nil
}

func encodeChangedSinceResourceCursor[T any](items []T, hasMore bool, snapshotUpperVersion, sinceVersion int64, resource string, row func(T) (int64, string)) (string, error) {
	if !hasMore || len(items) == 0 {
		return "", nil
	}
	version, id := row(items[len(items)-1])
	cursor, err := encodeVersionCursor(version, id, snapshotUpperVersion, sinceVersion)
	if err != nil {
		return "", fmt.Errorf("encode %s cursor: %w", resource, err)
	}
	return cursor, nil
}

func encodeChangedSinceDeletedCursor(items []DeletedResource, hasMore bool, snapshotUpperVersion, sinceVersion int64, cursorField string) (string, error) {
	if !hasMore || len(items) == 0 {
		return "", nil
	}
	return encodeDeletedCursor(items[len(items)-1], snapshotUpperVersion, sinceVersion, cursorField)
}

func readSnapshotVersion(ctx context.Context, tx pgx.Tx) (int64, error) {
	var version int64
	err := tx.QueryRow(ctx, visibleChangeVersionSQL).Scan(&version)
	if err != nil {
		return 0, fmt.Errorf("read snapshot version: %w", err)
	}
	return version, nil
}

const visibleChangeVersionSQL = `
		SELECT GREATEST(
				COALESCE((SELECT MAX(version) FROM entities), 0),
				COALESCE((SELECT MAX(version) FROM tasks), 0),
				COALESCE((SELECT MAX(version) FROM objects), 0),
				COALESCE((SELECT MAX(version) FROM deletions), 0)
			)
		`

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
