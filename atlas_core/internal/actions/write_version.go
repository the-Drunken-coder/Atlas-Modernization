package actions

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func beginChangeTx(ctx context.Context, pool *pgxpool.Pool, label string) (pgx.Tx, error) {
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, fmt.Errorf("failed to begin %s transaction: %w", label, err)
	}
	// Every versioned mutation takes locks in this order:
	// change clock -> per-object advisory lock (when used) -> intent/resource rows.
	// Reserving versions later in the transaction is safe because this lock is
	// already held. Keeping the hierarchy here prevents individual actions from
	// accidentally acquiring resource rows before the singleton clock.
	var version int64
	if err := tx.QueryRow(ctx, `SELECT version FROM atlas_change_clock WHERE singleton FOR UPDATE`).Scan(&version); err != nil {
		_ = tx.Rollback(ctx)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, fmt.Errorf("atlas_change_clock singleton row is missing; database is not initialized")
		}
		return nil, fmt.Errorf("lock change clock for %s: %w", label, err)
	}
	return tx, nil
}

func nextChangeVersion(ctx context.Context, tx pgx.Tx) (int64, error) {
	return reserveChangeVersions(ctx, tx, 1)
}

func reserveChangeVersions(ctx context.Context, tx pgx.Tx, count int) (int64, error) {
	if count <= 0 {
		return 0, fmt.Errorf("change version reservation count must be positive")
	}
	var version int64
	if err := tx.QueryRow(ctx, `
		UPDATE atlas_change_clock
		SET version = version + $1
		WHERE singleton
		RETURNING version
	`, count).Scan(&version); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, fmt.Errorf("atlas_change_clock singleton row is missing; database is not initialized")
		}
		return 0, fmt.Errorf("reserve %d change versions: %w", count, err)
	}
	return version, nil
}
