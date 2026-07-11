package actions

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/the-drunken-coder/atlas/atlas_core/internal/models"
)

func TestCollectByteBoundedRowsChargesLargePromotedFields(t *testing.T) {
	rows := &testRowIterator{remaining: 2}
	entities := []*models.Entity{
		{EntityID: "entity-1", Type: strings.Repeat("a", 100), JSON: json.RawMessage(`{}`)},
		{EntityID: "entity-2", Type: strings.Repeat("b", 100), JSON: json.RawMessage(`{}`)},
	}
	scanned := 0

	items, hasMore, err := collectByteBoundedRows(rows, 10, 1_200, "entity", func() (*models.Entity, int, error) {
		entity := entities[scanned]
		scanned++
		return entity, entityRetainedBytes(entity), nil
	})
	if err != nil {
		t.Fatalf("collectByteBoundedRows: %v", err)
	}
	if len(items) != 1 || !hasMore {
		t.Fatalf("items=%d hasMore=%v, want 1 and true", len(items), hasMore)
	}
	if len(entities[0].JSON)+len(entities[1].JSON) >= 1_200 {
		t.Fatal("test requires JSON alone to fit comfortably within the budget")
	}
}

func TestJSONValueBytesOnlyChargesEncoderExpansion(t *testing.T) {
	value := []byte(`{"ordinary":"text","html":"<&>","separator":" "}`)
	if got, want := jsonValueBytes(value), len(value)+18; got != want {
		t.Fatalf("jsonValueBytes = %d, want %d", got, want)
	}
}

func TestCollectByteBoundedRowsStopsBeforeBudgetOverflow(t *testing.T) {
	rows := &testRowIterator{remaining: 3}
	sizes := []int{4, 4, 1}
	scanned := 0

	items, hasMore, err := collectByteBoundedRows(rows, 10, 8, "test", func() (int, int, error) {
		item := scanned
		size := sizes[scanned]
		scanned++
		return item, size, nil
	})
	if err != nil {
		t.Fatalf("collectByteBoundedRows: %v", err)
	}
	if !reflect.DeepEqual(items, []int{0, 1}) {
		t.Fatalf("items = %v, want [0 1]", items)
	}
	if !hasMore {
		t.Fatal("hasMore = false, want true after byte truncation")
	}
	if scanned != 3 || !rows.closed {
		t.Fatalf("scanned=%d closed=%v, want 3 and true", scanned, rows.closed)
	}
}

func TestCollectByteBoundedRowsAcceptsExactBudget(t *testing.T) {
	rows := &testRowIterator{remaining: 2}
	sizes := []int{4, 4}
	scanned := 0

	items, hasMore, err := collectByteBoundedRows(rows, 10, 8, "test", func() (int, int, error) {
		item := scanned
		size := sizes[scanned]
		scanned++
		return item, size, nil
	})
	if err != nil {
		t.Fatalf("collectByteBoundedRows: %v", err)
	}
	if !reflect.DeepEqual(items, []int{0, 1}) || hasMore {
		t.Fatalf("items=%v hasMore=%v, want [0 1] and false", items, hasMore)
	}
}

func TestCollectByteBoundedRowsRetainsCountLimit(t *testing.T) {
	rows := &testRowIterator{remaining: 3}
	scanned := 0

	items, hasMore, err := collectByteBoundedRows(rows, 2, 8, "test", func() (int, int, error) {
		item := scanned
		scanned++
		return item, 1, nil
	})
	if err != nil {
		t.Fatalf("collectByteBoundedRows: %v", err)
	}
	if !reflect.DeepEqual(items, []int{0, 1}) || !hasMore {
		t.Fatalf("items=%v hasMore=%v, want [0 1] and true", items, hasMore)
	}
}

func TestCollectByteBoundedRowsRejectsAtRestInvariantViolation(t *testing.T) {
	rows := &testRowIterator{remaining: 1}

	_, _, err := collectByteBoundedRows(rows, 10, 8, "entity", func() (int, int, error) {
		return 0, 9, nil
	})
	if err == nil || !strings.Contains(err.Error(), "stored entity response row") {
		t.Fatalf("error = %v, want stored entity response-row invariant error", err)
	}
}

type testRowIterator struct {
	remaining int
	closed    bool
	err       error
}

func (r *testRowIterator) Close() {
	r.closed = true
}

func (r *testRowIterator) Err() error {
	return r.err
}

func (r *testRowIterator) Next() bool {
	if r.remaining == 0 {
		r.closed = true
		return false
	}
	r.remaining--
	return true
}
