package actions

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/the-drunken-coder/atlas/services/core/internal/storage"
)

const storageUploadCrashHelperEnv = "ATLAS_STORAGE_UPLOAD_CRASH_HELPER"

const storageUploadCrashFileName = "crash-blob"

func storageUploadCrashRoot() string {
	pid := os.Getpid()
	if os.Getenv(storageUploadCrashHelperEnv) == "1" {
		pid = os.Getppid()
	}
	return filepath.Join(os.TempDir(), fmt.Sprintf("atlas-storage-upload-crash-%d", pid))
}

func storageUploadCrashFilePath() string {
	return filepath.Join(storageUploadCrashRoot(), storageUploadCrashFileName)
}

func TestUploadCrashLeavesRecoverableIntentForNewAndReplacementBlobs(t *testing.T) {
	pool := openActionsTestPool(t)
	root := storageUploadCrashRoot()
	if err := os.RemoveAll(root); err != nil {
		t.Fatalf("clear crash storage root: %v", err)
	}
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatalf("create crash storage root: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })

	for _, replacement := range []bool{false, true} {
		name := "new"
		if replacement {
			name = "replacement"
		}
		t.Run(name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			objectID := fmt.Sprintf("crash-%s-%d", name, time.Now().UTC().UnixNano())
			newPath := crashStoragePath(objectID)
			oldPath := fmt.Sprintf("objects/%s/old", objectID)
			defer cleanupObjectRaceTestRowsWithTimeout(t, pool, objectID)

			if replacement {
				createStoredObjectFixture(ctx, t, pool, objectID, oldPath)
			}

			// #nosec G204 G702 -- os.Args[0] is the current test binary, not external input.
			cmd := exec.Command(os.Args[0], "-test.run=^TestStorageUploadCrashHelper$")
			cmd.Env = append(os.Environ(),
				storageUploadCrashHelperEnv+"=1",
				"ATLAS_STORAGE_UPLOAD_CRASH_OBJECT_ID="+objectID,
			)
			output, err := cmd.CombinedOutput()
			var exitErr *exec.ExitError
			if !errors.As(err, &exitErr) || exitErr.ExitCode() != 86 {
				t.Fatalf("crash helper error = %v, output = %s", err, output)
			}
			if _, err := os.Stat(storageUploadCrashFilePath()); err != nil {
				t.Fatalf("crashed upload blob missing: %v", err)
			}

			var intentCount int
			if err := pool.QueryRow(ctx, `SELECT count(*) FROM storage_upload_intents WHERE object_id = $1 AND path = $2`, objectID, newPath).Scan(&intentCount); err != nil {
				t.Fatalf("query crashed upload intent: %v", err)
			}
			if intentCount != 1 {
				t.Fatalf("upload intents = %d, want 1", intentCount)
			}
			var currentPath *string
			if err := pool.QueryRow(ctx, `SELECT path FROM objects WHERE object_id = $1`, objectID).Scan(&currentPath); err != nil {
				if replacement || !errors.Is(err, pgx.ErrNoRows) {
					t.Fatalf("query object after crash: %v", err)
				}
			} else if !replacement || currentPath == nil || *currentPath != oldPath {
				t.Fatalf("object path after crash = %v, want unchanged %q", currentPath, oldPath)
			}

			if _, err := pool.Exec(ctx, `UPDATE storage_upload_intents SET expires_at = clock_timestamp() - interval '1 second' WHERE path = $1`, newPath); err != nil {
				t.Fatalf("expire upload intent: %v", err)
			}
			filesystem := &crashFileObjectStorage{}
			if deleted, err := NewObjectActions(pool, filesystem).ReconcileStorageDeletions(ctx, 10); err != nil {
				t.Fatalf("mark orphaned upload intent: %v", err)
			} else if deleted != 0 {
				t.Fatalf("first recovery deleted %d blobs before the orphan grace elapsed", deleted)
			}
			if _, err := os.Stat(storageUploadCrashFilePath()); err != nil {
				t.Fatalf("first recovery removed blob before grace: %v", err)
			}
			if _, err := pool.Exec(ctx, `UPDATE storage_upload_intents SET orphaned_at = clock_timestamp() - interval '6 minutes' WHERE path = $1`, newPath); err != nil {
				t.Fatalf("age orphaned upload intent: %v", err)
			}
			if deleted, err := NewObjectActions(pool, filesystem).ReconcileStorageDeletions(ctx, 10); err != nil {
				t.Fatalf("recover orphaned upload intent: %v", err)
			} else if deleted != 1 {
				t.Fatalf("second recovery deleted %d blobs, want 1", deleted)
			}
			if _, err := os.Stat(storageUploadCrashFilePath()); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("orphaned blob still exists or stat failed: %v", err)
			}
		})
	}
}

func TestStorageUploadCrashHelper(t *testing.T) {
	if os.Getenv(storageUploadCrashHelperEnv) != "1" {
		return
	}
	pool := openActionsTestPool(t)
	objectID := os.Getenv("ATLAS_STORAGE_UPLOAD_CRASH_OBJECT_ID")
	_, _ = NewObjectActions(pool, &crashFileObjectStorage{crashAfterWrite: true}).Upload(
		context.Background(), objectID, strings.NewReader("crash"), 5, "text/plain", "data", nil,
	)
	t.Fatal("upload returned instead of crashing")
}

func TestUploadHeartbeatOwnershipLossCancelsBeforeMetadataCommit(t *testing.T) {
	pool := openActionsTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	objectID := fmt.Sprintf("heartbeat-loss-%d", time.Now().UTC().UnixNano())
	defer cleanupObjectRaceTestRowsWithTimeout(t, pool, objectID)
	storageClient := newCancelAwareObjectStorage()
	storageClient.bucket = "atlas-upload-captured"
	actions := NewObjectActions(pool, storageClient)
	actions.uploadHeartbeatPeriod = 10 * time.Millisecond

	uploadErr := make(chan error, 1)
	go func() {
		_, err := actions.Upload(ctx, objectID, strings.NewReader("blocked"), 7, "text/plain", "data", nil)
		uploadErr <- err
	}()
	uploadPath := storageClient.waitForUploadStart(t)
	if _, err := pool.Exec(ctx, `
		UPDATE storage_upload_intents
		SET orphaned_at = clock_timestamp()
		WHERE object_id = $1 AND path = $2
	`, objectID, uploadPath); err != nil {
		t.Fatalf("mark upload intent orphaned: %v", err)
	}

	select {
	case err := <-uploadErr:
		if err == nil || !strings.Contains(err.Error(), "ownership was lost") {
			t.Fatalf("upload error = %v, want lost ownership", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("upload was not canceled after heartbeat ownership loss")
	}
	var rowExists bool
	if err := pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM objects WHERE object_id = $1)`, objectID).Scan(&rowExists); err != nil {
		t.Fatalf("query object after heartbeat failure: %v", err)
	}
	if rowExists {
		t.Fatal("upload metadata committed after heartbeat ownership loss")
	}
	if !storageClient.deletedPath(uploadPath) {
		t.Fatalf("canceled upload path %q was not cleaned", uploadPath)
	}
	if len(storageClient.deletedObjects) != 1 || storageClient.deletedObjects[0] != (recordedStorageDelete{bucket: "atlas-upload-captured", path: uploadPath}) {
		t.Fatalf("canceled upload cleanup = %#v, want atlas-upload-captured/%q", storageClient.deletedObjects, uploadPath)
	}
}

func TestUploadHeartbeatRetriesTransientRenewalFailure(t *testing.T) {
	pool := openActionsTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	objectID := fmt.Sprintf("heartbeat-retry-%d", time.Now().UTC().UnixNano())
	path := fmt.Sprintf("objects/%s/blob", objectID)
	ownerID := uuid.NewString()
	defer cleanupObjectRaceTestRowsWithTimeout(t, pool, objectID)

	var originalExpiry time.Time
	if err := pool.QueryRow(ctx, `
		INSERT INTO storage_upload_intents (bucket, path, object_id, owner_id, expires_at)
		VALUES ('atlas-media', $1, $2, $3, clock_timestamp() + interval '5 minutes')
		RETURNING expires_at
	`, path, objectID, ownerID).Scan(&originalExpiry); err != nil {
		t.Fatalf("insert upload intent: %v", err)
	}

	suffix := strings.ReplaceAll(uuid.NewString(), "-", "")
	sequenceName := "heartbeat_retry_sequence_" + suffix
	functionName := "heartbeat_retry_function_" + suffix
	triggerName := "heartbeat_retry_trigger_" + suffix
	sequenceIdentifier := pgx.Identifier{sequenceName}.Sanitize()
	functionIdentifier := pgx.Identifier{functionName}.Sanitize()
	triggerIdentifier := pgx.Identifier{triggerName}.Sanitize()
	if _, err := pool.Exec(ctx, "CREATE SEQUENCE "+sequenceIdentifier); err != nil {
		t.Fatalf("create heartbeat retry sequence: %v", err)
	}
	if _, err := pool.Exec(ctx, `CREATE FUNCTION `+functionIdentifier+`() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN
			IF nextval('`+sequenceName+`') = 1 THEN
				RAISE EXCEPTION 'forced transient heartbeat failure';
			END IF;
			RETURN NEW;
		END
	$$`); err != nil {
		t.Fatalf("create heartbeat retry function: %v", err)
	}
	if _, err := pool.Exec(ctx, `CREATE TRIGGER `+triggerIdentifier+`
		BEFORE UPDATE ON storage_upload_intents
		FOR EACH ROW WHEN (NEW.path = '`+strings.ReplaceAll(path, "'", "''")+`')
		EXECUTE FUNCTION `+functionIdentifier+`()`); err != nil {
		t.Fatalf("create heartbeat retry trigger: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_, _ = pool.Exec(cleanupCtx, "DROP TRIGGER IF EXISTS "+triggerIdentifier+" ON storage_upload_intents")
		_, _ = pool.Exec(cleanupCtx, "DROP FUNCTION IF EXISTS "+functionIdentifier+"()")
		_, _ = pool.Exec(cleanupCtx, "DROP SEQUENCE IF EXISTS "+sequenceIdentifier)
	})

	heartbeatCtx, stopHeartbeat := context.WithCancel(ctx)
	failure := make(chan error, 1)
	done := make(chan struct{})
	go func() {
		defer close(done)
		NewObjectActions(pool, nil).runStorageUploadHeartbeat(
			heartbeatCtx, "atlas-media", path, ownerID, 10*time.Millisecond,
			func(err error) { failure <- err },
		)
	}()

	deadline := time.Now().Add(5 * time.Second)
	for {
		var attempts int64
		var sequenceCalled bool
		var renewed bool
		if err := pool.QueryRow(ctx, `SELECT last_value, is_called FROM `+sequenceIdentifier).Scan(&attempts, &sequenceCalled); err != nil {
			t.Fatalf("read heartbeat retry attempts: %v", err)
		}
		if err := pool.QueryRow(ctx, `
			SELECT expires_at > $2
			FROM storage_upload_intents WHERE bucket = 'atlas-media' AND path = $1
		`, path, originalExpiry).Scan(&renewed); err != nil {
			t.Fatalf("check renewed upload intent: %v", err)
		}
		if sequenceCalled && attempts >= 2 && renewed {
			break
		}
		select {
		case err := <-failure:
			t.Fatalf("heartbeat stopped after transient renewal failure: %v", err)
		default:
		}
		if time.Now().After(deadline) {
			t.Fatal("heartbeat did not retry and renew the upload intent")
		}
		time.Sleep(10 * time.Millisecond)
	}

	stopHeartbeat()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("heartbeat did not stop")
	}
	select {
	case err := <-failure:
		t.Fatalf("heartbeat reported a transient renewal failure: %v", err)
	default:
	}
}

type crashFileObjectStorage struct {
	noopObjectStorage
	crashAfterWrite bool
}

type cancelAwareObjectStorage struct {
	noopObjectStorage
	bucket         string
	uploadStarted  chan string
	mu             sync.Mutex
	deletedPaths   []string
	deletedObjects []recordedStorageDelete
}

var (
	_ objectStorage = (*crashFileObjectStorage)(nil)
	_ objectStorage = (*cancelAwareObjectStorage)(nil)
)

func newCancelAwareObjectStorage() *cancelAwareObjectStorage {
	return &cancelAwareObjectStorage{uploadStarted: make(chan string, 1)}
}

func (s *cancelAwareObjectStorage) Bucket() string {
	if s.bucket != "" {
		return s.bucket
	}
	return s.noopObjectStorage.Bucket()
}

func (s *cancelAwareObjectStorage) NewObjectPath(objectID string) string {
	return fmt.Sprintf("objects/%s/heartbeat-blob", objectID)
}

func (s *cancelAwareObjectStorage) UploadObjectFromReaderToPath(
	ctx context.Context, _ string, path string, _ io.Reader, _ int64, _ string,
) (*storage.ObjectInfo, error) {
	s.uploadStarted <- path
	<-ctx.Done()
	return nil, ctx.Err()
}

func (s *cancelAwareObjectStorage) DeleteObjectPath(_ context.Context, bucket, path string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.deletedPaths = append(s.deletedPaths, path)
	s.deletedObjects = append(s.deletedObjects, recordedStorageDelete{bucket: bucket, path: path})
	return nil
}

func (s *cancelAwareObjectStorage) waitForUploadStart(t *testing.T) string {
	t.Helper()
	select {
	case path := <-s.uploadStarted:
		return path
	case <-time.After(5 * time.Second):
		t.Fatal("storage upload did not start")
		return ""
	}
}

func (s *cancelAwareObjectStorage) deletedPath(path string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, deleted := range s.deletedPaths {
		if deleted == path {
			return true
		}
	}
	return false
}

func crashStoragePath(objectID string) string { return fmt.Sprintf("objects/%s/crash-blob", objectID) }

func (s *crashFileObjectStorage) NewObjectPath(objectID string) string {
	return crashStoragePath(objectID)
}

func (s *crashFileObjectStorage) UploadObjectFromReaderToPath(
	_ context.Context, objectID, path string, reader io.Reader, size int64, contentType string,
) (*storage.ObjectInfo, error) {
	file, err := os.Create(storageUploadCrashFilePath())
	if err != nil {
		return nil, err
	}
	if _, err := io.Copy(file, reader); err != nil {
		_ = file.Close()
		return nil, err
	}
	if err := file.Close(); err != nil {
		return nil, err
	}
	if s.crashAfterWrite {
		os.Exit(86)
	}
	return &storage.ObjectInfo{ObjectID: objectID, Bucket: s.Bucket(), Path: path, SizeBytes: size, ContentType: contentType}, nil
}

func (s *crashFileObjectStorage) DeleteObjectPath(_ context.Context, _, _ string) error {
	err := os.Remove(storageUploadCrashFilePath())
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

func TestReconcileStorageUploadIntentDeletesUnreferencedBlob(t *testing.T) {
	pool := openActionsTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	objectID := fmt.Sprintf("orphan-upload-%d", time.Now().UTC().UnixNano())
	path := fmt.Sprintf("objects/%s/blob", objectID)
	defer cleanupObjectRaceTestRowsWithTimeout(t, pool, objectID)

	if _, err := pool.Exec(ctx, `
		INSERT INTO storage_upload_intents
			(bucket, path, object_id, owner_id, expires_at, orphaned_at)
		VALUES ('atlas-media', $1, $2, $3, clock_timestamp() - interval '11 minutes', clock_timestamp() - interval '6 minutes')
	`, path, objectID, uuid.NewString()); err != nil {
		t.Fatalf("insert orphaned upload intent: %v", err)
	}

	storageClient := &recordingObjectStorage{}
	actions := NewObjectActions(pool, storageClient)
	deleted, err := actions.ReconcileStorageDeletions(ctx, 10)
	if err != nil {
		t.Fatalf("ReconcileStorageDeletions: %v", err)
	}
	if deleted != 1 || len(storageClient.deletedPaths) != 1 || storageClient.deletedPaths[0] != path {
		t.Fatalf("reconciliation deleted=%d paths=%#v, want %q", deleted, storageClient.deletedPaths, path)
	}

	var intentExists, pathTombstoned bool
	if err := pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM storage_upload_intents WHERE path = $1)`, path).Scan(&intentExists); err != nil {
		t.Fatalf("check upload intent: %v", err)
	}
	if err := pool.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM storage_deletion_outbox
			WHERE path = $1 AND next_attempt_at = 'infinity'::timestamptz
		)
	`, path).Scan(&pathTombstoned); err != nil {
		t.Fatalf("check deletion outbox: %v", err)
	}
	if intentExists || !pathTombstoned {
		t.Fatalf("recovery state = intent:%t path-tombstone:%t, want false/true", intentExists, pathTombstoned)
	}
}

func TestReconcileStorageUploadIntentRejectsLivePathWithoutBucket(t *testing.T) {
	pool := openActionsTestPool(t)
	for _, tt := range []struct {
		name     string
		metadata string
	}{
		{name: "missing", metadata: `{"size_bytes":3}`},
		{name: "blank", metadata: `{"bucket":" ","size_bytes":3}`},
	} {
		t.Run(tt.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			objectID := fmt.Sprintf("invalid-live-upload-%s-%d", tt.name, time.Now().UTC().UnixNano())
			path := fmt.Sprintf("objects/%s/blob", objectID)
			defer cleanupObjectRaceTestRowsWithTimeout(t, pool, objectID)

			createStoredObjectFixture(ctx, t, pool, objectID, path)
			if _, err := pool.Exec(ctx, `UPDATE objects SET json = $2::jsonb WHERE object_id = $1`, objectID, tt.metadata); err != nil {
				t.Fatalf("set invalid bucket metadata: %v", err)
			}
			if _, err := pool.Exec(ctx, `
				INSERT INTO storage_upload_intents
					(bucket, path, object_id, owner_id, expires_at, orphaned_at)
				VALUES ('atlas-media', $1, $2, $3, clock_timestamp() - interval '11 minutes', clock_timestamp() - interval '6 minutes')
			`, path, objectID, uuid.NewString()); err != nil {
				t.Fatalf("insert stale upload intent: %v", err)
			}

			storageClient := &recordingObjectStorage{}
			deleted, err := NewObjectActions(pool, storageClient).ReconcileStorageDeletions(ctx, 10)
			if err == nil || !strings.Contains(err.Error(), "missing bucket metadata") {
				t.Fatalf("ReconcileStorageDeletions error = %v, want missing bucket metadata", err)
			}
			if deleted != 0 || len(storageClient.deletedObjects) != 0 {
				t.Fatalf("reconciliation deleted=%d objects=%#v, want none", deleted, storageClient.deletedObjects)
			}

			var intentExists bool
			if err := pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM storage_upload_intents WHERE path = $1)`, path).Scan(&intentExists); err != nil {
				t.Fatalf("check upload intent: %v", err)
			}
			if !intentExists {
				t.Fatal("invalid live path upload intent was cleared")
			}
		})
	}
}

func TestRecoverStorageUploadIntentLocksAdvisoryBeforeIntentRow(t *testing.T) {
	pool := openActionsTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	objectID := fmt.Sprintf("intent-lock-order-%d", time.Now().UTC().UnixNano())
	path := fmt.Sprintf("objects/%s/blob", objectID)
	defer cleanupObjectRaceTestRowsWithTimeout(t, pool, objectID)
	if _, err := pool.Exec(ctx, `
		INSERT INTO storage_upload_intents
			(bucket, path, object_id, owner_id, expires_at, orphaned_at)
		VALUES ('atlas-media', $1, $2, $3, clock_timestamp() - interval '11 minutes', clock_timestamp() - interval '6 minutes')
	`, path, objectID, uuid.NewString()); err != nil {
		t.Fatalf("insert orphaned upload intent: %v", err)
	}

	blocker, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin advisory blocker: %v", err)
	}
	defer func() { _ = blocker.Rollback(context.Background()) }()
	if _, err := blocker.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1))`, objectUploadLockKey(objectID)); err != nil {
		t.Fatalf("lock object advisory key: %v", err)
	}
	var blockerPID int32
	if err := blocker.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&blockerPID); err != nil {
		t.Fatalf("read advisory blocker pid: %v", err)
	}

	type result struct {
		recovered int
		err       error
	}
	done := make(chan result, 1)
	go func() {
		recovered, err := NewObjectActions(pool, nil).recoverStorageUploadIntents(ctx, 1)
		done <- result{recovered: recovered, err: err}
	}()
	deadline := time.Now().Add(5 * time.Second)
	for {
		var blocked bool
		if err := pool.QueryRow(ctx, `
			SELECT EXISTS (
				SELECT 1 FROM pg_stat_activity
				WHERE $1 = ANY(pg_blocking_pids(pid))
					AND wait_event_type = 'Lock'
					AND query ILIKE '%pg_advisory_xact_lock%'
			)
		`, blockerPID).Scan(&blocked); err != nil {
			t.Fatalf("check advisory waiter: %v", err)
		}
		if blocked {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("upload intent recovery did not wait on the advisory lock")
		}
		time.Sleep(10 * time.Millisecond)
	}

	checker, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin intent row checker: %v", err)
	}
	var one int
	if err := checker.QueryRow(ctx, `SELECT 1 FROM storage_upload_intents WHERE path = $1 FOR UPDATE NOWAIT`, path).Scan(&one); err != nil {
		_ = checker.Rollback(ctx)
		t.Fatalf("recovery locked the intent row before the advisory lock: %v", err)
	}
	if err := checker.Rollback(ctx); err != nil {
		t.Fatalf("release intent row checker: %v", err)
	}
	if err := blocker.Rollback(ctx); err != nil {
		t.Fatalf("release advisory lock: %v", err)
	}
	select {
	case result := <-done:
		if result.err != nil || result.recovered != 1 {
			t.Fatalf("recovery result = (%d, %v), want (1, nil)", result.recovered, result.err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("upload intent recovery did not finish after advisory release")
	}
}

func TestReconcileStorageUploadIntentPreservesLiveBlob(t *testing.T) {
	pool := openActionsTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	objectID := fmt.Sprintf("live-upload-%d", time.Now().UTC().UnixNano())
	path := fmt.Sprintf("objects/%s/blob", objectID)
	defer cleanupObjectRaceTestRowsWithTimeout(t, pool, objectID)

	createStoredObjectFixture(ctx, t, pool, objectID, path)
	if _, err := pool.Exec(ctx, `
		INSERT INTO storage_upload_intents
			(bucket, path, object_id, owner_id, expires_at, orphaned_at)
		VALUES ('atlas-media', $1, $2, $3, clock_timestamp() - interval '11 minutes', clock_timestamp() - interval '6 minutes')
	`, path, objectID, uuid.NewString()); err != nil {
		t.Fatalf("insert stale upload intent: %v", err)
	}

	storageClient := &recordingObjectStorage{}
	if _, err := NewObjectActions(pool, storageClient).ReconcileStorageDeletions(ctx, 10); err != nil {
		t.Fatalf("ReconcileStorageDeletions: %v", err)
	}
	if len(storageClient.deletedPaths) != 0 {
		t.Fatalf("deleted live paths: %#v", storageClient.deletedPaths)
	}

	var intentExists, outboxExists bool
	if err := pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM storage_upload_intents WHERE path = $1)`, path).Scan(&intentExists); err != nil {
		t.Fatalf("check upload intent: %v", err)
	}
	if err := pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM storage_deletion_outbox WHERE path = $1)`, path).Scan(&outboxExists); err != nil {
		t.Fatalf("check deletion outbox: %v", err)
	}
	if intentExists || outboxExists {
		t.Fatalf("live path recovery left rows: intent=%t outbox=%t", intentExists, outboxExists)
	}
}

func TestReconcileStorageUploadIntentLeavesActiveLease(t *testing.T) {
	pool := openActionsTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	objectID := fmt.Sprintf("active-upload-%d", time.Now().UTC().UnixNano())
	path := fmt.Sprintf("objects/%s/blob", objectID)
	defer cleanupObjectRaceTestRowsWithTimeout(t, pool, objectID)

	if _, err := pool.Exec(ctx, `
		INSERT INTO storage_upload_intents (bucket, path, object_id, owner_id, expires_at)
		VALUES ('atlas-media', $1, $2, $3, clock_timestamp() + interval '5 minutes')
	`, path, objectID, uuid.NewString()); err != nil {
		t.Fatalf("insert active upload intent: %v", err)
	}

	storageClient := &recordingObjectStorage{}
	if _, err := NewObjectActions(pool, storageClient).ReconcileStorageDeletions(ctx, 10); err != nil {
		t.Fatalf("ReconcileStorageDeletions: %v", err)
	}
	if len(storageClient.deletedPaths) != 0 {
		t.Fatalf("active upload path was deleted: %#v", storageClient.deletedPaths)
	}
	var active bool
	if err := pool.QueryRow(ctx, `
		SELECT orphaned_at IS NULL AND expires_at > clock_timestamp()
		FROM storage_upload_intents WHERE path = $1
	`, path).Scan(&active); err != nil {
		t.Fatalf("check active upload intent: %v", err)
	}
	if !active {
		t.Fatal("active upload intent was changed by reconciliation")
	}
}

func TestUploadDoesNotResurrectObjectCreatedAndDeletedAfterMissingPreflight(t *testing.T) {
	pool := openActionsTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	storageClient := newBlockingObjectStorage()
	defer storageClient.releaseUpload()
	actions := NewObjectActions(pool, storageClient)

	objectID := fmt.Sprintf("missing-race-%d", time.Now().UTC().UnixNano())
	initialPath := fmt.Sprintf("objects/%s/initial", objectID)
	contentType := "text/plain"
	sizeBytes := int64(3)
	defer cleanupObjectRaceTestRowsWithTimeout(t, pool, objectID)

	uploadErr := make(chan error, 1)
	go func() {
		_, err := actions.Upload(ctx, objectID, strings.NewReader("new"), sizeBytes, contentType, "data", nil)
		uploadErr <- err
	}()
	uploadedPath := storageClient.waitForUploadStart(t)

	createStoredObjectFixture(ctx, t, pool, objectID, initialPath)
	if err := actions.Delete(ctx, objectID); err != nil {
		t.Fatalf("delete object after missing preflight: %v", err)
	}
	storageClient.releaseUpload()

	select {
	case err := <-uploadErr:
		var notFound *NotFoundError
		if !errors.As(err, &notFound) {
			t.Fatalf("upload error = %v, want object not found", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("upload did not finish")
	}

	var rowExists bool
	if err := pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM objects WHERE object_id = $1)`, objectID).Scan(&rowExists); err != nil {
		t.Fatalf("check object row: %v", err)
	}
	if rowExists {
		t.Fatal("missing-row upload resurrected a concurrently deleted object")
	}
	if !storageClient.deletedPath(uploadedPath) {
		t.Fatalf("failed upload path %q was not cleaned", uploadedPath)
	}
}
