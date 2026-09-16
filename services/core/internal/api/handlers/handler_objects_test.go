package handlers

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/the-drunken-coder/atlas/services/core/internal/actions"
	"github.com/the-drunken-coder/atlas/services/core/internal/storage"
	"github.com/the-drunken-coder/atlas/services/core/internal/testenv"
)

type restoredObjectStorage struct{}

func (*restoredObjectStorage) Bucket() string { return "atlas-media" }

func (*restoredObjectStorage) DeleteObjectPath(context.Context, string, string) error { return nil }

func (*restoredObjectStorage) NewObjectPath(objectID string) string {
	return "objects/" + objectID + "/blob"
}

func (*restoredObjectStorage) StreamObjectPath(_ context.Context, objectID, bucket, path string) (io.ReadCloser, *storage.ObjectInfo, error) {
	const body = "restored object body"
	return io.NopCloser(strings.NewReader(body)), &storage.ObjectInfo{
		ObjectID:    objectID,
		Bucket:      bucket,
		Path:        path,
		SizeBytes:   int64(len(body)),
		ContentType: "application/octet-stream",
	}, nil
}

func (*restoredObjectStorage) UploadObjectFromReaderToPath(context.Context, string, string, io.Reader, int64, string) (*storage.ObjectInfo, error) {
	return nil, nil
}

func TestViewObjectRequiresConfiguredStorage(t *testing.T) {
	handler := newTestHandler()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/objects/object-1/view", nil)

	handler.ViewObject(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503, got %d", rec.Code)
	}

	body := decodeBody(t, rec)
	if body["error_code"] != "STORAGE_UNAVAILABLE" {
		t.Fatalf("expected STORAGE_UNAVAILABLE, got %v", body["error_code"])
	}
}

func TestUploadObjectRequiresConfiguredStorage(t *testing.T) {
	handler := newTestHandler()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/objects/upload", nil)

	handler.UploadObject(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503, got %d", rec.Code)
	}

	body := decodeBody(t, rec)
	if body["error_code"] != "STORAGE_UNAVAILABLE" {
		t.Fatalf("expected STORAGE_UNAVAILABLE, got %v", body["error_code"])
	}
}

func TestUploadObjectAllowsMultipartOverheadAtFileLimit(t *testing.T) {
	handler := newTestHandler()
	handler.storage = &storage.Client{}
	handler.config.MaxUploadSizeMB = 1
	rec := httptest.NewRecorder()
	req := multipartUploadRequest(t, map[string]string{}, 1024*1024)

	handler.UploadObject(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected request to parse and fail validation with 400, got %d", rec.Code)
	}
	body := decodeBody(t, rec)
	if body["error_code"] != "VALIDATION_ERROR" {
		t.Fatalf("expected VALIDATION_ERROR after parsing multipart body, got %v", body["error_code"])
	}
}

func TestUploadObjectRejectsFileOverLimitWith413(t *testing.T) {
	handler := newTestHandler()
	handler.storage = &storage.Client{}
	handler.config.MaxUploadSizeMB = 1
	rec := httptest.NewRecorder()
	req := multipartUploadRequest(t, map[string]string{"object_id": "object-1"}, 1024*1024+1)

	handler.UploadObject(rec, req)

	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("expected 413, got %d", rec.Code)
	}
	body := decodeBody(t, rec)
	if body["error_code"] != "FILE_TOO_LARGE" {
		t.Fatalf("expected FILE_TOO_LARGE, got %v", body["error_code"])
	}
}

func TestUploadObjectMapsOversizedTypeTo400(t *testing.T) {
	storageClient := &storage.Client{}
	handler := newTestHandler()
	handler.storage = storageClient
	handler.objectActions = actions.NewObjectActions(nil, storageClient)
	recorder := httptest.NewRecorder()
	request := multipartUploadRequest(t, map[string]string{
		"object_id": "object-1",
		"type":      strings.Repeat("a", 51),
	}, 1)

	handler.UploadObject(recorder, request)

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", recorder.Code)
	}
	if body := decodeBody(t, recorder); body["error_code"] != "VALIDATION_ERROR" {
		t.Fatalf("error_code = %v, want VALIDATION_ERROR", body["error_code"])
	}
}

func TestDownloadObjectUsesPersistedContentTypeAfterStorageMetadataLoss(t *testing.T) {
	pool := testenv.OpenDatabasePool(t, "ATLAS_ACTIONS_DATABASE_URL", "set ATLAS_ACTIONS_DATABASE_URL, DATABASE_URL, or POSTGRES_PASSWORD to run DB-backed object download test")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	objectID := fmt.Sprintf("restored-download-%d", time.Now().UTC().UnixNano())
	path := "objects/" + objectID + "/blob"
	objectActions := actions.NewObjectActions(pool, nil)
	if _, err := objectActions.Create(ctx, actions.CreateObjectParams{ObjectID: objectID}); err != nil {
		t.Fatalf("create object fixture: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		if _, err := pool.Exec(cleanupCtx, `DELETE FROM objects WHERE object_id = $1`, objectID); err != nil {
			t.Errorf("delete object fixture: %v", err)
		}
	})

	const persistedContentType = "application/vnd.atlas.migration-restore"
	if _, err := pool.Exec(ctx, `
		UPDATE objects
		SET path = $2, content_type = $3, json = '{"bucket":"atlas-media","size_bytes":20}'::jsonb
		WHERE object_id = $1
	`, objectID, path, persistedContentType); err != nil {
		t.Fatalf("attach persisted object metadata: %v", err)
	}

	handler := newTestHandler()
	handler.storage = &storage.Client{}
	handler.objectActions = actions.NewObjectActions(pool, &restoredObjectStorage{})
	recorder := httptest.NewRecorder()
	request := withURLParam(httptest.NewRequest(http.MethodGet, "/objects/"+objectID+"/download", nil), "object_id", objectID)

	handler.DownloadObject(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", recorder.Code)
	}
	if got := recorder.Header().Get("Content-Type"); got != persistedContentType {
		t.Fatalf("Content-Type = %q, want persisted %q", got, persistedContentType)
	}
	if got := recorder.Body.String(); got != "restored object body" {
		t.Fatalf("body = %q, want restored object body", got)
	}
}

func TestIsViewableContentTypeSupportsParameterizedTypes(t *testing.T) {
	if !isViewableContentType("application/json; charset=utf-8") {
		t.Fatal("expected JSON with charset to be viewable")
	}
	if isViewableContentType("text/xml") {
		t.Fatal("expected text/xml to be non-viewable")
	}
	if isViewableContentType("application/xml; charset=utf-8") {
		t.Fatal("expected application/xml with charset to be non-viewable")
	}
	if isViewableContentType("image/png") {
		t.Fatal("expected image/png to be non-viewable")
	}
}

func TestGetExtensionForContentTypeUsesFallbacks(t *testing.T) {
	if got := getExtensionForContentType("application/x-laz"); got != ".laz" {
		t.Fatalf("expected .laz fallback, got %q", got)
	}
	if got := getExtensionForContentType("Application/X-LAZ; charset=utf-8"); got != ".laz" {
		t.Fatalf("expected parameterized .laz fallback, got %q", got)
	}
	if got := getExtensionForContentType("application/x-unknown-xyz"); got != "" {
		t.Fatalf("expected empty extension for unknown type, got %q", got)
	}
}
