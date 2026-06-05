package actions

import (
	"strings"
	"testing"

	"github.com/the-drunken-coder/atlas/atlas_core/internal/serializers"
)

func TestObjectIfMatchETagMatchesSerializedObjectETag(t *testing.T) {
	version := int64(42)
	if got, want := objectIfMatchETag(version), serializers.ObjectStrongETag(version); got != want {
		t.Fatalf("If-Match ETag %q must match serialized object ETag %q", got, want)
	}
}

func TestObjectIfMatchOK_rejectsWeakPrefix(t *testing.T) {
	version := int64(42)
	want := objectIfMatchETag(version)
	weak := "W/" + want
	if ObjectIfMatchOK(weak, version) {
		t.Fatalf("expected weak ETag to be rejected, got %q vs %q", weak, want)
	}
	if ObjectIfMatchOK("  "+weak+"  ", version) {
		t.Fatal("expected trimmed weak ETag to be rejected")
	}
}

func TestObjectIfMatchOK_acceptsStrongQuotedOrUnquoted(t *testing.T) {
	version := int64(42)
	want := objectIfMatchETag(version)
	if !ObjectIfMatchOK(want, version) {
		t.Fatalf("expected quoted strong ETag to match")
	}
	if !ObjectIfMatchOK(strings.Trim(want, `"`), version) {
		t.Fatalf("expected unquoted strong ETag to match")
	}
}

func TestObjectIfMatchOK_commaSeparated(t *testing.T) {
	version := int64(42)
	want := objectIfMatchETag(version)
	other := `"other"`
	if !ObjectIfMatchOK(other+", "+want, version) {
		t.Fatalf("expected second token to match")
	}
}
