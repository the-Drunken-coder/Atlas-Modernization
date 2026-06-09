// Package syncactions provides cross-resource query and sync streaming logic:
// full dataset dumps and changed-since incremental sync.
package syncactions

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/actions"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/models"
)

// Actions handles query operations across multiple resource types.
type Actions struct {
	pool *pgxpool.Pool
}

// New creates a new sync/query Actions instance.
func New(pool *pgxpool.Pool) *Actions {
	return &Actions{pool: pool}
}

// GetFullDataset retrieves all entities, tasks, and objects (up to limit each).
func (a *Actions) GetFullDataset(ctx context.Context, limits *FullDatasetLimits) (*FullDatasetResult, error) {
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

	entCur, err := actions.ParseQueryCursor(entCurRaw, "entity_cursor")
	if err != nil {
		return nil, err
	}
	taskCur, err := actions.ParseQueryCursor(taskCurRaw, "task_cursor")
	if err != nil {
		return nil, err
	}
	objCur, err := actions.ParseQueryCursor(objCurRaw, "object_cursor")
	if err != nil {
		return nil, err
	}
	snapshotUpperBound, continuation, err := actions.ContinuationUpperBound(txUpperBound, entCur, taskCur, objCur)
	if err != nil {
		return nil, err
	}

	var entities []*models.Entity
	var hasMoreEnt bool
	if !skipCursorStream(continuation, entCur) {
		entities, hasMoreEnt, err = actions.QueryEntities(ctx, tx, "created_at", time.Time{}, snapshotUpperBound, entCur != nil, entCur, entityLimit)
		if err != nil {
			return nil, err
		}
	}

	var tasks []*models.Task
	var hasMoreTasks bool
	if !skipCursorStream(continuation, taskCur) {
		tasks, hasMoreTasks, err = actions.QueryTasks(ctx, tx, "created_at", time.Time{}, snapshotUpperBound, taskCur != nil, taskCur, taskLimit)
		if err != nil {
			return nil, err
		}
	}

	var objects []*models.MediaObject
	var hasMoreObj bool
	if !skipCursorStream(continuation, objCur) {
		objects, hasMoreObj, err = actions.QueryObjects(ctx, tx, "created_at", time.Time{}, snapshotUpperBound, objCur != nil, objCur, objectLimit)
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
		cur, err := actions.EncodeRowCursor(last.CreatedAt, last.EntityID, snapshotUpperBound)
		if err != nil {
			return nil, fmt.Errorf("encode entity cursor: %w", err)
		}
		resp.NextEntityCursor = cur
	}
	if hasMoreTasks && len(tasks) > 0 {
		last := tasks[len(tasks)-1]
		cur, err := actions.EncodeRowCursor(last.CreatedAt, last.TaskID, snapshotUpperBound)
		if err != nil {
			return nil, fmt.Errorf("encode task cursor: %w", err)
		}
		resp.NextTaskCursor = cur
	}
	if hasMoreObj && len(objects) > 0 {
		last := objects[len(objects)-1]
		cur, err := actions.EncodeRowCursor(last.CreatedAt, last.ObjectID, snapshotUpperBound)
		if err != nil {
			return nil, fmt.Errorf("encode object cursor: %w", err)
		}
		resp.NextObjectCursor = cur
	}
	return resp, nil
}
