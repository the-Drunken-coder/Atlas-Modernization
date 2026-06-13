package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	protocol "github.com/the-drunken-coder/atlas/atlas_protocol/generated/go/atlasprotocol"
)

func TestProtocolRevisionHandler(t *testing.T) {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/protocol/revision", nil)

	(&Handler{}).ProtocolRevision(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	if got := rec.Header().Get("Content-Type"); got != "application/json" {
		t.Fatalf("Content-Type = %q, want application/json", got)
	}
	var response protocolRevisionResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if response.ProtocolRevision != protocol.ProtocolRevision {
		t.Fatalf("protocol_revision = %q, want %q", response.ProtocolRevision, protocol.ProtocolRevision)
	}
}

func TestProtocolRevisionHandlerAcceptHeaders(t *testing.T) {
	for _, accept := range []string{"application/json", "text/plain"} {
		t.Run(accept, func(t *testing.T) {
			rec := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodGet, "/protocol/revision", nil)
			req.Header.Set("Accept", accept)

			(&Handler{}).ProtocolRevision(rec, req)

			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
			}
			if got := rec.Header().Get("Content-Type"); got != "application/json" {
				t.Fatalf("Content-Type = %q, want application/json", got)
			}
			response := decodeProtocolRevisionResponse(t, rec)
			if response.ProtocolRevision != protocol.ProtocolRevision {
				t.Fatalf("protocol_revision = %q, want %q", response.ProtocolRevision, protocol.ProtocolRevision)
			}
		})
	}
}

func TestProtocolRevisionHandlerRejectsWrongMethod(t *testing.T) {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/protocol/revision", nil)

	(&Handler{}).ProtocolRevision(rec, req)

	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusMethodNotAllowed)
	}
	if got := rec.Header().Get("Allow"); got != http.MethodGet {
		t.Fatalf("Allow = %q, want %s", got, http.MethodGet)
	}
	if got := rec.Header().Get("Content-Type"); got != "application/json" {
		t.Fatalf("Content-Type = %q, want application/json", got)
	}
	var response protocol.ErrorResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if response.ErrorCode != protocol.ErrorCodeValidationError || response.Message != "method not allowed" {
		t.Fatalf("unexpected error response: %+v", response)
	}
}

func decodeProtocolRevisionResponse(t *testing.T, rec *httptest.ResponseRecorder) protocolRevisionResponse {
	t.Helper()
	var response protocolRevisionResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	return response
}
