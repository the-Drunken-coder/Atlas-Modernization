package serializers

import (
	"testing"
	"time"
)

func TestObjectStrongETagMatchesMetadataUpdatedAt(t *testing.T) {
	ts := time.Date(2025, 3, 20, 12, 0, 0, 123456789, time.UTC)
	etag := ObjectStrongETag(ts)
	want := `"2025-03-20T12:00:00.123456Z"`
	if etag != want {
		t.Fatalf("etag %q != want %q", etag, want)
	}
}
