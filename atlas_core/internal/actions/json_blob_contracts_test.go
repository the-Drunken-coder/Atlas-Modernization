package actions

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func TestMergeBlobExtraFieldsFiltersPromotedFields(t *testing.T) {
	blob := map[string]interface{}{
		string(taskBlobFieldStatus): "pending",
		"priority":                  "low",
	}
	extra := map[string]interface{}{
		string(taskBlobFieldStatus):   "completed",
		string(taskBlobFieldEntityID): "entity-1",
		string(jsonBlobFieldVersion):  float64(99),
		"priority":                    "high",
		"operator_note":               "hold position",
	}

	mergeBlobExtraFields(blob, extra, taskPromotedBlobFields)

	want := map[string]interface{}{
		string(taskBlobFieldStatus): "pending",
		"priority":                  "high",
		"operator_note":             "hold position",
	}
	if !reflect.DeepEqual(blob, want) {
		t.Fatalf("merged blob = %#v, want %#v", blob, want)
	}
}

func TestMarshalValidatedJSONBlobRejectsOversizedFinalState(t *testing.T) {
	_, err := marshalValidatedJSONBlob(
		map[string]interface{}{"payload": strings.Repeat("x", maxStoredJSONBlobBytes)},
		func(map[string]interface{}) error { return nil },
	)

	assertValidationDetailsContain(t, err, "final stored JSON")
}

func TestPatchValidatedJSONBlobRejectsOversizedMergedFinalState(t *testing.T) {
	raw, err := json.Marshal(map[string]interface{}{
		"existing": strings.Repeat("x", maxStoredJSONBlobBytes-100),
	})
	if err != nil {
		t.Fatalf("marshal fixture: %v", err)
	}

	_, err = patchValidatedJSONBlob(jsonBlobPatch{
		rawMessage: raw,
		extra:      map[string]interface{}{"added": strings.Repeat("y", 200)},
		validate:   func(map[string]interface{}) error { return nil },
	})

	assertValidationDetailsContain(t, err, "final stored JSON")
}

func TestRemoveBlobExtraKeysKeepsPromotedFields(t *testing.T) {
	blob := map[string]interface{}{
		string(jsonBlobFieldComponents): map[string]interface{}{},
		string(taskBlobFieldStatus):     "pending",
		string(taskBlobFieldEntityID):   "entity-1",
		string(jsonBlobFieldVersion):    float64(12),
		"progress":                      float64(20),
		"status_message":                "legacy",
		"result":                        map[string]interface{}{"ok": true},
	}

	removeBlobExtraKeys(
		blob,
		taskPromotedBlobFields,
		string(jsonBlobFieldComponents),
		string(taskBlobFieldStatus),
		string(taskBlobFieldEntityID),
		string(jsonBlobFieldVersion),
		"progress",
		"status_message",
	)

	for _, key := range []string{
		string(jsonBlobFieldComponents),
		string(taskBlobFieldStatus),
		string(taskBlobFieldEntityID),
		string(jsonBlobFieldVersion),
		"result",
	} {
		if _, ok := blob[key]; !ok {
			t.Fatalf("expected key %q to be preserved: %#v", key, blob)
		}
	}
	for _, key := range []string{"progress", "status_message"} {
		if _, ok := blob[key]; ok {
			t.Fatalf("expected key %q to be removed: %#v", key, blob)
		}
	}
}

func TestObjectJSONPatchReplacesSelectedExtraFields(t *testing.T) {
	patched, err := patchValidatedJSONBlob(objectJSONPatch(
		json.RawMessage(`{"name":"old","stale":"remove"}`),
		UpdateObjectParams{
			Extra:           map[string]interface{}{"name": "new"},
			RemoveExtraKeys: []string{"name", "stale", "size_bytes"},
		},
	))
	if err != nil {
		t.Fatalf("patch object JSON: %v", err)
	}

	var got map[string]interface{}
	if err := json.Unmarshal(patched, &got); err != nil {
		t.Fatalf("decode patched object JSON: %v", err)
	}
	if want := map[string]interface{}{"name": "new"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("patched object JSON = %#v, want %#v", got, want)
	}
}

func TestMergeEntityComponentsUsesSharedStoredTypeGuard(t *testing.T) {
	blob := map[string]interface{}{
		string(jsonBlobFieldComponents): "corrupt",
	}
	incoming := map[string]interface{}{
		"status": map[string]interface{}{"value": "active"},
	}

	err := mergeEntityComponents(blob, incoming)
	if err == nil {
		t.Fatal("expected stored component type validation error")
	}
	validationErr, ok := err.(*ValidationError)
	if !ok {
		t.Fatalf("expected validation error, got %T %v", err, err)
	}
	if !strings.Contains(validationErr.Message, "stored entity components must be an object or null") {
		t.Fatalf("validation message = %q, want stored entity components type error", validationErr.Message)
	}
}

func TestMergeEntityComponentsDeepMergesNestedMapsAndReplacesOtherValues(t *testing.T) {
	blob := map[string]interface{}{
		string(jsonBlobFieldComponents): map[string]interface{}{
			"custom_data": map[string]interface{}{
				"keep":           "stored",
				"replace_scalar": "stored",
				"replace_slice":  []interface{}{"stored"},
				"nested": map[string]interface{}{
					"keep":    "stored",
					"replace": "stored",
				},
			},
		},
	}
	incoming := map[string]interface{}{
		"custom_data": map[string]interface{}{
			"replace_scalar": map[string]interface{}{"now": "object"},
			"replace_slice":  []interface{}{"incoming"},
			"nested": map[string]interface{}{
				"replace": "incoming",
				"added":   "incoming",
			},
		},
	}

	if err := mergeEntityComponents(blob, incoming); err != nil {
		t.Fatalf("mergeEntityComponents: %v", err)
	}

	components := blob[string(jsonBlobFieldComponents)].(map[string]interface{})
	got := components["custom_data"]
	want := map[string]interface{}{
		"keep":           "stored",
		"replace_scalar": map[string]interface{}{"now": "object"},
		"replace_slice":  []interface{}{"incoming"},
		"nested": map[string]interface{}{
			"keep":    "stored",
			"replace": "incoming",
			"added":   "incoming",
		},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("custom_data = %#v, want %#v", got, want)
	}
}

func TestDecodeObjectJSONForPatchStillPreservesNumbers(t *testing.T) {
	blob, err := decodeJSONBlobForPatch(
		json.RawMessage(`{"size_bytes":9007199254740993,"operator_note":"patched"}`),
		jsonBlobDecodeUseNumber,
	)
	if err != nil {
		t.Fatalf("decodeJSONBlobForPatch: %v", err)
	}

	size, ok := blob[string(objectBlobFieldSizeBytes)].(json.Number)
	if !ok {
		t.Fatalf("size_bytes type = %T, want json.Number", blob[string(objectBlobFieldSizeBytes)])
	}
	got, err := size.Int64()
	if err != nil {
		t.Fatalf("size_bytes Int64: %v", err)
	}
	if got != 9007199254740993 {
		t.Fatalf("size_bytes = %d, want exact large integer", got)
	}
}
