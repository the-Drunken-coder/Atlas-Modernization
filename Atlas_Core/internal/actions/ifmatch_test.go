package actions

import (
	"testing"
	"time"
)

func TestObjectIfMatchOK_weakPrefix(t *testing.T) {
	ts := time.Date(2026, 3, 21, 12, 0, 0, 0, time.UTC)
	want := objectIfMatchETag(ts)
	weak := "W/" + want
	if !ObjectIfMatchOK(weak, ts) {
		t.Fatalf("expected weak ETag to match, got %q vs %q", weak, want)
	}
	if !ObjectIfMatchOK("  "+weak+"  ", ts) {
		t.Fatal("expected trimmed weak ETag to match")
	}
}

func TestObjectIfMatchOK_commaSeparated(t *testing.T) {
	ts := time.Date(2026, 3, 21, 12, 0, 0, 0, time.UTC)
	want := objectIfMatchETag(ts)
	other := `"other"`
	if !ObjectIfMatchOK(other+", "+want, ts) {
		t.Fatalf("expected second token to match")
	}
}
