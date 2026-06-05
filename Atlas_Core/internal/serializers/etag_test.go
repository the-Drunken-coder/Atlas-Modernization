package serializers

import "testing"

func TestObjectStrongETagUsesObjectVersion(t *testing.T) {
	etag := ObjectStrongETag(42)
	want := `"v42"`
	if etag != want {
		t.Fatalf("etag %q != want %q", etag, want)
	}
}
