package actions

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type cursorListPageOptions[T any] struct {
	limit       int
	cursor      string
	cursorLabel string
	operation   string
	cursorName  string
	query       func(context.Context, pgx.Tx, time.Time, bool, *parsedQueryCursor, int) ([]T, bool, error)
	rowCursor   func(T) (time.Time, string)
}

func readCursorListPage[T any](ctx context.Context, pool *pgxpool.Pool, opts cursorListPageOptions[T]) (*ListPage[T], error) {
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{
		IsoLevel:   pgx.RepeatableRead,
		AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return nil, fmt.Errorf("begin %s transaction: %w", opts.operation, err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var txUpperBound time.Time
	if err := tx.QueryRow(ctx, `SELECT statement_timestamp()`).Scan(&txUpperBound); err != nil {
		return nil, fmt.Errorf("read %s snapshot timestamp: %w", opts.operation, err)
	}

	parsedCursor, err := parseQueryCursor(opts.cursor, opts.cursorLabel)
	if err != nil {
		return nil, err
	}
	snapshotUpperBound, continuation, err := continuationUpperBound(txUpperBound, parsedCursor)
	if err != nil {
		return nil, err
	}

	items, hasMore, err := opts.query(ctx, tx, snapshotUpperBound, continuation, parsedCursor, opts.limit)
	if err != nil {
		return nil, err
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit %s transaction: %w", opts.operation, err)
	}

	return listPageWithCursor(items, opts.limit, hasMore, snapshotUpperBound, opts.cursorName, opts.rowCursor)
}

func listPageWithCursor[T any](items []T, limit int, hasMore bool, snapshotUpperBound time.Time, cursorName string, rowCursor func(T) (time.Time, string)) (*ListPage[T], error) {
	page := &ListPage[T]{
		Items:   items,
		Limit:   limit,
		HasMore: hasMore,
	}
	if hasMore && len(items) > 0 {
		lastTimestamp, lastID := rowCursor(items[len(items)-1])
		nextCursor, err := encodeRowCursor(lastTimestamp, lastID, snapshotUpperBound)
		if err != nil {
			return nil, fmt.Errorf("encode %s cursor: %w", cursorName, err)
		}
		page.NextCursor = nextCursor
	}
	return page, nil
}
