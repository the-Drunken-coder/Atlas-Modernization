package serializers

import (
	"testing"
	"time"
)

func TestObjectWeakETagMatchesMetadataUpdatedAt(t *testing.T) {
	ts := time.Date(2025, 3, 20, 12, 0, 0, 123456789, time.UTC)
	etag := ObjectWeakETag(ts)
	want := `"2025-03-20T12:00:00.123456Z"`
	if etag != want {
		t.Fatalf("etag %q != want %q", etag, want)
	}
}
