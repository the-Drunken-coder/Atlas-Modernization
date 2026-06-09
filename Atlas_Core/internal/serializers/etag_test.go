package serializers

import "testing"

func TestStrongETagUsesVersion(t *testing.T) {
	etag := StrongETag(42)
	want := `"v42"`
	if etag != want {
		t.Fatalf("etag %q != want %q", etag, want)
	}
}

func TestObjectStrongETagUsesSharedFormatter(t *testing.T) {
	if got, want := ObjectStrongETag(42), StrongETag(42); got != want {
		t.Fatalf("object etag %q != shared etag %q", got, want)
	}
}
