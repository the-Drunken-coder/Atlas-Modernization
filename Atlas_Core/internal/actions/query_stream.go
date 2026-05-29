package actions

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/models"
)

const (
	entitySelectSQL = `SELECT entity_id, type, subtype, alias, json, created_at, updated_at FROM entities`
	taskSelectSQL   = `SELECT task_id, status, entity_id, json, created_at, updated_at FROM tasks`
	objectSelectSQL = `SELECT object_id, path, content_type, type, json, created_at, updated_at FROM objects`
)

type cursorPageOpts struct {
	selectFrom         string
	idColumn           string
	timeColumn         string
	since              time.Time
	snapshotUpperBound time.Time
	continuation       bool
	cursor             *parsedQueryCursor
	fetchLimit         int
	eqFilter           *cursorPageEqFilter
}

type cursorPageEqFilter struct {
	column string
	value  string
}

func openCursorPagedRows(ctx context.Context, tx pgx.Tx, opts cursorPageOpts) (pgx.Rows, error) {
	if opts.continuation && opts.cursor == nil {
		return nil, nil
	}

	var clauses []string
	var args []any
	addArg := func(v any) string {
		args = append(args, v)
		return fmt.Sprintf("$%d", len(args))
	}

	if opts.eqFilter != nil {
		clauses = append(clauses, fmt.Sprintf("%s = %s", opts.eqFilter.column, addArg(opts.eqFilter.value)))
	}
	if !opts.since.IsZero() {
		clauses = append(clauses, fmt.Sprintf("%s > %s", opts.timeColumn, addArg(opts.since)))
	}

	if opts.cursor != nil {
		cursorUpperBound := opts.cursor.upperBound
		if cursorUpperBound.IsZero() {
			cursorUpperBound = opts.snapshotUpperBound
		}
		if !cursorUpperBound.IsZero() {
			clauses = append(clauses, fmt.Sprintf("%s <= %s::timestamptz", opts.timeColumn, addArg(cursorUpperBound)))
		}
		clauses = append(clauses, fmt.Sprintf("(%s, %s) < (%s::timestamptz, %s::varchar)",
			opts.timeColumn, opts.idColumn,
			addArg(opts.cursor.timestamp), addArg(opts.cursor.id),
		))
	} else {
		clauses = append(clauses, fmt.Sprintf("%s <= %s::timestamptz", opts.timeColumn, addArg(opts.snapshotUpperBound)))
	}

	query := fmt.Sprintf("%s WHERE %s ORDER BY %s DESC, %s DESC LIMIT %s",
		opts.selectFrom,
		strings.Join(clauses, " AND "),
		opts.timeColumn,
		opts.idColumn,
		addArg(opts.fetchLimit),
	)
	return tx.Query(ctx, query, args...)
}

func collectEntities(rows pgx.Rows) ([]*models.Entity, error) {
	if rows == nil {
		return nil, nil
	}
	defer rows.Close()

	var out []*models.Entity
	for rows.Next() {
		var e models.Entity
		if err := rows.Scan(&e.EntityID, &e.Type, &e.Subtype, &e.Alias, &e.JSON, &e.CreatedAt, &e.UpdatedAt); err != nil {
			return nil, fmt.Errorf("failed to scan entity: %w", err)
		}
		out = append(out, &e)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating entity rows: %w", err)
	}
	return out, nil
}

func collectTasks(rows pgx.Rows) ([]*models.Task, error) {
	if rows == nil {
		return nil, nil
	}
	defer rows.Close()

	var out []*models.Task
	for rows.Next() {
		var t models.Task
		if err := rows.Scan(&t.TaskID, &t.Status, &t.EntityID, &t.JSON, &t.CreatedAt, &t.UpdatedAt); err != nil {
			return nil, fmt.Errorf("failed to scan task: %w", err)
		}
		out = append(out, &t)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating task rows: %w", err)
	}
	return out, nil
}

func collectObjects(rows pgx.Rows) ([]*models.MediaObject, error) {
	if rows == nil {
		return nil, nil
	}
	defer rows.Close()

	var out []*models.MediaObject
	for rows.Next() {
		var o models.MediaObject
		if err := rows.Scan(&o.ObjectID, &o.Path, &o.ContentType, &o.Type, &o.JSON, &o.CreatedAt, &o.UpdatedAt); err != nil {
			return nil, fmt.Errorf("failed to scan object: %w", err)
		}
		out = append(out, &o)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating object rows: %w", err)
	}
	return out, nil
}

func collectDeletedResources(rows pgx.Rows, resourceType string) ([]DeletedResource, error) {
	if rows == nil {
		return nil, nil
	}
	defer rows.Close()

	var out []DeletedResource
	for rows.Next() {
		var resourceID string
		var deletedAt time.Time
		if err := rows.Scan(&resourceID, &deletedAt); err != nil {
			return nil, err
		}
		out = append(out, DeletedResource{
			ID:        resourceID,
			Type:      resourceType,
			DeletedAt: deletedAt.UTC().Format(time.RFC3339Nano),
		})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

func queryEntities(
	ctx context.Context,
	tx pgx.Tx,
	timeColumn string,
	since, snapshotUpper time.Time,
	continuation bool,
	cursor *parsedQueryCursor,
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
	out, more := trimToLimitWithMore(items, limit)
	return out, more, nil
}

func queryDeletionsByType(
	ctx context.Context,
	tx pgx.Tx,
	resourceType string,
	since, snapshotUpper time.Time,
	continuation bool,
	cursor *parsedQueryCursor,
	limit int,
) ([]DeletedResource, bool, error) {
	rows, err := openCursorPagedRows(ctx, tx, cursorPageOpts{
		selectFrom:         `SELECT resource_id, deleted_at FROM deletions`,
		idColumn:           "resource_id",
		timeColumn:         "deleted_at",
		since:              since,
		snapshotUpperBound: snapshotUpper,
		continuation:       continuation,
		cursor:             cursor,
		fetchLimit:         limit + 1,
		eqFilter:           &cursorPageEqFilter{column: "resource_type", value: resourceType},
	})
	if err != nil {
		return nil, false, err
	}
	items, err := collectDeletedResources(rows, resourceType)
	if err != nil {
		return nil, false, err
	}
	out, more := trimToLimitWithMore(items, limit)
	return out, more, nil
}
