package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	protocol "github.com/the-drunken-coder/atlas/packages/protocol/generated/go/atlasprotocol"
)

func TestProtocolRevisionHandler(t *testing.T) {
	for _, accept := range []string{"", "application/json", "text/plain"} {
		t.Run("accept="+accept, func(t *testing.T) {
			rec := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodGet, "/protocol/revision", nil)
			if accept != "" {
				req.Header.Set("Accept", accept)
			}
			(&Handler{}).ProtocolRevision(rec, req)
			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d, want 200", rec.Code)
			}
			if got := rec.Header().Get("Content-Type"); !strings.HasPrefix(got, "application/json") {
				t.Fatalf("Content-Type = %q, want application/json", got)
			}
			if errors := protocol.ValidateProtocolRevisionResponse(json.RawMessage(rec.Body.Bytes())); len(errors) > 0 {
				t.Fatalf("invalid Protocol response: %v", errors)
			}
			var response protocol.ProtocolRevisionResponse
			if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
				t.Fatal(err)
			}
			if response.ProtocolRevision != protocol.ProtocolRevision {
				t.Fatalf("protocol_revision = %q, want %q", response.ProtocolRevision, protocol.ProtocolRevision)
			}
		})
	}
}
