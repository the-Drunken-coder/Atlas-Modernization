package actions

import (
	"encoding/json"
	"testing"
)

func TestValidateObjectBlob(t *testing.T) {
	tests := []struct {
		name    string
		blob    map[string]interface{}
		wantErr bool
		errMsg  string
	}{
		{
			name: "valid object blob",
			blob: map[string]interface{}{
				"bucket":      "atlas-media",
				"size_bytes":  int64(2048),
				"usage_hints": []interface{}{"camera_feed"},
				"referenced_by": []interface{}{
					map[string]interface{}{"entity_id": "entity-1"},
					map[string]interface{}{"task_id": "task-1"},
				},
				"checksum": "sha256:test",
			},
			wantErr: false,
		},
		{
			name: "negative size",
			blob: map[string]interface{}{
				"size_bytes": -1,
			},
			wantErr: true,
			errMsg:  "size_bytes",
		},
		{
			name: "usage hints must be strings",
			blob: map[string]interface{}{
				"usage_hints": []interface{}{"thumbnail", 123},
			},
			wantErr: true,
			errMsg:  "usage_hints.1",
		},
		{
			name: "reference must include entity or task",
			blob: map[string]interface{}{
				"referenced_by": []interface{}{map[string]interface{}{}},
			},
			wantErr: true,
			errMsg:  "referenced_by",
		},
		{
			name: "reference id must be non-empty",
			blob: map[string]interface{}{
				"referenced_by": []interface{}{map[string]interface{}{"entity_id": " "}},
			},
			wantErr: true,
			errMsg:  "referenced_by",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateObjectBlob(tt.blob)
			if tt.wantErr {
				if err == nil {
					t.Fatal("ValidateObjectBlob() expected error but got nil")
				}
				validationErr, ok := err.(*ValidationError)
				if !ok {
					t.Fatalf("ValidateObjectBlob() error type = %T, want *ValidationError", err)
				}
				if tt.errMsg != "" {
					assertValidationErrorDetailsContain(t, validationErr.Details, tt.errMsg)
				}
				return
			}
			if err != nil {
				t.Fatalf("ValidateObjectBlob() unexpected error: %v", err)
			}
		})
	}
}

func TestUploadObjectJSONValidatesMergedBlob(t *testing.T) {
	existing := map[string]interface{}{
		"referenced_by": []interface{}{map[string]interface{}{}},
	}

	_, err := uploadObjectJSON(existing, "atlas-media", 1024, nil)
	if err == nil {
		t.Fatal("uploadObjectJSON() expected validation error for merged object blob")
	}
	validationErr, ok := err.(*ValidationError)
	if !ok {
		t.Fatalf("uploadObjectJSON() error type = %T, want *ValidationError", err)
	}
	assertValidationErrorDetailsContain(t, validationErr.Details, "MinFields")
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
