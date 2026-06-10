package actions

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/models"
)

// QueryEntities returns one cursor page of entities ordered by (timeColumn DESC, entity_id DESC).
func QueryEntities(
	ctx context.Context,
	tx pgx.Tx,
	timeColumn string,
	since, snapshotUpper time.Time,
	continuation bool,
	cursor *ParsedQueryCursor,
	limit int,
) ([]*models.Entity, bool, error) {
	rows, err := openCursorPagedRows(ctx, tx, cursorPageOpts{
		selectFrom:         entitySelectSQL,
		idColumn:           "entity_id",
		timeColumn:         timeColumn,
		since:              since,
		snapshotUpperBound: snapshotUpper,
		continuation:       continuation,
		cursor:             cursor,
		fetchLimit:         limit + 1,
	})
	if err != nil {
		return nil, false, fmt.Errorf("failed to query entities: %w", err)
	}
	items, err := collectEntities(rows)
	if err != nil {
		return nil, false, err
	}
	out, more := TrimToLimitWithMore(items, limit)
	return out, more, nil
}

// QueryTasks returns one cursor page of tasks ordered by (timeColumn DESC, task_id DESC).
func QueryTasks(
	ctx context.Context,
	tx pgx.Tx,
	timeColumn string,
	since, snapshotUpper time.Time,
	continuation bool,
	cursor *ParsedQueryCursor,
	limit int,
) ([]*models.Task, bool, error) {
	rows, err := openCursorPagedRows(ctx, tx, cursorPageOpts{
		selectFrom:         taskSelectSQL,
		idColumn:           "task_id",
		timeColumn:         timeColumn,
		since:              since,
		snapshotUpperBound: snapshotUpper,
		continuation:       continuation,
		cursor:             cursor,
		fetchLimit:         limit + 1,
	})
	if err != nil {
		return nil, false, fmt.Errorf("failed to query tasks: %w", err)
	}
	items, err := collectTasks(rows)
	if err != nil {
		return nil, false, err
	}
	out, more := TrimToLimitWithMore(items, limit)
	return out, more, nil
}

// QueryTasksByEntity returns one cursor page of an entity's tasks.
func QueryTasksByEntity(
	ctx context.Context,
	tx pgx.Tx,
	entityID, timeColumn string,
	since, snapshotUpper time.Time,
	continuation bool,
	cursor *ParsedQueryCursor,
	limit int,
) ([]*models.Task, bool, error) {
	rows, err := openCursorPagedRows(ctx, tx, cursorPageOpts{
		selectFrom:         taskSelectSQL,
		idColumn:           "task_id",
		timeColumn:         timeColumn,
		since:              since,
		snapshotUpperBound: snapshotUpper,
		continuation:       continuation,
		cursor:             cursor,
		fetchLimit:         limit + 1,
		eqFilter:           &cursorPageEqFilter{column: "entity_id", value: entityID},
	})
	if err != nil {
		return nil, false, fmt.Errorf("failed to query tasks by entity: %w", err)
	}
	items, err := collectTasks(rows)
	if err != nil {
		return nil, false, err
	}
	out, more := TrimToLimitWithMore(items, limit)
	return out, more, nil
}

// QueryObjects returns one cursor page of objects ordered by (timeColumn DESC, object_id DESC).
func QueryObjects(
	ctx context.Context,
	tx pgx.Tx,
	timeColumn string,
	since, snapshotUpper time.Time,
	continuation bool,
	cursor *ParsedQueryCursor,
	limit int,
) ([]*models.MediaObject, bool, error) {
	rows, err := openCursorPagedRows(ctx, tx, cursorPageOpts{
		selectFrom:         objectSelectSQL,
		idColumn:           "object_id",
		timeColumn:         timeColumn,
		since:              since,
		snapshotUpperBound: snapshotUpper,
		continuation:       continuation,
		cursor:             cursor,
		fetchLimit:         limit + 1,
	})
	if err != nil {
		return nil, false, fmt.Errorf("failed to query objects: %w", err)
	}
	items, err := collectObjects(rows)
	if err != nil {
		return nil, false, err
	}
	out, more := TrimToLimitWithMore(items, limit)
	return out, more, nil
}
