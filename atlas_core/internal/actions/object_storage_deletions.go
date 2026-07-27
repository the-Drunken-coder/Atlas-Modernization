package actions

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/rs/zerolog/log"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/storage"
)

type queuedStorageDeletion struct {
	id       int64
	bucket   string
	path     string
	attempts int
}

const storageDeletionClaimLease = 5 * time.Minute

// maxObjectStorageDeletionAttempts caps storage deletion outbox retries. With
// the exponential backoff (capped at 64 minutes) a row reaches this cap after
// roughly 15 hours of failures; at that point it is dead-lettered — excluded
// from claims and left in the table for operators to inspect or requeue
// manually.
const maxObjectStorageDeletionAttempts = 20

const queueStorageDeletionSQL = `
	INSERT INTO storage_deletion_outbox (bucket, path, object_id)
	VALUES ($1, $2, $3)
	ON CONFLICT (bucket, path) DO UPDATE
	SET object_id = EXCLUDED.object_id,
		attempts = 0,
		last_error = NULL,
		next_attempt_at = clock_timestamp(),
		updated_at = clock_timestamp()
`

const queueStorageDeletionPreserveRetrySQL = `
	INSERT INTO storage_deletion_outbox (bucket, path, object_id)
	VALUES ($1, $2, $3)
	ON CONFLICT (bucket, path) DO UPDATE
	SET object_id = EXCLUDED.object_id,
		updated_at = clock_timestamp()
`

func storageDeletionRetryDelay(attempts int) time.Duration {
	if attempts <= 1 {
		return time.Minute
	}
	if attempts > 7 {
		attempts = 7
	}
	return time.Duration(1<<(attempts-1)) * time.Minute
}

func normalizeStorageDeletion(bucket, path, objectID string) (string, string, any, bool) {
	bucket = strings.TrimSpace(bucket)
	path = strings.TrimSpace(path)
	objectID = strings.TrimSpace(objectID)
	if bucket == "" || path == "" {
		return "", "", nil, false
	}

	var objectIDArg any
	if objectID != "" {
		objectIDArg = objectID
	}
	return bucket, path, objectIDArg, true
}

func (a *ObjectActions) queueStorageDeletionTx(ctx context.Context, tx pgx.Tx, bucket, path, objectID string) error {
	bucket, path, objectIDArg, ok := normalizeStorageDeletion(bucket, path, objectID)
	if !ok {
		return nil
	}

	_, err := tx.Exec(ctx, queueStorageDeletionSQL, bucket, path, objectIDArg)
	if err != nil {
		return fmt.Errorf("failed to queue storage deletion: %w", err)
	}
	return nil
}

func (a *ObjectActions) queueStorageDeletionPreservingRetry(ctx context.Context, bucket, path, objectID string) error {
	return a.queueStorageDeletionWithSQL(ctx, queueStorageDeletionPreserveRetrySQL, bucket, path, objectID)
}

func (a *ObjectActions) queueStorageDeletionWithSQL(ctx context.Context, sql, bucket, path, objectID string) error {
	if a.pool == nil {
		return nil
	}
	bucket, path, objectIDArg, ok := normalizeStorageDeletion(bucket, path, objectID)
	if !ok {
		return nil
	}

	if _, err := a.pool.Exec(ctx, sql, bucket, path, objectIDArg); err != nil {
		return fmt.Errorf("failed to queue storage deletion: %w", err)
	}
	return nil
}

func (a *ObjectActions) queueStorageDeletionAfterFailure(ctx context.Context, bucket, path, objectID string, deleteErr error) error {
	if err := a.queueStorageDeletionPreservingRetry(ctx, bucket, path, objectID); err != nil {
		return err
	}
	return a.recordQueuedStorageDeletionFailure(ctx, bucket, path, deleteErr)
}

func (a *ObjectActions) clearQueuedStorageDeletion(ctx context.Context, bucket, path string) error {
	if a.pool == nil {
		return nil
	}
	_, err := a.pool.Exec(ctx, `
		DELETE FROM storage_deletion_outbox
		WHERE bucket = $1 AND path = $2
	`, strings.TrimSpace(bucket), strings.TrimSpace(path))
	if err != nil {
		return fmt.Errorf("failed to clear storage deletion retry: %w", err)
	}
	return nil
}

func (a *ObjectActions) recordQueuedStorageDeletionFailure(ctx context.Context, bucket, path string, deleteErr error) error {
	if a.pool == nil {
		return nil
	}
	errText := ""
	if deleteErr != nil {
		errText = deleteErr.Error()
	}

	var attempts int
	err := a.pool.QueryRow(ctx, `
		UPDATE storage_deletion_outbox
		SET attempts = attempts + 1,
			last_error = $3,
			updated_at = clock_timestamp()
		WHERE bucket = $1 AND path = $2
		RETURNING attempts
	`, strings.TrimSpace(bucket), strings.TrimSpace(path), errText).Scan(&attempts)
	if err != nil {
		return fmt.Errorf("failed to record storage deletion retry: %w", err)
	}

	nextAttempt := time.Now().UTC().Add(storageDeletionRetryDelay(attempts))
	if _, err := a.pool.Exec(ctx, `
		UPDATE storage_deletion_outbox
		SET next_attempt_at = $3,
			updated_at = clock_timestamp()
		WHERE bucket = $1 AND path = $2
	`, strings.TrimSpace(bucket), strings.TrimSpace(path), nextAttempt); err != nil {
		return fmt.Errorf("failed to schedule storage deletion retry: %w", err)
	}
	return nil
}

func (a *ObjectActions) claimQueuedStorageDeletions(ctx context.Context, limit int) ([]queuedStorageDeletion, error) {
	tx, err := a.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, fmt.Errorf("begin storage deletion claim: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	rows, err := tx.Query(ctx, `
		SELECT id, bucket, path, attempts
		FROM storage_deletion_outbox
		WHERE next_attempt_at <= clock_timestamp()
			AND attempts < $2
		ORDER BY next_attempt_at, id
		LIMIT $1
		FOR UPDATE SKIP LOCKED
	`, limit, maxObjectStorageDeletionAttempts)
	if err != nil {
		return nil, fmt.Errorf("query storage deletion outbox: %w", err)
	}

	var queued []queuedStorageDeletion
	for rows.Next() {
		var item queuedStorageDeletion
		if err := rows.Scan(&item.id, &item.bucket, &item.path, &item.attempts); err != nil {
			rows.Close()
			return nil, fmt.Errorf("scan storage deletion outbox: %w", err)
		}
		queued = append(queued, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, fmt.Errorf("iterate storage deletion outbox: %w", err)
	}
	rows.Close()

	leaseUntil := time.Now().UTC().Add(storageDeletionClaimLease)
	for _, item := range queued {
		if _, err := tx.Exec(ctx, `
			UPDATE storage_deletion_outbox
			SET next_attempt_at = $2,
				updated_at = clock_timestamp()
			WHERE id = $1
		`, item.id, leaseUntil); err != nil {
			return nil, fmt.Errorf("claim storage deletion outbox row: %w", err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit storage deletion claim: %w", err)
	}
	return queued, nil
}

func (a *ObjectActions) recordQueuedStorageDeletionFailureByID(ctx context.Context, id int64, attempts int, errText string) error {
	if a.pool == nil {
		return nil
	}
	nextAttempt := time.Now().UTC().Add(storageDeletionRetryDelay(attempts + 1))
	if _, err := a.pool.Exec(ctx, `
		UPDATE storage_deletion_outbox
		SET attempts = attempts + 1,
			last_error = $2,
			next_attempt_at = $3,
			updated_at = clock_timestamp()
		WHERE id = $1
	`, id, errText, nextAttempt); err != nil {
		return fmt.Errorf("record storage deletion failure: %w", err)
	}
	return nil
}

func (a *ObjectActions) clearQueuedStorageDeletionByID(ctx context.Context, id int64) error {
	if a.pool == nil {
		return nil
	}
	if _, err := a.pool.Exec(ctx, `DELETE FROM storage_deletion_outbox WHERE id = $1`, id); err != nil {
		return fmt.Errorf("clear storage deletion outbox row: %w", err)
	}
	return nil
}

// logDeadLetteredStorageDeletion reports rows whose recorded failures reached
// maxObjectStorageDeletionAttempts; they are no longer claimed and remain in
// storage_deletion_outbox for manual operator handling.
func logDeadLetteredStorageDeletion(bucket, path string, attempts int, lastError string) {
	if attempts < maxObjectStorageDeletionAttempts {
		return
	}
	log.Error().
		Str("bucket", bucket).
		Str("path", path).
		Int("attempts", attempts).
		Str("last_error", lastError).
		Msg("Storage deletion dead-lettered after reaching the retry cap")
}

// ReconcileStorageDeletions retries queued storage deletions and clears successful rows.
func (a *ObjectActions) ReconcileStorageDeletions(ctx context.Context, limit int) (int, error) {
	if a.storage == nil {
		return 0, &storage.StorageError{Message: "storage not configured"}
	}
	if limit <= 0 {
		limit = 100
	}
	if limit > 500 {
		limit = 500
	}

	queued, err := a.claimQueuedStorageDeletions(ctx, limit)
	if err != nil {
		return 0, err
	}

	deleted := 0
	configuredBucket := strings.TrimSpace(a.storage.Bucket())
	for _, item := range queued {
		if strings.TrimSpace(item.bucket) != configuredBucket {
			if err := a.recordQueuedStorageDeletionFailureByID(ctx, item.id, item.attempts, "configured storage bucket does not match queued deletion bucket"); err != nil {
				return deleted, fmt.Errorf("record storage deletion bucket mismatch: %w", err)
			}
			continue
		}

		if err := a.storage.DeleteObjectPath(ctx, item.path); err != nil {
			if updateErr := a.recordQueuedStorageDeletionFailureByID(ctx, item.id, item.attempts, err.Error()); updateErr != nil {
				return deleted, fmt.Errorf("record storage deletion failure: %w", updateErr)
			}
			continue
		}

		if err := a.clearQueuedStorageDeletionByID(ctx, item.id); err != nil {
			return deleted, err
		}
		deleted++
	}

	return deleted, nil
}
