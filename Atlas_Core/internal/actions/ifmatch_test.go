package actions

import (
	"strings"
	"testing"
	"time"

	"github.com/the-drunken-coder/atlas/atlas_core/internal/serializers"
)

func TestObjectIfMatchETagMatchesSerializedObjectETag(t *testing.T) {
	ts := time.Date(2026, 3, 21, 12, 34, 56, 123456000, time.UTC)

	if objectIfMatchTimeLayout != serializers.APIMetadataTimeLayout {
		t.Fatalf("If-Match layout %q must match serialized object ETag layout %q", objectIfMatchTimeLayout, serializers.APIMetadataTimeLayout)
	}
	if got, want := objectIfMatchETag(ts), serializers.ObjectWeakETag(ts); got != want {
		t.Fatalf("If-Match ETag %q must match serialized object ETag %q", got, want)
	}
}

func TestObjectIfMatchOK_rejectsWeakPrefix(t *testing.T) {
	ts := time.Date(2026, 3, 21, 12, 0, 0, 0, time.UTC)
	want := objectIfMatchETag(ts)
	weak := "W/" + want
	if ObjectIfMatchOK(weak, ts) {
		t.Fatalf("expected weak ETag to be rejected, got %q vs %q", weak, want)
	}
	if ObjectIfMatchOK("  "+weak+"  ", ts) {
		t.Fatal("expected trimmed weak ETag to be rejected")
	}
}

func TestObjectIfMatchOK_acceptsStrongQuotedOrUnquoted(t *testing.T) {
	ts := time.Date(2026, 3, 21, 12, 0, 0, 0, time.UTC)
	want := objectIfMatchETag(ts)
	if !ObjectIfMatchOK(want, ts) {
		t.Fatalf("expected quoted strong ETag to match")
	}
	if !ObjectIfMatchOK(strings.Trim(want, `"`), ts) {
		t.Fatalf("expected unquoted strong ETag to match")
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
