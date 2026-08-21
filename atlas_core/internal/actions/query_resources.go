package actions

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/models"
)

func queryEntities(
	ctx context.Context,
	tx pgx.Tx,
	timeColumn string,
	since, snapshotUpper time.Time,
	continuation bool,
	cursor *parsedQueryCursor,
	limit, maxJSONBytes int,
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
	if maxJSONBytes > 0 {
		return collectByteBoundedEntities(rows, limit, maxJSONBytes)
	}
	items, err := collectEntities(rows)
	if err != nil {
		return nil, false, err
	}
	out, more := trimToLimitWithMore(items, limit)
	return out, more, nil
}

func queryTasks(
	ctx context.Context,
	tx pgx.Tx,
	timeColumn string,
	since, snapshotUpper time.Time,
	continuation bool,
	cursor *parsedQueryCursor,
	limit, maxJSONBytes int,
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
	if maxJSONBytes > 0 {
		return collectByteBoundedTasks(rows, limit, maxJSONBytes)
	}
	items, err := collectTasks(rows)
	if err != nil {
		return nil, false, err
	}
	out, more := trimToLimitWithMore(items, limit)
	return out, more, nil
}

func queryTasksByEntity(
	ctx context.Context,
	tx pgx.Tx,
	entityID, timeColumn string,
	since, snapshotUpper time.Time,
	continuation bool,
	cursor *parsedQueryCursor,
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
		eqFilter:           &cursorPageEqFilter{column: "asset_id", value: entityID},
	})
	if err != nil {
		return nil, false, fmt.Errorf("failed to query tasks by entity: %w", err)
	}
	items, err := collectTasks(rows)
	if err != nil {
		return nil, false, err
	}
	out, more := trimToLimitWithMore(items, limit)
	return out, more, nil
}

func queryObjects(
	ctx context.Context,
	tx pgx.Tx,
	timeColumn string,
	since, snapshotUpper time.Time,
	continuation bool,
	cursor *parsedQueryCursor,
	limit, maxJSONBytes int,
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
	if maxJSONBytes > 0 {
		return collectByteBoundedObjects(rows, limit, maxJSONBytes)
	}
	items, err := collectObjects(rows)
	if err != nil {
		return nil, false, err
	}
	out, more := trimToLimitWithMore(items, limit)
	return out, more, nil
}
