package actions

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

func (spec resourceQuerySpec[T]) query(
	ctx context.Context,
	tx pgx.Tx,
	timeColumn string,
	since, snapshotUpper time.Time,
	continuation bool,
	cursor *parsedQueryCursor,
	limit, maxJSONBytes int,
) ([]T, bool, error) {
	return spec.queryFiltered(ctx, tx, timeColumn, since, snapshotUpper, continuation, cursor, limit, maxJSONBytes, nil, spec.queryName)
}

func (spec resourceQuerySpec[T]) queryFiltered(
	ctx context.Context,
	tx pgx.Tx,
	timeColumn string,
	since, snapshotUpper time.Time,
	continuation bool,
	cursor *parsedQueryCursor,
	limit, maxJSONBytes int,
	filter *cursorPageEqFilter,
	queryName string,
) ([]T, bool, error) {
	rows, err := openCursorPagedRows(ctx, tx, cursorPageOpts{
		selectFrom:         spec.selectFrom,
		idColumn:           spec.idColumn,
		timeColumn:         timeColumn,
		since:              since,
		snapshotUpperBound: snapshotUpper,
		continuation:       continuation,
		cursor:             cursor,
		fetchLimit:         limit + 1,
		eqFilter:           filter,
	})
	if err != nil {
		return nil, false, fmt.Errorf("failed to query %s: %w", queryName, err)
	}
	if maxJSONBytes > 0 {
		return collectByteBoundedRows(rows, limit, maxJSONBytes, spec.name, func() (T, int, error) {
			item, err := spec.scan(rows)
			return item, spec.retainedBytes(item), err
		})
	}
	items, err := collectRows(rows, spec)
	if err != nil {
		return nil, false, err
	}
	out, more := trimToLimitWithMore(items, limit)
	return out, more, nil
}
