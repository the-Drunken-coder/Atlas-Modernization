package actions

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

const (
	entitySelectSQL    = `SELECT entity_id, type, subtype, alias, json, created_at, updated_at, version FROM entities`
	taskSelectSQL      = `SELECT task_id, status, entity_id, json, created_at, updated_at, version FROM tasks`
	objectSelectSQL    = `SELECT object_id, path, content_type, type, json, created_at, updated_at, version FROM objects`
	deletionsSelectSQL = `SELECT resource_id, deleted_at, version, CASE WHEN resource_type = 'task' THEN context->>'entity_id' ELSE NULL END AS entity_id FROM deletions`
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
