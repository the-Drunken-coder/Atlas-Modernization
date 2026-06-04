package integration

import (
	"errors"
	"io"
	"net/http"
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

func TestJoinURL_rejectsParentTraversal(t *testing.T) {
	t.Parallel()
	_, err := joinURL("http://localhost:8000/atlas-core", "/../health")
	if err == nil {
		t.Fatal("expected error for parent traversal in path")
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
