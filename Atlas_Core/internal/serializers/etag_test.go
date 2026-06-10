package serializers

import "testing"

func TestStrongETagUsesResourceVersion(t *testing.T) {
	etag := StrongETag(42)
	want := `"v42"`
	if etag != want {
		t.Fatalf("etag %q != want %q", etag, want)
	}
}
