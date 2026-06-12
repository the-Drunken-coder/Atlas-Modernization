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
	entitySelectSQL    = `SELECT entity_id, type, subtype, alias, json, created_at, updated_at, version FROM entities`
	taskSelectSQL      = `SELECT task_id, status, entity_id, json, created_at, updated_at, version FROM tasks`
	objectSelectSQL    = `SELECT object_id, path, content_type, type, json, created_at, updated_at, version FROM objects`
	deletionsSelectSQL = `SELECT resource_id, deleted_at, version, CASE WHEN resource_type = 'task' THEN context->>'entity_id' ELSE NULL END FROM deletions`
)

// Allowlists for the identifiers interpolated into cursor-paged SQL. Every value
// is supplied by code (never by request input), but validating against a fixed
// set keeps the dynamic SQL safe even if a future caller is added carelessly.
var (
	allowedSelectFrom = map[string]struct{}{
		entitySelectSQL:    {},
		taskSelectSQL:      {},
		objectSelectSQL:    {},
		deletionsSelectSQL: {},
	}
	allowedColumns = map[string]struct{}{
		"entity_id":     {},
		"task_id":       {},
		"object_id":     {},
		"resource_id":   {},
		"created_at":    {},
		"updated_at":    {},
		"deleted_at":    {},
		"version":       {},
		"resource_type": {},
	}
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

type versionCursorPageOpts struct {
	selectFrom           string
	idColumn             string
	sinceVersion         int64
	snapshotUpperVersion int64
	continuation         bool
	cursor               *parsedVersionCursor
	fetchLimit           int
	eqFilter             *cursorPageEqFilter
}

type orderedCursorPageOpts struct {
	selectFrom  string
	idColumn    string
	orderColumn string
	fetchLimit  int
	eqFilter    *cursorPageEqFilter
	addBounds   func(*cursorPageWhere)
}

type cursorPageWhere struct {
	clauses []string
	args    []any
}

func (w *cursorPageWhere) addArg(v any) string {
	w.args = append(w.args, v)
	return fmt.Sprintf("$%d", len(w.args))
}

func (w *cursorPageWhere) addClause(clause string) {
	w.clauses = append(w.clauses, clause)
}

func openOrderedCursorPagedRows(ctx context.Context, tx pgx.Tx, opts orderedCursorPageOpts) (pgx.Rows, error) {
	if _, ok := allowedSelectFrom[opts.selectFrom]; !ok {
		return nil, fmt.Errorf("disallowed select clause in cursor pagination: %q", opts.selectFrom)
	}
	if _, ok := allowedColumns[opts.idColumn]; !ok {
		return nil, fmt.Errorf("disallowed id column in cursor pagination: %q", opts.idColumn)
	}
	if _, ok := allowedColumns[opts.orderColumn]; !ok {
		return nil, fmt.Errorf("disallowed order column in cursor pagination: %q", opts.orderColumn)
	}
	if opts.eqFilter != nil {
		if _, ok := allowedColumns[opts.eqFilter.column]; !ok {
			return nil, fmt.Errorf("disallowed filter column in cursor pagination: %q", opts.eqFilter.column)
		}
	}

	where := &cursorPageWhere{}

	if opts.eqFilter != nil {
		where.addClause(fmt.Sprintf("%s = %s", opts.eqFilter.column, where.addArg(opts.eqFilter.value)))
	}
	if opts.addBounds != nil {
		opts.addBounds(where)
	}
	if len(where.clauses) == 0 {
		where.addClause("TRUE")
	}

	query := fmt.Sprintf("%s WHERE %s ORDER BY %s DESC, %s DESC LIMIT %s",
		opts.selectFrom,
		strings.Join(where.clauses, " AND "),
		opts.orderColumn,
		opts.idColumn,
		where.addArg(opts.fetchLimit),
	)
	return tx.Query(ctx, query, where.args...)
}

func openCursorPagedRows(ctx context.Context, tx pgx.Tx, opts cursorPageOpts) (pgx.Rows, error) {
	if opts.continuation && opts.cursor == nil {
		return nil, fmt.Errorf("cursor pagination continuation requires a cursor")
	}

	return openOrderedCursorPagedRows(ctx, tx, orderedCursorPageOpts{
		selectFrom:  opts.selectFrom,
		idColumn:    opts.idColumn,
		orderColumn: opts.timeColumn,
		fetchLimit:  opts.fetchLimit,
		eqFilter:    opts.eqFilter,
		addBounds: func(where *cursorPageWhere) {
			if !opts.since.IsZero() {
				where.addClause(fmt.Sprintf("%s > %s", opts.timeColumn, where.addArg(opts.since)))
			}

			if opts.cursor != nil {
				cursorUpperBound := effectiveCursorUpperBound(opts.cursor, opts.snapshotUpperBound)
				if !cursorUpperBound.IsZero() {
					where.addClause(fmt.Sprintf("%s <= %s::timestamptz", opts.timeColumn, where.addArg(cursorUpperBound)))
				}
				where.addClause(fmt.Sprintf("(%s, %s) < (%s::timestamptz, %s::varchar)",
					opts.timeColumn, opts.idColumn,
					where.addArg(opts.cursor.timestamp), where.addArg(opts.cursor.id),
				))
			} else {
				where.addClause(fmt.Sprintf("%s <= %s::timestamptz", opts.timeColumn, where.addArg(opts.snapshotUpperBound)))
			}
		},
	})
}

func openVersionCursorPagedRows(ctx context.Context, tx pgx.Tx, opts versionCursorPageOpts) (pgx.Rows, error) {
	if opts.continuation && opts.cursor == nil {
		return nil, fmt.Errorf("version cursor pagination continuation requires a cursor")
	}

	return openOrderedCursorPagedRows(ctx, tx, orderedCursorPageOpts{
		selectFrom:  opts.selectFrom,
		idColumn:    opts.idColumn,
		orderColumn: "version",
		fetchLimit:  opts.fetchLimit,
		eqFilter:    opts.eqFilter,
		addBounds: func(where *cursorPageWhere) {
			if opts.sinceVersion > 0 {
				where.addClause(fmt.Sprintf("version > %s::bigint", where.addArg(opts.sinceVersion)))
			}

			if opts.cursor != nil {
				cursorUpperBound := effectiveVersionCursorUpperBound(opts.cursor, opts.snapshotUpperVersion)
				if cursorUpperBound > 0 {
					where.addClause(fmt.Sprintf("version <= %s::bigint", where.addArg(cursorUpperBound)))
				}
				where.addClause(fmt.Sprintf("(version, %s) < (%s::bigint, %s::varchar)",
					opts.idColumn,
					where.addArg(opts.cursor.version), where.addArg(opts.cursor.id),
				))
			} else if opts.snapshotUpperVersion > 0 {
				where.addClause(fmt.Sprintf("version <= %s::bigint", where.addArg(opts.snapshotUpperVersion)))
			}
		},
	})
}

func collectEntities(rows pgx.Rows) ([]*models.Entity, error) {
	if rows == nil {
		return nil, nil
	}
	defer rows.Close()

	var out []*models.Entity
	for rows.Next() {
		var e models.Entity
		if err := rows.Scan(&e.EntityID, &e.Type, &e.Subtype, &e.Alias, &e.JSON, &e.CreatedAt, &e.UpdatedAt, &e.Version); err != nil {
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
		if err := rows.Scan(&t.TaskID, &t.Status, &t.EntityID, &t.JSON, &t.CreatedAt, &t.UpdatedAt, &t.Version); err != nil {
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
		if err := rows.Scan(&o.ObjectID, &o.Path, &o.ContentType, &o.Type, &o.JSON, &o.CreatedAt, &o.UpdatedAt, &o.Version); err != nil {
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
		var version int64
		var entityID *string
		if err := rows.Scan(&resourceID, &deletedAt, &version, &entityID); err != nil {
			return nil, fmt.Errorf("failed to scan deleted resource: %w", err)
		}
		out = append(out, DeletedResource{
			ID:        resourceID,
			Type:      resourceType,
			EntityID:  entityID,
			DeletedAt: deletedAt.UTC().Format(time.RFC3339Nano),
			Version:   version,
		})
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating deleted resource rows: %w", err)
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
		eqFilter:           &cursorPageEqFilter{column: "entity_id", value: entityID},
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

func queryEntitiesByVersion(
	ctx context.Context,
	tx pgx.Tx,
	sinceVersion, snapshotUpperVersion int64,
	continuation bool,
	cursor *parsedVersionCursor,
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
	out, more := trimToLimitWithMore(items, limit)
	return out, more, nil
}

func queryTasksByVersion(
	ctx context.Context,
	tx pgx.Tx,
	sinceVersion, snapshotUpperVersion int64,
	continuation bool,
	cursor *parsedVersionCursor,
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
	out, more := trimToLimitWithMore(items, limit)
	return out, more, nil
}

func queryObjectsByVersion(
	ctx context.Context,
	tx pgx.Tx,
	sinceVersion, snapshotUpperVersion int64,
	continuation bool,
	cursor *parsedVersionCursor,
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
	out, more := trimToLimitWithMore(items, limit)
	return out, more, nil
}

func queryDeletionsByTypeAndVersion(
	ctx context.Context,
	tx pgx.Tx,
	resourceType string,
	sinceVersion, snapshotUpperVersion int64,
	continuation bool,
	cursor *parsedVersionCursor,
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
	out, more := trimToLimitWithMore(items, limit)
	return out, more, nil
}
