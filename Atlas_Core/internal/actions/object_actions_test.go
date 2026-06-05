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
			preflight: objectUploadState{rowExists: true, maxDeletionID: 7},
			current:   objectUploadState{maxDeletionID: 8},
			want:      true,
		},
		{
			name:      "new object create is allowed despite prior tombstone",
			preflight: objectUploadState{rowExists: false, maxDeletionID: 7},
			current:   objectUploadState{maxDeletionID: 8},
			want:      false,
		},
		{
			name:      "existing object unchanged",
			preflight: objectUploadState{rowExists: true, maxDeletionID: 7},
			current:   objectUploadState{rowExists: true, maxDeletionID: 7},
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

func TestApplyConfiguredObjectBucketOverwritesExistingBucket(t *testing.T) {
	blob := map[string]interface{}{
		"bucket":   "client-selected-bucket",
		"checksum": "sha256:test",
	}

	applyConfiguredObjectBucket(blob, &recordingObjectStorage{})

	if blob["bucket"] != "atlas-media" {
		t.Fatalf("bucket = %v, want configured bucket atlas-media", blob["bucket"])
	}
	if blob["checksum"] != "sha256:test" {
		t.Fatalf("checksum = %v, want preserved checksum", blob["checksum"])
	}
}

func TestApplyConfiguredObjectBucketLeavesBlobWithoutStorage(t *testing.T) {
	tests := []struct {
		name string
		blob map[string]interface{}
	}{
		{
			name: "no bucket added",
			blob: map[string]interface{}{
				"checksum": "sha256:test",
			},
		},
		{
			name: "stale bucket removed",
			blob: map[string]interface{}{
				"bucket":   "legacy-bucket",
				"checksum": "sha256:test",
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			applyConfiguredObjectBucket(tt.blob, nil)

			if _, ok := tt.blob["bucket"]; ok {
				t.Fatalf("bucket should not be set without configured storage: %#v", tt.blob)
			}
			if tt.blob["checksum"] != "sha256:test" {
				t.Fatalf("checksum = %v, want preserved checksum", tt.blob["checksum"])
			}
		})
	}
}

func TestUploadDoesNotResurrectObjectDeletedDuringBlobWrite(t *testing.T) {
	dbURL, explicitDBURL := actionsTestDatabaseURL()
	if dbURL == "" {
		t.Skip("set ATLAS_ACTIONS_DATABASE_URL, DATABASE_URL, or POSTGRES_PASSWORD to run DB-backed object upload race test")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		if explicitDBURL {
			t.Fatalf("connect test database: %v", err)
		}
		t.Skipf("test database unavailable: %v", err)
	}
	defer pool.Close()
	if err := pool.Ping(ctx); err != nil {
		if explicitDBURL {
			t.Fatalf("ping test database: %v", err)
		}
		t.Skipf("test database unavailable: %v", err)
	}
	if ok, err := actionsTestCoreSchemaPresent(ctx, pool); err != nil {
		t.Fatalf("check core schema: %v", err)
	} else if !ok {
		t.Skip("core schema is not present in test database")
	}

	storageClient := newBlockingObjectStorage()
	defer storageClient.releaseUpload()
	actions := NewObjectActions(pool, storageClient)

	objectID := fmt.Sprintf("race-%d", time.Now().UTC().UnixNano())
	initialPath := fmt.Sprintf("objects/%s/initial", objectID)
	contentType := "text/plain"
	sizeBytes := int64(3)
	defer cleanupObjectRaceTestRows(context.Background(), pool, objectID)

	if _, err := actions.Create(ctx, CreateObjectParams{
		ObjectID:    objectID,
		Path:        &initialPath,
		ContentType: &contentType,
		SizeBytes:   &sizeBytes,
	}); err != nil {
		t.Fatalf("create initial object: %v", err)
	}

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
			AND to_regclass('public.deletions') IS NOT NULL
	`).Scan(&ok)
	return ok, err
}

func cleanupObjectRaceTestRows(ctx context.Context, pool *pgxpool.Pool, objectID string) {
	_, _ = pool.Exec(ctx, `DELETE FROM objects WHERE object_id = $1`, objectID)
	_, _ = pool.Exec(ctx, `DELETE FROM deletions WHERE resource_type = 'object' AND resource_id = $1`, objectID)
}
