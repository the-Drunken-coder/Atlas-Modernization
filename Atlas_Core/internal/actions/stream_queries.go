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

// QueryEntitiesByVersion returns one version-ordered page of changed entities.
func QueryEntitiesByVersion(
	ctx context.Context,
	tx pgx.Tx,
	sinceVersion, snapshotUpperVersion int64,
	continuation bool,
	cursor *ParsedVersionCursor,
	limit int,
) ([]*models.Entity, bool, error) {
	rows, err := openVersionCursorPagedRows(ctx, tx, versionCursorPageOpts{
		selectFrom:           entitySelectSQL,
		idColumn:             "entity_id",
		sinceVersion:         sinceVersion,
		snapshotUpperVersion: snapshotUpperVersion,
		continuation:         continuation,
		cursor:               cursor,
		fetchLimit:           limit + 1,
	})
	if err != nil {
		return nil, false, fmt.Errorf("failed to query versioned entities: %w", err)
	}
	items, err := collectEntities(rows)
	if err != nil {
		return nil, false, err
	}
	out, more := TrimToLimitWithMore(items, limit)
	return out, more, nil
}

// QueryTasksByVersion returns one version-ordered page of changed tasks.
func QueryTasksByVersion(
	ctx context.Context,
	tx pgx.Tx,
	sinceVersion, snapshotUpperVersion int64,
	continuation bool,
	cursor *ParsedVersionCursor,
	limit int,
) ([]*models.Task, bool, error) {
	rows, err := openVersionCursorPagedRows(ctx, tx, versionCursorPageOpts{
		selectFrom:           taskSelectSQL,
		idColumn:             "task_id",
		sinceVersion:         sinceVersion,
		snapshotUpperVersion: snapshotUpperVersion,
		continuation:         continuation,
		cursor:               cursor,
		fetchLimit:           limit + 1,
	})
	if err != nil {
		return nil, false, fmt.Errorf("failed to query versioned tasks: %w", err)
	}
	items, err := collectTasks(rows)
	if err != nil {
		return nil, false, err
	}
	out, more := TrimToLimitWithMore(items, limit)
	return out, more, nil
}

// QueryObjectsByVersion returns one version-ordered page of changed objects.
func QueryObjectsByVersion(
	ctx context.Context,
	tx pgx.Tx,
	sinceVersion, snapshotUpperVersion int64,
	continuation bool,
	cursor *ParsedVersionCursor,
	limit int,
) ([]*models.MediaObject, bool, error) {
	rows, err := openVersionCursorPagedRows(ctx, tx, versionCursorPageOpts{
		selectFrom:           objectSelectSQL,
		idColumn:             "object_id",
		sinceVersion:         sinceVersion,
		snapshotUpperVersion: snapshotUpperVersion,
		continuation:         continuation,
		cursor:               cursor,
		fetchLimit:           limit + 1,
	})
	if err != nil {
		return nil, false, fmt.Errorf("failed to query versioned objects: %w", err)
	}
	items, err := collectObjects(rows)
	if err != nil {
		return nil, false, err
	}
	out, more := TrimToLimitWithMore(items, limit)
	return out, more, nil
}

// QueryDeletionsByTypeAndVersion returns one version-ordered page of deletion tombstones.
func QueryDeletionsByTypeAndVersion(
	ctx context.Context,
	tx pgx.Tx,
	resourceType string,
	sinceVersion, snapshotUpperVersion int64,
	continuation bool,
	cursor *ParsedVersionCursor,
	limit int,
) ([]DeletedResource, bool, error) {
	rows, err := openVersionCursorPagedRows(ctx, tx, versionCursorPageOpts{
		selectFrom:           deletionsSelectSQL,
		idColumn:             "resource_id",
		sinceVersion:         sinceVersion,
		snapshotUpperVersion: snapshotUpperVersion,
		continuation:         continuation,
		cursor:               cursor,
		fetchLimit:           limit + 1,
		eqFilter:             &cursorPageEqFilter{column: "resource_type", value: resourceType},
	})
	if err != nil {
		return nil, false, err
	}
	items, err := collectDeletedResources(rows, resourceType)
	if err != nil {
		return nil, false, err
	}
	out, more := TrimToLimitWithMore(items, limit)
	return out, more, nil
}
