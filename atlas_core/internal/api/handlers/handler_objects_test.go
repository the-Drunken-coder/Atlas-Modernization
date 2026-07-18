package handlers

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/the-drunken-coder/atlas/atlas_core/internal/storage"
)

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
