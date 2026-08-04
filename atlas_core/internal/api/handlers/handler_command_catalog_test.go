package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	protocol "github.com/the-drunken-coder/atlas/atlas_protocol/generated/go/atlasprotocol"
)

func TestGetCommandCatalogServesValidatedCatalogWithETag(t *testing.T) {
	handler := &Handler{}
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/command-catalog", nil)

	handler.GetCommandCatalog(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusOK)
	}
	if got := recorder.Header().Get("Content-Type"); got != "application/json" {
		t.Fatalf("Content-Type = %q, want application/json", got)
	}
	etag := recorder.Header().Get("ETag")
	if etag == "" {
		t.Fatal("ETag is empty")
	}
	if errors := protocol.ValidateCommandCatalog(json.RawMessage(recorder.Body.Bytes())); len(errors) != 0 {
		t.Fatalf("catalog validation errors = %v", errors)
	}

	cached := httptest.NewRecorder()
	cachedRequest := httptest.NewRequest(http.MethodGet, "/command-catalog", nil)
	cachedRequest.Header.Set("If-None-Match", etag)
	handler.GetCommandCatalog(cached, cachedRequest)

	if cached.Code != http.StatusNotModified {
		t.Fatalf("cached status = %d, want %d", cached.Code, http.StatusNotModified)
	}
	if cached.Body.Len() != 0 {
		t.Fatalf("cached response body length = %d, want 0", cached.Body.Len())
	}
}
