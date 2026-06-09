package objectactions

import (
	"encoding/json"
	"testing"

	"github.com/the-drunken-coder/atlas/atlas_core/internal/actions"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/actions/actionstest"
)

func TestUploadObjectJSONValidatesMergedBlob(t *testing.T) {
	existing := map[string]interface{}{
		"referenced_by": []interface{}{map[string]interface{}{}},
	}

	_, err := uploadObjectJSON(existing, "atlas-media", 1024, nil)
	if err == nil {
		t.Fatal("uploadObjectJSON() expected validation error for merged object blob")
	}
	validationErr, ok := err.(*actions.ValidationError)
	if !ok {
		t.Fatalf("uploadObjectJSON() error type = %T, want *actions.ValidationError", err)
	}
	actionstest.AssertDetailsContain(t, validationErr.Details, "must include entity_id or task_id")
}

func TestUploadObjectJSONPreservesExistingBlobFields(t *testing.T) {
	existing := map[string]interface{}{
		"checksum": "sha256:test",
		"referenced_by": []interface{}{
			map[string]interface{}{"entity_id": "entity-1"},
		},
	}

	data, err := uploadObjectJSON(existing, "atlas-media", 1024, nil)
	if err != nil {
		t.Fatalf("uploadObjectJSON() unexpected error: %v", err)
	}

	var got map[string]interface{}
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatal(err)
	}
	if got["checksum"] != "sha256:test" {
		t.Fatalf("checksum = %v, want preserved checksum", got["checksum"])
	}
	if got["bucket"] != "atlas-media" {
		t.Fatalf("bucket = %v, want atlas-media", got["bucket"])
	}
	if got["size_bytes"] != float64(1024) {
		t.Fatalf("size_bytes = %v, want 1024", got["size_bytes"])
	}
}
