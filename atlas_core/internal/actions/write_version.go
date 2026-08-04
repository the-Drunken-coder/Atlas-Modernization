package actions

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func beginChangeTx(ctx context.Context, pool *pgxpool.Pool, label string) (pgx.Tx, error) {
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, fmt.Errorf("failed to begin %s transaction: %w", label, err)
	}
	return tx, nil
}

func nextChangeVersion(ctx context.Context, tx pgx.Tx) (int64, error) {
	var version int64
	if err := tx.QueryRow(ctx, `
		UPDATE atlas_change_clock
		SET version = version + 1
		WHERE singleton
		RETURNING version
	`).Scan(&version); err != nil {
		return 0, fmt.Errorf("allocate change version: %w", err)
	}
	return version, nil
}
