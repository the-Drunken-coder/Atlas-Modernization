package integration

import (
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestJoinURL_preservesBasePath(t *testing.T) {
	t.Parallel()
	got, err := joinURL("http://localhost:8000/atlas-core", "/entities")
	if err != nil {
		t.Fatalf("joinURL: %v", err)
	}
	want := "http://localhost:8000/atlas-core/entities"
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestJoinURL_splitsQueryFromPath(t *testing.T) {
	t.Parallel()
	got, err := joinURL("http://localhost:8000/atlas-core", "/entities/foo?limit=1&cursor=abc")
	if err != nil {
		t.Fatalf("joinURL: %v", err)
	}
	want := "http://localhost:8000/atlas-core/entities/foo?limit=1&cursor=abc"
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestJoinURL_trailingSlashBase(t *testing.T) {
	t.Parallel()
	got, err := joinURL("http://localhost:8000/atlas-core/", "/entities")
	if err != nil {
		t.Fatalf("joinURL: %v", err)
	}
	if want := "http://localhost:8000/atlas-core/entities"; got != want {
		t.Errorf("got %q, want %q", got, want)
	}
	got, err = joinURL("http://localhost:8000/atlas-core/", "/entities/foo?limit=1&cursor=abc")
	if err != nil {
		t.Fatalf("joinURL: %v", err)
	}
	if want := "http://localhost:8000/atlas-core/entities/foo?limit=1&cursor=abc"; got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestParseResponseRejectsEmptyBody(t *testing.T) {
	t.Parallel()

	resp := &http.Response{Body: io.NopCloser(strings.NewReader(""))}
	var payload map[string]interface{}
	err := ParseResponse(resp, &payload)
	if err == nil {
		t.Fatal("expected ParseResponse to fail on empty body")
	}
	if !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatalf("expected io.ErrUnexpectedEOF, got %v", err)
	}
}

func TestSystemAvailableUsesReadinessEndpoint(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTeapot)
	})
	mux.HandleFunc("/readiness", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	server := httptest.NewServer(mux)
	defer server.Close()

	t.Setenv("ATLAS_CORE_API_URL", server.URL)

	if !SystemAvailable(t) {
		t.Fatal("expected ready system to be available")
	}
}

func TestSystemAvailableRejectsUnreadySystem(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	mux.HandleFunc("/readiness", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	})
	server := httptest.NewServer(mux)
	defer server.Close()

	t.Setenv("ATLAS_CORE_API_URL", server.URL)

	if SystemAvailable(t) {
		t.Fatal("expected unready system to be unavailable")
	}
}

func TestJoinURL_rejectsParentTraversal(t *testing.T) {
	t.Parallel()
	_, err := joinURL("http://localhost:8000/atlas-core", "/../health")
	if err == nil {
		t.Fatal("expected error for parent traversal in path")
	}
}

func TestJoinURL_rejectsEncodedParentTraversal(t *testing.T) {
	t.Parallel()
	_, err := joinURL("http://localhost:8000/atlas-core", "/%2e%2e/health")
	if err == nil {
		t.Fatal("expected error for encoded parent traversal in path")
	}
}

func TestJoinURL_rejectsInvalidEscapedPath(t *testing.T) {
	t.Parallel()
	_, err := joinURL("http://localhost:8000/atlas-core", "/entities/%zz")
	if err == nil {
		t.Fatal("expected error for invalid escaped path segment")
	}
}

func TestParseOptionalResponseAllowsEmptyBody(t *testing.T) {
	t.Parallel()

	resp := &http.Response{Body: io.NopCloser(strings.NewReader(""))}
	var payload map[string]interface{}
	if err := ParseOptionalResponse(resp, &payload); err != nil {
		t.Fatalf("ParseOptionalResponse: %v", err)
	}
}
