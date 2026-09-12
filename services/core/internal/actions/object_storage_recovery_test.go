package actions

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/the-drunken-coder/atlas/services/core/internal/storage"
)

const (
	storageRecoveryCrashHelperEnv      = "ATLAS_STORAGE_RECOVERY_CRASH_HELPER"
	storageRecoveryCrashDatabaseEnv    = "ATLAS_STORAGE_RECOVERY_CRASH_DATABASE_URL"
	storageRecoveryCrashBucketEnv      = "ATLAS_STORAGE_RECOVERY_CRASH_BUCKET"
	storageRecoveryCrashObjectIDEnv    = "ATLAS_STORAGE_RECOVERY_CRASH_OBJECT_ID"
	storageRecoveryCrashExitCode       = 86
	storageRecoveryReconcileBatchLimit = 10
)

func TestRealStorageInterruptedUploadRecovery(t *testing.T) {
	for _, replacement := range []bool{false, true} {
		name := "new"
		if replacement {
			name = "replacement"
		}
		t.Run(name, func(t *testing.T) {
			pool, databaseURL := openIsolatedActionsTestPool(t)
			storageClient := newIsolatedStorageRecoveryClient(t)
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()

			objectID := newStorageRecoveryObjectID(t)
			defer cleanupObjectRaceTestRowsWithTimeout(t, pool, objectID)
			oldPath := ""
			oldBody := []byte("retained replacement body")
			if replacement {
				oldPath = storageClient.NewObjectPath(objectID)
				uploadStorageFixture(ctx, t, storageClient, objectID, oldPath, oldBody)
				createStoredObjectFixture(ctx, t, pool, objectID, oldPath)
				if _, err := pool.Exec(ctx, `
					UPDATE objects
					SET json = jsonb_set(
						jsonb_set(json, '{bucket}', to_jsonb($2::text), true),
						'{size_bytes}', to_jsonb($3::bigint), true
					)
					WHERE object_id = $1
				`, objectID, storageClient.Bucket(), len(oldBody)); err != nil {
					t.Fatalf("set replacement storage bucket: %v", err)
				}
			}

			// #nosec G204 G702 -- os.Args[0] is this test binary and every value is owned by this test.
			cmd := exec.Command(os.Args[0], "-test.run=^TestRealStorageInterruptedUploadHelper$")
			cmd.Env = append(os.Environ(),
				storageRecoveryCrashHelperEnv+"=1",
				storageRecoveryCrashDatabaseEnv+"="+databaseURL,
				storageRecoveryCrashBucketEnv+"="+storageClient.Bucket(),
				storageRecoveryCrashObjectIDEnv+"="+objectID,
			)
			output, err := cmd.CombinedOutput()
			var exitErr *exec.ExitError
			if !errors.As(err, &exitErr) || exitErr.ExitCode() != storageRecoveryCrashExitCode {
				t.Fatalf("interrupted upload helper error = %v, output = %s", err, output)
			}

			var intentBucket, interruptedPath string
			if err := pool.QueryRow(ctx, `
				SELECT bucket, path
				FROM storage_upload_intents
				WHERE object_id = $1
			`, objectID).Scan(&intentBucket, &interruptedPath); err != nil {
				t.Fatalf("query interrupted upload intent: %v", err)
			}
			if intentBucket != storageClient.Bucket() {
				t.Fatalf("interrupted upload bucket = %q, want %q", intentBucket, storageClient.Bucket())
			}
			if interruptedPath == "" || interruptedPath == oldPath {
				t.Fatalf("interrupted upload path = %q, want a distinct opaque path", interruptedPath)
			}
			assertStorageBody(ctx, t, storageClient, objectID, interruptedPath, []byte("interrupted body"))

			var currentPath *string
			err = pool.QueryRow(ctx, `SELECT path FROM objects WHERE object_id = $1`, objectID).Scan(&currentPath)
			if replacement {
				if err != nil {
					t.Fatalf("query replacement metadata after interruption: %v", err)
				}
				if currentPath == nil || *currentPath != oldPath {
					t.Fatalf("replacement path after interruption = %v, want %q", currentPath, oldPath)
				}
				assertStorageBody(ctx, t, storageClient, objectID, oldPath, oldBody)
			} else if !errors.Is(err, pgx.ErrNoRows) {
				t.Fatalf("new upload metadata after interruption error = %v, want no row", err)
			}

			if _, err := pool.Exec(ctx, `
				UPDATE storage_upload_intents
				SET expires_at = clock_timestamp() - interval '1 second'
				WHERE bucket = $1 AND path = $2
			`, intentBucket, interruptedPath); err != nil {
				t.Fatalf("expire interrupted upload intent: %v", err)
			}
			deleted, err := NewObjectActions(pool, storageClient).ReconcileStorageDeletions(ctx, storageRecoveryReconcileBatchLimit)
			if err != nil {
				t.Fatalf("mark interrupted upload orphaned: %v", err)
			}
			if deleted != 0 {
				t.Fatalf("first reconciliation deleted %d blobs before orphan grace elapsed", deleted)
			}
			assertStorageBody(ctx, t, storageClient, objectID, interruptedPath, []byte("interrupted body"))

			if _, err := pool.Exec(ctx, `
				UPDATE storage_upload_intents
				SET orphaned_at = clock_timestamp() - interval '6 minutes'
				WHERE bucket = $1 AND path = $2
			`, intentBucket, interruptedPath); err != nil {
				t.Fatalf("age interrupted upload intent: %v", err)
			}
			deleted, err = NewObjectActions(pool, storageClient).ReconcileStorageDeletions(ctx, storageRecoveryReconcileBatchLimit)
			if err != nil {
				t.Fatalf("recover interrupted upload: %v", err)
			}
			if deleted != 1 {
				t.Fatalf("second reconciliation deleted %d blobs, want 1", deleted)
			}
			assertStorageObjectMissing(ctx, t, storageClient, objectID, interruptedPath)
			assertPermanentStorageFence(ctx, t, pool, intentBucket, interruptedPath)
			if replacement {
				assertStorageBody(ctx, t, storageClient, objectID, oldPath, oldBody)
			}
		})
	}
}

func TestRealStorageInterruptedUploadHelper(t *testing.T) {
	if os.Getenv(storageRecoveryCrashHelperEnv) != "1" {
		return
	}
	databaseURL := os.Getenv(storageRecoveryCrashDatabaseEnv)
	bucket := os.Getenv(storageRecoveryCrashBucketEnv)
	objectID := os.Getenv(storageRecoveryCrashObjectIDEnv)
	if databaseURL == "" || bucket == "" || objectID == "" {
		t.Fatalf("interrupted upload helper requires database URL, bucket, and object ID")
	}
	pool := openActionsTestPoolAtURL(t, databaseURL)
	storageClient := newStorageRecoveryClient(t, bucket)
	_, _ = NewObjectActions(pool, &crashAfterRealUploadStorage{Client: storageClient}).Upload(
		context.Background(), objectID, strings.NewReader("interrupted body"), int64(len("interrupted body")), "text/plain", "data", nil,
	)
	t.Fatal("interrupted upload helper returned instead of crashing")
}

func TestRealStorageDeletionRecoveryRetriesAndProtectsLiveContent(t *testing.T) {
	t.Run("retry after storage failure", func(t *testing.T) {
		pool := openActionsTestPool(t)
		storageClient := newIsolatedStorageRecoveryClient(t)
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()

		objectID := newStorageRecoveryObjectID(t)
		defer cleanupObjectRaceTestRowsWithTimeout(t, pool, objectID)
		path := storageClient.NewObjectPath(objectID)
		body := []byte("queued deletion body")
		uploadStorageFixture(ctx, t, storageClient, objectID, path, body)
		if _, err := pool.Exec(ctx, `
			INSERT INTO storage_deletion_outbox (bucket, path, object_id)
			VALUES ($1, $2, $3)
		`, storageClient.Bucket(), path, objectID); err != nil {
			t.Fatalf("queue real storage deletion: %v", err)
		}

		failureCount := 1
		if os.Getenv("ATLAS_STORAGE_RECOVERY_NIGHTLY") == "1" {
			failureCount = 3
		}
		storageFailure := errors.New("injected storage outage")
		flakyStorage := &failNextDeleteStorage{objectStorage: storageClient, err: storageFailure, remaining: failureCount}
		for wantAttempts := 1; wantAttempts <= failureCount; wantAttempts++ {
			deleted, err := NewObjectActions(pool, flakyStorage).ReconcileStorageDeletions(ctx, storageRecoveryReconcileBatchLimit)
			if err != nil {
				t.Fatalf("reconcile during injected storage failure %d: %v", wantAttempts, err)
			}
			if deleted != 0 {
				t.Fatalf("reconciliation during storage failure %d deleted %d blobs, want 0", wantAttempts, deleted)
			}
			assertStorageBody(ctx, t, storageClient, objectID, path, body)

			var attempts int
			var lastError string
			var retryScheduled bool
			if err := pool.QueryRow(ctx, `
				SELECT attempts, last_error, next_attempt_at > clock_timestamp()
				FROM storage_deletion_outbox
				WHERE bucket = $1 AND path = $2
			`, storageClient.Bucket(), path).Scan(&attempts, &lastError, &retryScheduled); err != nil {
				t.Fatalf("query failed deletion retry state: %v", err)
			}
			if attempts != wantAttempts || !strings.Contains(lastError, storageFailure.Error()) || !retryScheduled {
				t.Fatalf("failed deletion retry state = attempts:%d error:%q scheduled:%t", attempts, lastError, retryScheduled)
			}
			if _, err := pool.Exec(ctx, `
				UPDATE storage_deletion_outbox
				SET next_attempt_at = clock_timestamp()
				WHERE bucket = $1 AND path = $2
			`, storageClient.Bucket(), path); err != nil {
				t.Fatalf("make failed deletion retry due: %v", err)
			}
		}

		deleted, err := NewObjectActions(pool, flakyStorage).ReconcileStorageDeletions(ctx, storageRecoveryReconcileBatchLimit)
		if err != nil {
			t.Fatalf("reconcile after storage recovery: %v", err)
		}
		if deleted != 1 {
			t.Fatalf("reconciliation after storage recovery deleted %d blobs, want 1", deleted)
		}
		assertStorageObjectMissing(ctx, t, storageClient, objectID, path)
		assertPermanentStorageFence(ctx, t, pool, storageClient.Bucket(), path)
	})

	t.Run("live path", func(t *testing.T) {
		pool := openActionsTestPool(t)
		storageClient := newIsolatedStorageRecoveryClient(t)
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()

		objectID := newStorageRecoveryObjectID(t)
		defer cleanupObjectRaceTestRowsWithTimeout(t, pool, objectID)
		path := storageClient.NewObjectPath(objectID)
		body := []byte("live resource body")
		uploadStorageFixture(ctx, t, storageClient, objectID, path, body)
		createStoredObjectFixture(ctx, t, pool, objectID, path)
		if _, err := pool.Exec(ctx, `
			UPDATE objects
			SET json = jsonb_set(
				jsonb_set(json, '{bucket}', to_jsonb($2::text), true),
				'{size_bytes}', to_jsonb($3::bigint), true
			)
			WHERE object_id = $1
		`, objectID, storageClient.Bucket(), len(body)); err != nil {
			t.Fatalf("set live object storage bucket: %v", err)
		}
		if _, err := pool.Exec(ctx, `
			INSERT INTO storage_deletion_outbox (bucket, path, object_id)
			VALUES ($1, $2, $3)
		`, storageClient.Bucket(), path, objectID); err != nil {
			t.Fatalf("queue live storage path: %v", err)
		}

		deleted, err := NewObjectActions(pool, storageClient).ReconcileStorageDeletions(ctx, storageRecoveryReconcileBatchLimit)
		if err != nil {
			t.Fatalf("reconcile live storage path: %v", err)
		}
		if deleted != 0 {
			t.Fatalf("live-path reconciliation deleted %d blobs, want 0", deleted)
		}
		assertStorageBody(ctx, t, storageClient, objectID, path, body)
		var queued bool
		if err := pool.QueryRow(ctx, `
			SELECT EXISTS (
				SELECT 1 FROM storage_deletion_outbox
				WHERE bucket = $1 AND path = $2
			)
		`, storageClient.Bucket(), path).Scan(&queued); err != nil {
			t.Fatalf("query live storage deletion state: %v", err)
		}
		if queued {
			t.Fatal("live storage path remained queued for deletion")
		}
	})
}

func TestRealStorageFailedUploadNeverCommitsMetadata(t *testing.T) {
	pool := openActionsTestPool(t)
	bucket := "atlas-recovery-" + strings.ReplaceAll(uuid.NewString(), "-", "")
	storageClient := newStorageRecoveryClient(t, bucket)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	objectID := newStorageRecoveryObjectID(t)
	defer cleanupObjectRaceTestRowsWithTimeout(t, pool, objectID)
	_, err := NewObjectActions(pool, storageClient).Upload(
		ctx, objectID, strings.NewReader("unavailable storage"), int64(len("unavailable storage")), "text/plain", "data", nil,
	)
	if err == nil {
		t.Fatal("upload to a missing isolated bucket succeeded")
	}
	var missingBucket *storage.BucketNotFoundError
	if !errors.As(err, &missingBucket) || missingBucket.Bucket != bucket {
		t.Fatalf("missing-bucket upload error = %v, want BucketNotFoundError for %q", err, bucket)
	}
	var objectExists, intentExists, retryQueued bool
	if err := pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM objects WHERE object_id = $1)`, objectID).Scan(&objectExists); err != nil {
		t.Fatalf("query failed upload metadata: %v", err)
	}
	if err := pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM storage_upload_intents WHERE object_id = $1)`, objectID).Scan(&intentExists); err != nil {
		t.Fatalf("query failed upload intent: %v", err)
	}
	if err := pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM storage_deletion_outbox WHERE object_id = $1)`, objectID).Scan(&retryQueued); err != nil {
		t.Fatalf("query failed upload deletion retry: %v", err)
	}
	if objectExists || intentExists || !retryQueued {
		t.Fatalf("failed upload state = object:%t intent:%t retry:%t, want false/false/true", objectExists, intentExists, retryQueued)
	}

	if err := storageClient.EnsureBucket(ctx); err != nil {
		t.Fatalf("restore isolated storage bucket: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cleanupCancel()
		if err := storageClient.EmptyBucket(cleanupCtx); err != nil {
			t.Errorf("empty restored storage recovery bucket %q: %v", bucket, err)
		}
	})
	if _, err := pool.Exec(ctx, `
		UPDATE storage_deletion_outbox
		SET next_attempt_at = clock_timestamp()
		WHERE object_id = $1
	`, objectID); err != nil {
		t.Fatalf("make failed upload cleanup due: %v", err)
	}
	deleted, err := NewObjectActions(pool, storageClient).ReconcileStorageDeletions(ctx, storageRecoveryReconcileBatchLimit)
	if err != nil {
		t.Fatalf("reconcile failed upload after storage recovery: %v", err)
	}
	if deleted != 1 {
		t.Fatalf("failed upload reconciliation deleted %d paths, want 1", deleted)
	}
	var path string
	if err := pool.QueryRow(ctx, `
		SELECT path FROM storage_deletion_outbox
		WHERE object_id = $1 AND next_attempt_at = 'infinity'::timestamptz
	`, objectID).Scan(&path); err != nil {
		t.Fatalf("query failed upload permanent path fence: %v", err)
	}
	assertStorageObjectMissing(ctx, t, storageClient, objectID, path)
}

type crashAfterRealUploadStorage struct {
	*storage.Client
}

func (s *crashAfterRealUploadStorage) UploadObjectFromReaderToPath(
	ctx context.Context, objectID, path string, reader io.Reader, size int64, contentType string,
) (*storage.ObjectInfo, error) {
	info, err := s.Client.UploadObjectFromReaderToPath(ctx, objectID, path, reader, size, contentType)
	if err != nil {
		return nil, err
	}
	os.Exit(storageRecoveryCrashExitCode)
	return info, nil
}

type failNextDeleteStorage struct {
	objectStorage
	mu        sync.Mutex
	err       error
	remaining int
}

func (s *failNextDeleteStorage) DeleteObjectPath(ctx context.Context, bucket, path string) error {
	s.mu.Lock()
	if s.remaining > 0 {
		s.remaining--
		err := s.err
		s.mu.Unlock()
		return err
	}
	s.mu.Unlock()
	return s.objectStorage.DeleteObjectPath(ctx, bucket, path)
}

func uploadStorageFixture(ctx context.Context, t testing.TB, client *storage.Client, objectID, path string, body []byte) {
	t.Helper()
	if _, err := client.UploadObjectFromReaderToPath(ctx, objectID, path, bytes.NewReader(body), int64(len(body)), "text/plain"); err != nil {
		t.Fatalf("upload storage fixture: %v", err)
	}
}

func assertStorageBody(ctx context.Context, t testing.TB, client *storage.Client, objectID, path string, want []byte) {
	t.Helper()
	reader, info, err := client.StreamObjectPath(ctx, objectID, client.Bucket(), path)
	if err != nil {
		t.Fatalf("read storage object %q: %v", path, err)
	}
	defer func() {
		if err := reader.Close(); err != nil {
			t.Errorf("close storage object %q: %v", path, err)
		}
	}()
	got, err := io.ReadAll(reader)
	if err != nil {
		t.Fatalf("read storage object body %q: %v", path, err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("storage object %q body = %q, want %q", path, got, want)
	}
	if info.Bucket != client.Bucket() || info.Path != path || info.SizeBytes != int64(len(want)) {
		t.Fatalf("storage object info = %#v, want bucket %q path %q size %d", info, client.Bucket(), path, len(want))
	}
}

func assertStorageObjectMissing(ctx context.Context, t testing.TB, client *storage.Client, objectID, path string) {
	t.Helper()
	reader, _, err := client.StreamObjectPath(ctx, objectID, client.Bucket(), path)
	if reader != nil {
		_ = reader.Close()
	}
	var missing *storage.ObjectNotFoundError
	if !errors.As(err, &missing) {
		t.Fatalf("storage object %q error = %v, want ObjectNotFoundError", path, err)
	}
}

func assertPermanentStorageFence(ctx context.Context, t testing.TB, pool interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}, bucket, path string) {
	t.Helper()
	var fenced bool
	if err := pool.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM storage_deletion_outbox
			WHERE bucket = $1 AND path = $2
				AND next_attempt_at = 'infinity'::timestamptz
		)
	`, bucket, path).Scan(&fenced); err != nil {
		t.Fatalf("query permanent storage path fence: %v", err)
	}
	if !fenced {
		t.Fatalf("storage path %q has no permanent deletion fence", path)
	}
}
