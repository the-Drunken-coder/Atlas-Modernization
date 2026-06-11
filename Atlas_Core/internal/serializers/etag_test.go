package serializers

import "testing"

func TestStrongETagUsesResourceVersion(t *testing.T) {
	etag := StrongETag(42)
	want := `"v42"`
	if etag != want {
		t.Fatalf("etag %q != want %q", etag, want)
	}
}

func TestStrongETagUsesMinimumValidVersion(t *testing.T) {
	etag := StrongETag(1)
	want := `"v1"`
	if etag != want {
		t.Fatalf("etag %q != want %q", etag, want)
	}
}

func TestStrongETagRejectsInvalidVersions(t *testing.T) {
	for _, version := range []int64{0, -1} {
		if etag := StrongETag(version); etag != "" {
			t.Fatalf("StrongETag(%d) = %q, want empty", version, etag)
		}
	}
}
