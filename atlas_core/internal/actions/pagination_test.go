package actions

import (
	"testing"
	"time"
)

func TestClampListLimit(t *testing.T) {
	tests := []struct {
		name  string
		limit int
		want  int
	}{
		{"zero becomes default", 0, DefaultListLimit},
		{"negative becomes default", -1, DefaultListLimit},
		{"valid passthrough", 50, 50},
		{"max passthrough", MaxListLimit, MaxListLimit},
		{"above max clamped", MaxListLimit + 1, MaxListLimit},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := ClampListLimit(tt.limit); got != tt.want {
				t.Fatalf("ClampListLimit(%d) = %d, want %d", tt.limit, got, tt.want)
			}
		})
	}
}

func TestClampLimitCheckinDefault(t *testing.T) {
	tests := []struct {
		name  string
		limit int
		want  int
	}{
		{"zero becomes checkin default", 0, 10},
		{"negative becomes checkin default", -5, 10},
		{"valid passthrough", 15, 15},
		{"above max clamped", 600, MaxListLimit},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := ClampLimit(tt.limit, 10, MaxListLimit); got != tt.want {
				t.Fatalf("ClampLimit(%d, 10, %d) = %d, want %d", tt.limit, MaxListLimit, got, tt.want)
			}
		})
	}
}

func TestListPageWithCursorEncodesLastItem(t *testing.T) {
	type row struct {
		createdAt time.Time
		id        string
	}
	snapshotUpperBound := time.Date(2026, 6, 26, 12, 0, 0, 0, time.UTC)
	items := []row{
		{createdAt: snapshotUpperBound.Add(-time.Minute), id: "first"},
		{createdAt: snapshotUpperBound.Add(-2 * time.Minute), id: "last"},
	}

	page, err := listPageWithCursor(items, 2, true, snapshotUpperBound, "test", func(item row) (time.Time, string) {
		return item.createdAt, item.id
	})
	if err != nil {
		t.Fatalf("listPageWithCursor: %v", err)
	}
	if page.Limit != 2 || !page.HasMore || len(page.Items) != 2 {
		t.Fatalf("page = %+v, want limit, hasMore, and items preserved", page)
	}

	gotTimestamp, gotID, gotUpperBound, err := decodeRowCursor(page.NextCursor)
	if err != nil {
		t.Fatalf("decode next cursor: %v", err)
	}
	if !gotTimestamp.Equal(items[1].createdAt) || gotID != "last" || !gotUpperBound.Equal(snapshotUpperBound) {
		t.Fatalf("cursor = (%v, %q, %v), want (%v, %q, %v)", gotTimestamp, gotID, gotUpperBound, items[1].createdAt, "last", snapshotUpperBound)
	}
}

func TestListPageWithCursorOmitsNextCursorWhenExhausted(t *testing.T) {
	page, err := listPageWithCursor([]string{"only"}, 1, false, time.Now(), "test", func(item string) (time.Time, string) {
		return time.Now(), item
	})
	if err != nil {
		t.Fatalf("listPageWithCursor: %v", err)
	}
	if page.NextCursor != "" {
		t.Fatalf("NextCursor = %q, want empty", page.NextCursor)
	}
}

func TestListPageWithCursorOmitsNextCursorWhenHasMoreButEmpty(t *testing.T) {
	rowCursorCalled := false
	page, err := listPageWithCursor([]string{}, 1, true, time.Now(), "test", func(item string) (time.Time, string) {
		rowCursorCalled = true
		return time.Now(), item
	})
	if err != nil {
		t.Fatalf("listPageWithCursor: %v", err)
	}
	if !page.HasMore {
		t.Fatalf("HasMore = false, want true")
	}
	if page.NextCursor != "" {
		t.Fatalf("NextCursor = %q, want empty", page.NextCursor)
	}
	if rowCursorCalled {
		t.Fatal("row cursor callback was called for an empty page")
	}
}
