package syncactions

import (
	"context"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/actions"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/models"
)

const (
	versionEntitySelectSQL    = `SELECT entity_id, type, subtype, alias, json, created_at, updated_at, version FROM entities`
	versionTaskSelectSQL      = `SELECT task_id, status, entity_id, json, created_at, updated_at, version FROM tasks`
	versionObjectSelectSQL    = `SELECT object_id, path, content_type, type, json, created_at, updated_at, version FROM objects`
	versionDeletionsSelectSQL = `SELECT resource_id, deleted_at, version FROM deletions`
)

var (
	versionAllowedSelectFrom = map[string]struct{}{
		versionEntitySelectSQL:    {},
		versionTaskSelectSQL:      {},
		versionObjectSelectSQL:    {},
		versionDeletionsSelectSQL: {},
	}
	versionAllowedColumns = map[string]struct{}{
		"entity_id":     {},
		"task_id":       {},
		"object_id":     {},
		"resource_id":   {},
		"version":       {},
		"resource_type": {},
	}
)

type versionCursorPageOpts struct {
	selectFrom           string
	idColumn             string
	sinceVersion         int64
	snapshotUpperVersion int64
	continuation         bool
	cursor               *parsedVersionCursor
	fetchLimit           int
	eqFilter             *versionCursorPageEqFilter
}

type versionCursorPageEqFilter struct {
	column string
	value  string
}

type versionCursorPageWhere struct {
	clauses []string
	args    []interface{}
}

func (w *versionCursorPageWhere) addArg(v interface{}) string {
	w.args = append(w.args, v)
	return fmt.Sprintf("$%d", len(w.args))
}

func (w *versionCursorPageWhere) addClause(clause string) {
	w.clauses = append(w.clauses, clause)
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
		selectFrom:           versionEntitySelectSQL,
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
	items, err := collectVersionEntities(rows)
	if err != nil {
		return nil, false, err
	}
	out, more := actions.TrimToLimitWithMore(items, limit)
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
		selectFrom:           versionTaskSelectSQL,
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
	items, err := collectVersionTasks(rows)
	if err != nil {
		return nil, false, err
	}
	out, more := actions.TrimToLimitWithMore(items, limit)
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
		selectFrom:           versionObjectSelectSQL,
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
	items, err := collectVersionObjects(rows)
	if err != nil {
		return nil, false, err
	}
	out, more := actions.TrimToLimitWithMore(items, limit)
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
		selectFrom:           versionDeletionsSelectSQL,
		idColumn:             "resource_id",
		sinceVersion:         sinceVersion,
		snapshotUpperVersion: snapshotUpperVersion,
		continuation:         continuation,
		cursor:               cursor,
		fetchLimit:           limit + 1,
		eqFilter:             &versionCursorPageEqFilter{column: "resource_type", value: resourceType},
	})
	if err != nil {
		return nil, false, err
	}
	items, err := collectDeletedResources(rows, resourceType)
	if err != nil {
		return nil, false, err
	}
	out, more := actions.TrimToLimitWithMore(items, limit)
	return out, more, nil
}

func openVersionCursorPagedRows(ctx context.Context, tx pgx.Tx, opts versionCursorPageOpts) (pgx.Rows, error) {
	if opts.continuation && opts.cursor == nil {
		return nil, fmt.Errorf("version cursor pagination continuation requires a cursor")
	}
	if _, ok := versionAllowedSelectFrom[opts.selectFrom]; !ok {
		return nil, fmt.Errorf("disallowed select clause in version pagination: %q", opts.selectFrom)
	}
	if _, ok := versionAllowedColumns[opts.idColumn]; !ok {
		return nil, fmt.Errorf("disallowed id column in version pagination: %q", opts.idColumn)
	}
	if opts.eqFilter != nil {
		if _, ok := versionAllowedColumns[opts.eqFilter.column]; !ok {
			return nil, fmt.Errorf("disallowed filter column in version pagination: %q", opts.eqFilter.column)
		}
	}

	where := &versionCursorPageWhere{}
	if opts.eqFilter != nil {
		where.addClause(fmt.Sprintf("%s = %s", opts.eqFilter.column, where.addArg(opts.eqFilter.value)))
	}
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
			where.addArg(opts.cursor.Version),
			where.addArg(opts.cursor.ID),
		))
	} else if opts.snapshotUpperVersion > 0 {
		where.addClause(fmt.Sprintf("version <= %s::bigint", where.addArg(opts.snapshotUpperVersion)))
	}
	if len(where.clauses) == 0 {
		where.addClause("TRUE")
	}

	query := fmt.Sprintf("%s WHERE %s ORDER BY version DESC, %s DESC LIMIT %s",
		opts.selectFrom,
		strings.Join(where.clauses, " AND "),
		opts.idColumn,
		where.addArg(opts.fetchLimit),
	)
	return tx.Query(ctx, query, where.args...)
}
