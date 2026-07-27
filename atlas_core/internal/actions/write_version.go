package actions

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"
)

const changeVersionLockKey = "atlas-core-change-version"

// changeVersionLockWarnThreshold is the advisory-lock acquisition wait above
// which a warning is logged. Every write serializes on this lock, so a wait
// beyond it means writers are queuing behind another mutation.
const changeVersionLockWarnThreshold = 250 * time.Millisecond

const currentChangeSequenceSQL = `
	SELECT CASE WHEN is_called THEN last_value ELSE 0 END
	FROM atlas_change_version_seq
`

type changeVersionSkipper interface {
	SkipVersion(version int64, reason string)
}

// gapAwareChangeTx runs writes in a savepoint while its parent retains the
// global version lock, allowing rolled-back sequence allocations to be read
// and reported without racing the next writer.
type gapAwareChangeTx struct {
	pgx.Tx
	parent       pgx.Tx
	startVersion int64
	skipper      changeVersionSkipper
	closed       bool
}

func beginChangeTx(ctx context.Context, pool *pgxpool.Pool, label string, sink ChangeSink) (pgx.Tx, error) {
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, fmt.Errorf("failed to begin %s transaction: %w", label, err)
	}
	if err := lockChangeVersion(ctx, tx); err != nil {
		_ = tx.Rollback(ctx)
		return nil, fmt.Errorf("failed to lock %s change version: %w", label, err)
	}

	skipper, ok := sink.(changeVersionSkipper)
	if !ok {
		return tx, nil
	}

	startVersion, err := readChangeSequence(ctx, tx)
	if err != nil {
		_ = tx.Rollback(ctx)
		return nil, fmt.Errorf("failed to read %s starting change version: %w", label, err)
	}
	nested, err := tx.Begin(ctx)
	if err != nil {
		_ = tx.Rollback(ctx)
		return nil, fmt.Errorf("failed to create %s recovery savepoint: %w", label, err)
	}
	return &gapAwareChangeTx{Tx: nested, parent: tx, startVersion: startVersion, skipper: skipper}, nil
}

func lockChangeVersion(ctx context.Context, tx pgx.Tx) error {
	start := time.Now()
	_, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1))`, changeVersionLockKey)
	warnOnSlowChangeVersionLock(time.Since(start))
	return err
}

// warnOnSlowChangeVersionLock logs when advisory lock acquisition queued
// behind another writer longer than changeVersionLockWarnThreshold.
func warnOnSlowChangeVersionLock(wait time.Duration) {
	if wait <= changeVersionLockWarnThreshold {
		return
	}
	log.Warn().Dur("wait", wait).Msg("Change version advisory lock acquisition exceeded threshold; writers are queuing")
}

func readChangeSequence(ctx context.Context, tx pgx.Tx) (int64, error) {
	var version int64
	err := tx.QueryRow(ctx, currentChangeSequenceSQL).Scan(&version)
	return version, err
}

func (tx *gapAwareChangeTx) Commit(ctx context.Context) error {
	if tx.closed {
		return pgx.ErrTxClosed
	}
	if err := tx.Tx.Commit(ctx); err != nil {
		tx.closed = true
		_ = tx.parent.Rollback(ctx)
		return err
	}

	if err := tx.parent.Commit(ctx); err != nil {
		tx.closed = true
		return err
	}
	tx.closed = true
	return nil
}

func (tx *gapAwareChangeTx) Rollback(ctx context.Context) error {
	if tx.closed {
		return pgx.ErrTxClosed
	}
	if err := tx.Tx.Rollback(ctx); err != nil {
		tx.closed = true
		_ = tx.parent.Rollback(ctx)
		return err
	}

	endVersion, sequenceErr := readChangeSequence(ctx, tx.parent)
	rollbackErr := tx.parent.Rollback(ctx)
	tx.closed = true
	if sequenceErr == nil && rollbackErr == nil {
		for version := tx.startVersion + 1; version <= endVersion; version++ {
			tx.skipper.SkipVersion(version, "write_transaction_rolled_back")
		}
	}
	if rollbackErr != nil {
		return rollbackErr
	}
	return sequenceErr
}
