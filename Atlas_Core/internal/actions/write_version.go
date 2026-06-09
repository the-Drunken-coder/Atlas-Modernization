package actions

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const changeVersionLockKey = "atlas-core-change-version"

// BeginChangeTx starts a write transaction holding the global change-version
// advisory lock so resource versions are assigned in commit order.
func BeginChangeTx(ctx context.Context, pool *pgxpool.Pool, label string) (pgx.Tx, error) {
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, fmt.Errorf("failed to begin %s transaction: %w", label, err)
	}
	if err := LockChangeVersion(ctx, tx); err != nil {
		_ = tx.Rollback(ctx)
		return nil, fmt.Errorf("failed to lock %s change version: %w", label, err)
	}
	return tx, nil
}

// LockChangeVersion takes the global change-version advisory lock inside tx.
func LockChangeVersion(ctx context.Context, tx pgx.Tx) error {
	_, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1))`, changeVersionLockKey)
	return err
}
