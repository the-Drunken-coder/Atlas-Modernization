package actions

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/storage"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/testenv"
	protocol "github.com/the-drunken-coder/atlas/atlas_protocol/generated/go/atlasprotocol"
)

func TestNormalizeOptionalObjectString(t *testing.T) {
	tests := []struct {
		name  string
		value *string
		want  *string
	}{
		{name: "nil remains nil"},
		{name: "empty becomes nil", value: ptrString("")},
		{name: "whitespace becomes nil", value: ptrString(" \t\n ")},
		{name: "trimmed value", value: ptrString("  photo  "), want: ptrString("photo")},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := normalizeOptionalObjectString(tt.value)
			if tt.want == nil {
				if got != nil {
					t.Fatalf("normalizeOptionalObjectString() = %q, want nil", *got)
				}
				return
			}
			if got == nil || *got != *tt.want {
				t.Fatalf("normalizeOptionalObjectString() = %v, want %q", got, *tt.want)
			}
		})
	}
}

func TestDecodeObjectJSONForPatchPreservesLargeIntegers(t *testing.T) {
	data, err := decodeObjectJSONForPatch(json.RawMessage(`{"size_bytes":9007199254740993,"extra":"patched"}`))
	if err != nil {
		t.Fatalf("decodeObjectJSONForPatch: %v", err)
	}

	size, ok := data["size_bytes"].(json.Number)
	if !ok {
		t.Fatalf("size_bytes type = %T, want json.Number", data["size_bytes"])
	}
	got, err := size.Int64()
	if err != nil {
		t.Fatalf("size_bytes Int64: %v", err)
	}
	if got != 9007199254740993 {
		t.Fatalf("size_bytes = %d, want exact large integer", got)
	}
}

func TestDecodeObjectJSONForPatchRejectsTrailingData(t *testing.T) {
	if _, err := decodeObjectJSONForPatch(json.RawMessage(`{"size_bytes":1024}{"extra":"bad"}`)); err == nil {
		t.Fatal("expected trailing data to fail")
	}
}

func createStoredObjectFixture(t *testing.T, ctx context.Context, pool *pgxpool.Pool, objectID, path string) int64 {
	t.Helper()
	object, err := NewObjectActions(pool, nil).Create(ctx, CreateObjectParams{ObjectID: objectID})
	if err != nil {
		t.Fatalf("create object fixture: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		UPDATE objects
		SET path = $2, content_type = 'text/plain', json = '{"bucket":"atlas-media","size_bytes":3}'::jsonb
		WHERE object_id = $1
	`, objectID, path); err != nil {
		t.Fatalf("attach storage metadata to object fixture: %v", err)
	}
	return object.Version
}

func TestCleanupUploadedPathAfterFailureDeletesUploadedObject(t *testing.T) {
	storageClient := &recordingObjectStorage{}
	actions := &ObjectActions{storage: storageClient}
	cause := errors.New("commit failed")

	err := actions.cleanupUploadedPathAfterFailure(context.Background(), "obj-1", "objects/obj-1/blob", cause)

	if !errors.Is(err, cause) {
		t.Fatalf("cleanupUploadedPathAfterFailure error = %v, want cause %v", err, cause)
	}
	if len(storageClient.deletedPaths) != 1 || storageClient.deletedPaths[0] != "objects/obj-1/blob" {
		t.Fatalf("deleted paths = %#v, want uploaded path", storageClient.deletedPaths)
	}
}

func TestCleanupUploadedPathAfterFailureReportsDeleteFailure(t *testing.T) {
	storageClient := &recordingObjectStorage{deleteErr: errors.New("delete failed")}
	actions := &ObjectActions{storage: storageClient}
	cause := errors.New("commit failed")

	err := actions.cleanupUploadedPathAfterFailure(context.Background(), "obj-1", "objects/obj-1/blob", cause)

	if !errors.Is(err, cause) || !errors.Is(err, storageClient.deleteErr) {
		t.Fatalf("cleanupUploadedPathAfterFailure error = %v, want cause and delete error", err)
	}
	if !strings.Contains(err.Error(), "objects/obj-1/blob") {
		t.Fatalf("cleanup error should include uploaded path, got %q", err.Error())
	}
}

func TestCleanupUploadedPathAfterFailureQueuesDeleteRetry(t *testing.T) {
	dbURL, explicitDBURL := actionsTestDatabaseURL()
	if dbURL == "" {
		testenv.SkipOrFatal(t, "set ATLAS_ACTIONS_DATABASE_URL, DATABASE_URL, or POSTGRES_PASSWORD to run DB-backed storage deletion outbox test")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		if explicitDBURL {
			t.Fatalf("connect test database: %v", err)
		}
		testenv.SkipOrFatal(t, "test database unavailable: %v", err)
	}
	defer pool.Close()
	if err := pool.Ping(ctx); err != nil {
		if explicitDBURL {
			t.Fatalf("ping test database: %v", err)
		}
		testenv.SkipOrFatal(t, "test database unavailable: %v", err)
	}
	if ok, err := actionsTestCoreSchemaPresent(ctx, pool); err != nil {
		t.Fatalf("check core schema: %v", err)
	} else if !ok {
		testenv.SkipOrFatal(t, "core schema with storage deletion outbox is not present in test database")
	}

	objectID := fmt.Sprintf("cleanup-retry-%d", time.Now().UTC().UnixNano())
	objectPath := fmt.Sprintf("objects/%s/blob", objectID)
	defer cleanupObjectRaceTestRowsWithTimeout(t, pool, objectID)

	storageClient := &recordingObjectStorage{deleteErr: errors.New("delete failed")}
	actions := NewObjectActions(pool, storageClient)
	cause := errors.New("commit failed")

	err = actions.cleanupUploadedPathAfterFailure(ctx, objectID, objectPath, cause)

	if !errors.Is(err, cause) || !errors.Is(err, storageClient.deleteErr) {
		t.Fatalf("cleanupUploadedPathAfterFailure error = %v, want cause and delete error", err)
	}
	if !strings.Contains(err.Error(), "queued storage deletion retry") {
		t.Fatalf("cleanup error should mention queued retry, got %q", err.Error())
	}

	var storedObjectID, lastError string
	var attempts int
	if err := pool.QueryRow(ctx, `
		SELECT object_id, attempts, last_error
		FROM storage_deletion_outbox
		WHERE bucket = 'atlas-media' AND path = $1
	`, objectPath).Scan(&storedObjectID, &attempts, &lastError); err != nil {
		t.Fatalf("query outbox row: %v", err)
	}
	if storedObjectID != objectID {
		t.Fatalf("queued object_id = %q, want %q", storedObjectID, objectID)
	}
	if attempts != 1 {
		t.Fatalf("queued attempts = %d, want 1", attempts)
	}
	if !strings.Contains(lastError, "delete failed") {
		t.Fatalf("queued last_error = %q, want delete failure", lastError)
	}
}

func TestObjectDeletePublishesChangeBeforeStorageCleanup(t *testing.T) {
	dbURL, explicitDBURL := actionsTestDatabaseURL()
	if dbURL == "" {
		testenv.SkipOrFatal(t, "set ATLAS_ACTIONS_DATABASE_URL, DATABASE_URL, or POSTGRES_PASSWORD to run DB-backed object delete ordering test")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		if explicitDBURL {
			t.Fatalf("connect test database: %v", err)
		}
		testenv.SkipOrFatal(t, "test database unavailable: %v", err)
	}
	defer pool.Close()
	if err := pool.Ping(ctx); err != nil {
		if explicitDBURL {
			t.Fatalf("ping test database: %v", err)
		}
		testenv.SkipOrFatal(t, "test database unavailable: %v", err)
	}
	if ok, err := actionsTestCoreSchemaPresent(ctx, pool); err != nil {
		t.Fatalf("check core schema: %v", err)
	} else if !ok {
		testenv.SkipOrFatal(t, "core schema with storage deletion outbox is not present in test database")
	}

	objectID := fmt.Sprintf("delete-publish-before-storage-%d", time.Now().UTC().UnixNano())
	objectPath := fmt.Sprintf("objects/%s/blob", objectID)
	defer cleanupObjectRaceTestRowsWithTimeout(t, pool, objectID)
	beforeVersion := createStoredObjectFixture(t, ctx, pool, objectID, objectPath)

	storageClient := newPausingDeleteObjectStorage()
	defer storageClient.releaseDelete()
	actions := NewObjectActions(pool, storageClient)
	deleteResult := make(chan error, 1)
	go func() {
		deleteResult <- actions.Delete(ctx, objectID)
	}()

	if got := storageClient.waitForDeleteStart(t); got != objectPath {
		t.Fatalf("storage delete path = %q, want %q", got, objectPath)
	}

	var payload []byte
	if err := pool.QueryRow(ctx, `
		SELECT event FROM atlas_change_events
		WHERE event->>'resource_type' = 'object' AND event->>'event' = 'delete' AND event->>'id' = $1
		ORDER BY version DESC LIMIT 1
	`, objectID).Scan(&payload); err != nil {
		t.Fatalf("query durable delete event while storage cleanup is blocked: %v", err)
	}
	var event protocol.FeedEvent
	if err := json.Unmarshal(payload, &event); err != nil {
		t.Fatalf("decode durable delete event: %v", err)
	}
	if event.Event != ChangeEventDelete || event.ResourceType != ChangeResourceObject || event.ID != objectID || event.Version <= beforeVersion {
		t.Fatalf("durable delete event = %#v, want object delete after version %d", event, beforeVersion)
	}

	storageClient.releaseDelete()
	select {
	case err := <-deleteResult:
		if err != nil {
			t.Fatalf("delete returned error: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("delete did not finish after storage cleanup was released")
	}
}

func TestObjectUploadLockKey(t *testing.T) {
	got := objectUploadLockKey("foo")
	want := "atlas-core-object-upload:foo"
	if got != want {
		t.Fatalf("objectUploadLockKey() = %q, want %q", got, want)
	}
}

func TestObjectDeletedAfterUploadPreflight(t *testing.T) {
	tests := []struct {
		name      string
		preflight objectUploadState
		current   objectUploadState
		want      bool
	}{
		{
			name:      "existing object deleted after preflight",
			preflight: objectUploadState{rowExists: true, maxDeletionVersion: 7},
			current:   objectUploadState{maxDeletionVersion: 8},
			want:      true,
		},
		{
			name:      "existing row disappearance is treated as deletion",
			preflight: objectUploadState{rowExists: true, maxDeletionVersion: 7},
			current:   objectUploadState{rowExists: false, maxDeletionVersion: 7},
			want:      true,
		},
		{
			name:      "missing object deleted after preflight",
			preflight: objectUploadState{rowExists: false, maxDeletionVersion: 7},
			current:   objectUploadState{maxDeletionVersion: 8},
			want:      true,
		},
		{
			name:      "new object create is allowed when prior tombstone was visible",
			preflight: objectUploadState{rowExists: false, maxDeletionVersion: 7},
			current:   objectUploadState{maxDeletionVersion: 7},
			want:      false,
		},
		{
			name:      "existing object unchanged",
			preflight: objectUploadState{rowExists: true, maxDeletionVersion: 7},
			current:   objectUploadState{rowExists: true, maxDeletionVersion: 7},
			want:      false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := objectDeletedAfterUploadPreflight(&tt.preflight, &tt.current)
			if got != tt.want {
				t.Fatalf("objectDeletedAfterUploadPreflight() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestStorageDeletionRetryDelay(t *testing.T) {
	tests := []struct {
		attempts int
		want     time.Duration
	}{
		{attempts: 0, want: time.Minute},
		{attempts: 1, want: time.Minute},
		{attempts: 2, want: 2 * time.Minute},
		{attempts: 3, want: 4 * time.Minute},
		{attempts: 99, want: 64 * time.Minute},
	}

	for _, tt := range tests {
		t.Run(fmt.Sprintf("attempts_%d", tt.attempts), func(t *testing.T) {
			if got := storageDeletionRetryDelay(tt.attempts); got != tt.want {
				t.Fatalf("storageDeletionRetryDelay(%d) = %s, want %s", tt.attempts, got, tt.want)
			}
		})
	}
}

func TestReconcileStorageDeletionsDeletesQueuedPath(t *testing.T) {
	dbURL, explicitDBURL := actionsTestDatabaseURL()
	if dbURL == "" {
		testenv.SkipOrFatal(t, "set ATLAS_ACTIONS_DATABASE_URL, DATABASE_URL, or POSTGRES_PASSWORD to run DB-backed storage deletion outbox test")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		if explicitDBURL {
			t.Fatalf("connect test database: %v", err)
		}
		testenv.SkipOrFatal(t, "test database unavailable: %v", err)
	}
	defer pool.Close()
	if err := pool.Ping(ctx); err != nil {
		if explicitDBURL {
			t.Fatalf("ping test database: %v", err)
		}
		testenv.SkipOrFatal(t, "test database unavailable: %v", err)
	}
	if ok, err := actionsTestCoreSchemaPresent(ctx, pool); err != nil {
		t.Fatalf("check core schema: %v", err)
	} else if !ok {
		testenv.SkipOrFatal(t, "core schema with storage deletion outbox is not present in test database")
	}

	objectID := fmt.Sprintf("outbox-%d", time.Now().UTC().UnixNano())
	path := fmt.Sprintf("objects/%s/blob", objectID)
	defer cleanupObjectRaceTestRowsWithTimeout(t, pool, objectID)

	if _, err := pool.Exec(ctx, `
		INSERT INTO storage_deletion_outbox (bucket, path, object_id)
		VALUES ('atlas-media', $1, $2)
	`, path, objectID); err != nil {
		t.Fatalf("insert outbox row: %v", err)
	}

	storageClient := &recordingObjectStorage{}
	actions := NewObjectActions(pool, storageClient)
	deleted, err := actions.ReconcileStorageDeletions(ctx, 10)
	if err != nil {
		t.Fatalf("ReconcileStorageDeletions: %v", err)
	}
	if deleted != 1 {
		t.Fatalf("deleted = %d, want 1", deleted)
	}
	if len(storageClient.deletedPaths) != 1 || storageClient.deletedPaths[0] != path {
		t.Fatalf("deleted paths = %#v, want %q", storageClient.deletedPaths, path)
	}

	var pathTombstoned bool
	if err := pool.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM storage_deletion_outbox
			WHERE bucket = 'atlas-media' AND path = $1
				AND next_attempt_at = 'infinity'::timestamptz
		)
	`, path).Scan(&pathTombstoned); err != nil {
		t.Fatalf("check outbox row: %v", err)
	}
	if !pathTombstoned {
		t.Fatal("successful reconciliation did not retain a path tombstone")
	}
}

func TestUploadDoesNotResurrectObjectDeletedDuringBlobWrite(t *testing.T) {
	dbURL, explicitDBURL := actionsTestDatabaseURL()
	if dbURL == "" {
		testenv.SkipOrFatal(t, "set ATLAS_ACTIONS_DATABASE_URL, DATABASE_URL, or POSTGRES_PASSWORD to run DB-backed object upload race test")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		if explicitDBURL {
			t.Fatalf("connect test database: %v", err)
		}
		testenv.SkipOrFatal(t, "test database unavailable: %v", err)
	}
	defer pool.Close()
	if err := pool.Ping(ctx); err != nil {
		if explicitDBURL {
			t.Fatalf("ping test database: %v", err)
		}
		testenv.SkipOrFatal(t, "test database unavailable: %v", err)
	}
	if ok, err := actionsTestCoreSchemaPresent(ctx, pool); err != nil {
		t.Fatalf("check core schema: %v", err)
	} else if !ok {
		testenv.SkipOrFatal(t, "core schema is not present in test database")
	}

	storageClient := newBlockingObjectStorage()
	defer storageClient.releaseUpload()
	actions := NewObjectActions(pool, storageClient)

	objectID := fmt.Sprintf("race-%d", time.Now().UTC().UnixNano())
	initialPath := fmt.Sprintf("objects/%s/initial", objectID)
	contentType := "text/plain"
	sizeBytes := int64(3)
	defer cleanupObjectRaceTestRowsWithTimeout(t, pool, objectID)

	createStoredObjectFixture(t, ctx, pool, objectID, initialPath)

	uploadErr := make(chan error, 1)
	go func() {
		_, err := actions.Upload(ctx, objectID, strings.NewReader("new"), sizeBytes, contentType, "data", nil)
		uploadErr <- err
	}()

	uploadedPath := storageClient.waitForUploadStart(t)

	deleteCtx, deleteCancel := context.WithTimeout(ctx, 2*time.Second)
	defer deleteCancel()
	if err := actions.Delete(deleteCtx, objectID); err != nil {
		t.Fatalf("delete while upload storage write is paused: %v", err)
	}

	storageClient.releaseUpload()

	select {
	case err := <-uploadErr:
		var notFound *NotFoundError
		if !errors.As(err, &notFound) {
			t.Fatalf("upload error = %v, want object not found after concurrent delete", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("upload did not finish after storage write was released")
	}

	var rowExists bool
	if err := pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM objects WHERE object_id = $1)`, objectID).Scan(&rowExists); err != nil {
		t.Fatalf("check object row: %v", err)
	}
	if rowExists {
		t.Fatal("object row was resurrected after delete won the upload race")
	}
	var deleteVersion int64
	if err := pool.QueryRow(ctx, `
		SELECT version FROM atlas_change_events
		WHERE event->>'resource_type' = 'object' AND event->>'event' = 'delete' AND event->>'id' = $1
		ORDER BY version DESC LIMIT 1
	`, objectID).Scan(&deleteVersion); err != nil {
		t.Fatalf("query object delete event: %v", err)
	}
	currentVersion, err := CurrentChangeVersion(ctx, pool)
	if err != nil {
		t.Fatalf("CurrentChangeVersion: %v", err)
	}
	if currentVersion < deleteVersion {
		t.Fatalf("CurrentChangeVersion = %d, want at least delete version %d", currentVersion, deleteVersion)
	}
	if !storageClient.deletedPath(initialPath) {
		t.Fatalf("delete did not remove initial path %q; deleted paths = %#v", initialPath, storageClient.deletedPathsSnapshot())
	}
	if !storageClient.deletedPath(uploadedPath) {
		t.Fatalf("failed upload did not clean uploaded path %q; deleted paths = %#v", uploadedPath, storageClient.deletedPathsSnapshot())
	}
}

func ptrString(value string) *string {
	return &value
}

type recordingObjectStorage struct {
	deletedPaths []string
	deleteErr    error
	pathCounter  atomic.Int64
}

func (s *recordingObjectStorage) Bucket() string {
	return "atlas-media"
}

func (s *recordingObjectStorage) DeleteObjectPath(_ context.Context, path string) error {
	s.deletedPaths = append(s.deletedPaths, path)
	return s.deleteErr
}

func (s *recordingObjectStorage) NewObjectPath(objectID string) string {
	return nextVersionedObjectPath(&s.pathCounter, objectID)
}

func (s *recordingObjectStorage) StreamObjectPath(context.Context, string, string) (io.ReadCloser, *storage.ObjectInfo, error) {
	return nil, nil, nil
}

func (s *recordingObjectStorage) UploadObjectFromReaderToPath(context.Context, string, string, io.Reader, int64, string) (*storage.ObjectInfo, error) {
	return nil, nil
}

type pausingDeleteObjectStorage struct {
	deleteStarted chan string
	release       chan struct{}
	releaseOnce   sync.Once
	pathCounter   atomic.Int64
}

func newPausingDeleteObjectStorage() *pausingDeleteObjectStorage {
	return &pausingDeleteObjectStorage{
		deleteStarted: make(chan string, 1),
		release:       make(chan struct{}),
	}
}

func (s *pausingDeleteObjectStorage) Bucket() string {
	return "atlas-media"
}

func (s *pausingDeleteObjectStorage) DeleteObjectPath(ctx context.Context, path string) error {
	s.deleteStarted <- path
	select {
	case <-s.release:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (s *pausingDeleteObjectStorage) NewObjectPath(objectID string) string {
	return nextVersionedObjectPath(&s.pathCounter, objectID)
}

func (s *pausingDeleteObjectStorage) StreamObjectPath(context.Context, string, string) (io.ReadCloser, *storage.ObjectInfo, error) {
	return nil, nil, nil
}

func (s *pausingDeleteObjectStorage) UploadObjectFromReaderToPath(context.Context, string, string, io.Reader, int64, string) (*storage.ObjectInfo, error) {
	return nil, nil
}

func (s *pausingDeleteObjectStorage) releaseDelete() {
	s.releaseOnce.Do(func() {
		close(s.release)
	})
}

func (s *pausingDeleteObjectStorage) waitForDeleteStart(t *testing.T) string {
	t.Helper()
	select {
	case path := <-s.deleteStarted:
		return path
	case <-time.After(5 * time.Second):
		t.Fatal("storage delete did not start")
		return ""
	}
}

type blockingObjectStorage struct {
	uploadStarted  chan string
	continueUpload chan struct{}
	releaseOnce    sync.Once
	pathCounter    atomic.Int64

	mu           sync.Mutex
	deletedPaths []string
}

func newBlockingObjectStorage() *blockingObjectStorage {
	return &blockingObjectStorage{
		uploadStarted:  make(chan string, 1),
		continueUpload: make(chan struct{}),
	}
}

func (s *blockingObjectStorage) Bucket() string {
	return "atlas-media"
}

func (s *blockingObjectStorage) DeleteObjectPath(_ context.Context, path string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.deletedPaths = append(s.deletedPaths, path)
	return nil
}

func (s *blockingObjectStorage) NewObjectPath(objectID string) string {
	return nextVersionedObjectPath(&s.pathCounter, objectID)
}

func (s *blockingObjectStorage) StreamObjectPath(context.Context, string, string) (io.ReadCloser, *storage.ObjectInfo, error) {
	return nil, nil, nil
}

func (s *blockingObjectStorage) UploadObjectFromReaderToPath(_ context.Context, objectID, path string, reader io.Reader, size int64, contentType string) (*storage.ObjectInfo, error) {
	s.uploadStarted <- path
	<-s.continueUpload
	_, _ = io.Copy(io.Discard, reader)
	return &storage.ObjectInfo{
		ObjectID:    objectID,
		Bucket:      s.Bucket(),
		Path:        path,
		SizeBytes:   size,
		ContentType: contentType,
	}, nil
}

func (s *blockingObjectStorage) releaseUpload() {
	s.releaseOnce.Do(func() {
		close(s.continueUpload)
	})
}

func (s *blockingObjectStorage) waitForUploadStart(t *testing.T) string {
	t.Helper()
	select {
	case path := <-s.uploadStarted:
		return path
	case <-time.After(5 * time.Second):
		t.Fatal("upload did not reach storage write")
		return ""
	}
}

func (s *blockingObjectStorage) deletedPath(path string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, deletedPath := range s.deletedPaths {
		if deletedPath == path {
			return true
		}
	}
	return false
}

func (s *blockingObjectStorage) deletedPathsSnapshot() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.deletedPaths...)
}

func nextVersionedObjectPath(counter *atomic.Int64, objectID string) string {
	for {
		version := time.Now().UTC().UnixNano()
		previous := counter.Load()
		if version <= previous {
			version = previous + 1
		}
		if counter.CompareAndSwap(previous, version) {
			return fmt.Sprintf("objects/%s/%d", objectID, version)
		}
	}
}

func actionsTestDatabaseURL() (string, bool) {
	if dbURL := os.Getenv("ATLAS_ACTIONS_DATABASE_URL"); dbURL != "" {
		return dbURL, true
	}
	if dbURL := os.Getenv("DATABASE_URL"); dbURL != "" {
		return dbURL, true
	}
	password := os.Getenv("POSTGRES_PASSWORD")
	if password == "" {
		return "", false
	}
	dbURL := url.URL{
		Scheme: "postgres",
		User:   url.UserPassword("atlas", password),
		Host:   "localhost:5432",
		Path:   "/atlas_core",
	}
	return dbURL.String(), false
}

func actionsTestCoreSchemaPresent(ctx context.Context, pool *pgxpool.Pool) (bool, error) {
	var ok bool
	err := pool.QueryRow(ctx, `
		SELECT to_regclass('public.objects') IS NOT NULL
			AND to_regclass('public.atlas_change_events') IS NOT NULL
			AND to_regclass('public.atlas_change_clock') IS NOT NULL
			AND to_regclass('public.object_deletion_fences') IS NOT NULL
			AND to_regclass('public.storage_deletion_outbox') IS NOT NULL
			AND to_regclass('public.storage_upload_intents') IS NOT NULL
	`).Scan(&ok)
	return ok, err
}

func cleanupObjectRaceTestRows(ctx context.Context, t *testing.T, pool *pgxpool.Pool, objectID string) {
	t.Helper()
	if _, err := pool.Exec(ctx, `DELETE FROM objects WHERE object_id = $1`, objectID); err != nil {
		t.Errorf("cleanup object row %q: %v", objectID, err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM storage_deletion_outbox WHERE object_id = $1`, objectID); err != nil {
		t.Errorf("cleanup object storage deletion rows %q: %v", objectID, err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM storage_upload_intents WHERE object_id = $1`, objectID); err != nil {
		t.Errorf("cleanup object upload intent rows %q: %v", objectID, err)
	}
}

func cleanupObjectRaceTestRowsWithTimeout(t *testing.T, pool *pgxpool.Pool, objectID string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cleanupObjectRaceTestRows(ctx, t, pool, objectID)
}
