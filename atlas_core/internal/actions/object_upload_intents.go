package actions

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

const (
	storageUploadIntentLease     = 5 * time.Minute
	storageUploadHeartbeatPeriod = time.Minute
	storageUploadOrphanGrace     = 5 * time.Minute
)

type objectStoragePathQueryer interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func ensureObjectStoragePathAvailable(ctx context.Context, db objectStoragePathQueryer, path, objectID string) error {
	path = strings.TrimSpace(path)
	if path == "" {
		return nil
	}

	var unavailable bool
	if err := db.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM objects WHERE path = $1 AND object_id <> $2)
			OR EXISTS (SELECT 1 FROM storage_upload_intents WHERE path = $1)
			OR EXISTS (SELECT 1 FROM storage_deletion_outbox WHERE path = $1)
	`, path, strings.TrimSpace(objectID)).Scan(&unavailable); err != nil {
		return fmt.Errorf("failed to check object storage path state: %w", err)
	}
	if unavailable {
		return NewObjectPathConflictError()
	}
	return nil
}

func (a *ObjectActions) createStorageUploadIntentTx(ctx context.Context, tx pgx.Tx, bucket, path, objectID, ownerID string) error {
	if err := ensureObjectStoragePathAvailable(ctx, tx, path, objectID); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `
		INSERT INTO storage_upload_intents (bucket, path, object_id, owner_id, expires_at)
		VALUES ($1, $2, $3, $4, clock_timestamp() + make_interval(secs => $5))
	`, strings.TrimSpace(bucket), strings.TrimSpace(path), strings.TrimSpace(objectID), ownerID, int(storageUploadIntentLease/time.Second))
	if err != nil {
		return fmt.Errorf("failed to register storage upload intent: %w", err)
	}
	return nil
}

func (a *ObjectActions) renewStorageUploadIntent(ctx context.Context, bucket, path, ownerID string) (bool, error) {
	result, err := a.pool.Exec(ctx, `
		UPDATE storage_upload_intents
		SET expires_at = clock_timestamp() + make_interval(secs => $4),
			updated_at = clock_timestamp()
		WHERE bucket = $1 AND path = $2 AND owner_id = $3 AND orphaned_at IS NULL
	`, strings.TrimSpace(bucket), strings.TrimSpace(path), ownerID, int(storageUploadIntentLease/time.Second))
	if err != nil {
		return false, fmt.Errorf("failed to renew storage upload intent: %w", err)
	}
	return result.RowsAffected() == 1, nil
}

func (a *ObjectActions) runStorageUploadHeartbeat(ctx context.Context, bucket, path, ownerID string, interval time.Duration, reportFailure func(error)) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	lastRenewed := time.Now()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			owned, err := a.renewStorageUploadIntent(ctx, bucket, path, ownerID)
			if err != nil {
				if time.Since(lastRenewed) < storageUploadIntentLease-interval {
					continue
				}
				reportFailure(fmt.Errorf("storage upload intent lease could not be renewed: %w", err))
				return
			}
			if !owned {
				reportFailure(errors.New("storage upload intent ownership was lost"))
				return
			}
			lastRenewed = time.Now()
		}
	}
}

func (a *ObjectActions) lockOwnedStorageUploadIntentTx(ctx context.Context, tx pgx.Tx, bucket, path, ownerID string) error {
	var owned int
	err := tx.QueryRow(ctx, `
		SELECT 1
		FROM storage_upload_intents
		WHERE bucket = $1 AND path = $2 AND owner_id = $3
			AND orphaned_at IS NULL AND expires_at > clock_timestamp()
		FOR UPDATE
	`, strings.TrimSpace(bucket), strings.TrimSpace(path), ownerID).Scan(&owned)
	if errors.Is(err, pgx.ErrNoRows) {
		return errors.New("storage upload intent ownership was lost or its lease expired")
	}
	if err != nil {
		return fmt.Errorf("failed to lock storage upload intent: %w", err)
	}
	return nil
}

func (a *ObjectActions) deleteStorageUploadIntentTx(ctx context.Context, tx pgx.Tx, bucket, path, ownerID string) error {
	result, err := tx.Exec(ctx, `
		DELETE FROM storage_upload_intents
		WHERE bucket = $1 AND path = $2 AND owner_id = $3
	`, strings.TrimSpace(bucket), strings.TrimSpace(path), ownerID)
	if err != nil {
		return fmt.Errorf("failed to clear storage upload intent: %w", err)
	}
	if result.RowsAffected() != 1 {
		return errors.New("storage upload intent ownership was lost")
	}
	return nil
}

func (a *ObjectActions) abandonStorageUpload(ctx context.Context, bucket, path, objectID, ownerID string, cause error) error {
	cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
	defer cancel()

	tx, err := a.pool.BeginTx(cleanupCtx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("%w (also failed to begin durable upload cleanup: %w)", cause, err)
	}
	defer func() { _ = tx.Rollback(cleanupCtx) }()

	if err := a.deleteStorageUploadIntentTx(cleanupCtx, tx, bucket, path, ownerID); err != nil {
		return fmt.Errorf("%w (durable upload cleanup remains pending: %w)", cause, err)
	}
	if err := a.queueStorageDeletionTx(cleanupCtx, tx, bucket, path, objectID); err != nil {
		return fmt.Errorf("%w (durable upload cleanup remains pending: %w)", cause, err)
	}
	if err := tx.Commit(cleanupCtx); err != nil {
		return fmt.Errorf("%w (failed to commit durable upload cleanup: %w)", cause, err)
	}

	if err := a.deleteQueuedStoragePathNow(cleanupCtx, bucket, path); err != nil {
		return fmt.Errorf("%w (uploaded blob cleanup queued: %w)", cause, err)
	}
	return cause
}

func (a *ObjectActions) recoverStorageUploadIntents(ctx context.Context, limit int) (int, error) {
	if _, err := a.pool.Exec(ctx, `
		UPDATE storage_upload_intents
		SET orphaned_at = clock_timestamp(), updated_at = clock_timestamp()
		WHERE orphaned_at IS NULL AND expires_at <= clock_timestamp()
	`); err != nil {
		return 0, fmt.Errorf("mark expired storage upload intents: %w", err)
	}

	tx, err := a.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return 0, fmt.Errorf("begin storage upload intent recovery: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
		SELECT bucket, path, object_id
		FROM storage_upload_intents
		WHERE orphaned_at IS NOT NULL
			AND orphaned_at <= clock_timestamp() - make_interval(secs => $2)
		ORDER BY orphaned_at, path
		LIMIT $1
		FOR UPDATE SKIP LOCKED
	`, limit, int(storageUploadOrphanGrace/time.Second))
	if err != nil {
		return 0, fmt.Errorf("query recoverable storage upload intents: %w", err)
	}
	type intent struct{ bucket, path, objectID string }
	intents := make([]intent, 0)
	for rows.Next() {
		var item intent
		if err := rows.Scan(&item.bucket, &item.path, &item.objectID); err != nil {
			rows.Close()
			return 0, fmt.Errorf("scan storage upload intent: %w", err)
		}
		intents = append(intents, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return 0, fmt.Errorf("iterate storage upload intents: %w", err)
	}
	rows.Close()

	recovered := 0
	for _, item := range intents {
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1))`, objectUploadLockKey(item.objectID)); err != nil {
			return 0, fmt.Errorf("lock object upload intent recovery: %w", err)
		}
		var live bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM objects WHERE path = $1)`, item.path).Scan(&live); err != nil {
			return 0, fmt.Errorf("check storage upload intent live reference: %w", err)
		}
		if !live {
			if err := a.queueStorageDeletionTx(ctx, tx, item.bucket, item.path, item.objectID); err != nil {
				return 0, err
			}
		}
		if _, err := tx.Exec(ctx, `DELETE FROM storage_upload_intents WHERE bucket = $1 AND path = $2`, item.bucket, item.path); err != nil {
			return 0, fmt.Errorf("clear recovered storage upload intent: %w", err)
		}
		recovered++
	}

	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("commit storage upload intent recovery: %w", err)
	}
	return recovered, nil
}
