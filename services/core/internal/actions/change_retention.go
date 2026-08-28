package actions

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ChangeRecordRetention is the fixed recovery window. Clients older than this
// rehydrate from the live resource tables instead of retaining unbounded write
// history.
const ChangeRecordRetention = 7 * 24 * time.Hour

const changeRecordPruneBatchSize = 500

// PruneChangeRecords removes expired recovery history and atomically advances
// the earliest accepted changed-since cursor. It takes the change-clock lock
// before event rows, matching the repository-wide mutation lock hierarchy.
func PruneChangeRecords(ctx context.Context, pool *pgxpool.Pool, cutoff time.Time) (int64, error) {
	return pruneChangeRecords(ctx, pool, cutoff, changeRecordPruneBatchSize, nil)
}

func pruneChangeRecords(
	ctx context.Context,
	pool *pgxpool.Pool,
	cutoff time.Time,
	batchSize int,
	afterBatch func(int64),
) (int64, error) {
	if batchSize < 1 {
		return 0, fmt.Errorf("change record prune batch size must be positive")
	}
	var total int64
	for {
		deleted, err := pruneChangeRecordBatch(ctx, pool, cutoff, batchSize)
		if err != nil {
			return total, err
		}
		total += deleted
		if deleted > 0 && afterBatch != nil {
			afterBatch(deleted)
		}
		if deleted < int64(batchSize) {
			return total, nil
		}
	}
}

func pruneChangeRecordBatch(ctx context.Context, pool *pgxpool.Pool, cutoff time.Time, batchSize int) (int64, error) {
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return 0, fmt.Errorf("begin change record pruning: %w", err)
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()

	var currentMin int64
	if err := tx.QueryRow(ctx, `SELECT min_retained_version FROM atlas_change_clock WHERE singleton FOR UPDATE`).Scan(&currentMin); err != nil {
		return 0, fmt.Errorf("lock change clock for pruning: %w", err)
	}
	var deletedCount, deletedThrough int64
	if err := tx.QueryRow(ctx, `
		WITH candidates AS (
			SELECT version
			FROM atlas_change_events
			WHERE created_at < $1
			ORDER BY created_at, version
			LIMIT $2
		), deleted AS (
			DELETE FROM atlas_change_events AS event
			USING candidates
			WHERE event.version = candidates.version
			RETURNING event.version
		)
		SELECT COUNT(*), COALESCE(MAX(version), 0) FROM deleted
	`, cutoff, batchSize).Scan(&deletedCount, &deletedThrough); err != nil {
		return 0, fmt.Errorf("prune change records: %w", err)
	}
	if deletedThrough > currentMin {
		if _, err := tx.Exec(ctx, `UPDATE atlas_change_clock SET min_retained_version = $1 WHERE singleton`, deletedThrough); err != nil {
			return 0, fmt.Errorf("advance minimum retained change version: %w", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("commit change record pruning: %w", err)
	}
	return deletedCount, nil
}
