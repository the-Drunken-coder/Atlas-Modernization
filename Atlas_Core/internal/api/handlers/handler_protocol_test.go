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
	var response protocolRevisionResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if response.ProtocolRevision != protocol.ProtocolRevision {
		t.Fatalf("protocol_revision = %q, want %q", response.ProtocolRevision, protocol.ProtocolRevision)
	}
}
