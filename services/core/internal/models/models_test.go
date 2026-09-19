package models_test

import (
	"encoding/json"
	"reflect"
	"testing"

	"github.com/the-drunken-coder/atlas/services/core/internal/models"
)

func TestEntityJSONAccessors(t *testing.T) {
	entity := &models.Entity{JSON: json.RawMessage(`{"components":{"status":{"value":"idle"}},"extra_field":"extra_value","large":9007199254740993,"version":999}`)}
	if got := entity.GetComponents()["status"].(map[string]any)["value"]; got != "idle" {
		t.Fatalf("status = %v, want idle", got)
	}
	want := map[string]any{"extra_field": "extra_value", "large": json.Number("9007199254740993")}
	if got := entity.GetExtra(); !reflect.DeepEqual(got, want) {
		t.Fatalf("extra = %#v, want %#v", got, want)
	}
	if got := entity.DecodedJSON()["large"]; got != json.Number("9007199254740993") {
		t.Fatalf("decoded large integer = %#v", got)
	}
	entity.JSON = json.RawMessage(`{"components":{}}`)
	if got := entity.GetExtra(); got != nil {
		t.Fatalf("empty extra = %#v, want nil", got)
	}
}

func TestEntityRejectsMissingOrCorruptJSON(t *testing.T) {
	for name, raw := range map[string]json.RawMessage{
		"nil":       nil,
		"malformed": json.RawMessage(`invalid json`),
		"trailing":  json.RawMessage(`{"components":{}}{"unexpected":true}`),
	} {
		t.Run(name, func(t *testing.T) {
			entity := &models.Entity{JSON: raw}
			if got := entity.GetComponents(); got != nil {
				t.Fatalf("components = %#v, want nil", got)
			}
			if got := entity.DecodedJSON(); got != nil {
				t.Fatalf("decoded JSON = %#v, want nil", got)
			}
		})
	}
}

func TestMediaObjectJSONAccessors(t *testing.T) {
	object := &models.MediaObject{JSON: json.RawMessage(`  {"size_bytes":1024,"usage_hints":["thumbnail","preview"],"bucket":"atlas-media","referenced_by":[{"entity_id":"entity-1"},{"task_id":"task-1"}],"custom":"value","version":999}  `)}
	if got := object.GetSizeBytes(); got == nil || *got != 1024 {
		t.Fatalf("size = %v, want 1024", got)
	}
	if got := object.GetUsageHints(); !reflect.DeepEqual(got, []string{"thumbnail", "preview"}) {
		t.Fatalf("usage hints = %#v", got)
	}
	if got := object.GetBucket(); got == nil || *got != "atlas-media" {
		t.Fatalf("bucket = %v, want atlas-media", got)
	}
	if got := object.GetReferencedBy(); !reflect.DeepEqual(got, []map[string]any{{"entity_id": "entity-1"}, {"task_id": "task-1"}}) {
		t.Fatalf("references = %#v", got)
	}
	if got := object.GetExtra(); !reflect.DeepEqual(got, map[string]any{"custom": "value"}) {
		t.Fatalf("extra = %#v, want only custom field", got)
	}
	object.JSON = json.RawMessage(`{"size_bytes":1024}{"injected":true}`)
	if got := object.GetSizeBytes(); got != nil {
		t.Fatalf("size for trailing JSON = %v, want nil", got)
	}
}

func TestEntityDecodedJSONInvalidatesWhenJSONChanges(t *testing.T) {
	entity := &models.Entity{
		EntityID: "entity-cache",
		Type:     "asset",
		JSON:     []byte(`{"components":{"status":{"value":"idle"}}}`),
	}

	first := entity.GetComponents()
	if first["status"] == nil {
		t.Fatal("expected initial components")
	}

	entity.JSON = []byte(`{"components":{"status":{"value":"active"}}}`)
	second := entity.GetComponents()
	status, ok := second["status"].(map[string]interface{})
	if !ok || status["value"] != "active" {
		t.Fatalf("expected updated status after JSON reassignment, got %#v", second["status"])
	}
}

func TestEntityJSONSnapshotIsolationAndInvalidation(t *testing.T) {
	entity := &models.Entity{JSON: json.RawMessage(`{"components":{"status":{"value":"idle"}},"extension":{"values":[9007199254740993]}}`)}
	first := entity.JSONSnapshot()
	first.Components()["status"].(map[string]interface{})["value"] = "mutated"
	first.Extra()["extension"].(map[string]interface{})["values"].([]interface{})[0] = "mutated"
	second := entity.JSONSnapshot()
	if second.Components()["status"].(map[string]interface{})["value"] != "idle" || second.Extra()["extension"].(map[string]interface{})["values"].([]interface{})[0] != json.Number("9007199254740993") {
		t.Fatal("snapshot mutation changed cached JSON")
	}

	copy(entity.JSON, `{"components":{"status":{"value":"busy"}},"extension":{"values":[9007199254740993]}}`)
	if entity.JSONSnapshot().Components()["status"].(map[string]interface{})["value"] != "busy" {
		t.Fatal("snapshot did not observe in-place raw JSON update")
	}
	if second.Components()["status"].(map[string]interface{})["value"] != "idle" {
		t.Fatal("raw JSON update changed an earlier snapshot")
	}
	entity.JSON = json.RawMessage(`{"components":{}} trailing`)
	if entity.JSONSnapshot().Components() != nil {
		t.Fatal("snapshot accepted trailing JSON data")
	}
}

func TestObjectJSONSnapshotIsolationAndInvalidation(t *testing.T) {
	object := &models.MediaObject{JSON: json.RawMessage(`{"size_bytes":9007199254740993,"bucket":"first","referenced_by":[{"entity_id":"asset","nested":[1]}],"extension":{"values":[2]}}`)}
	first := object.JSONSnapshot()
	first.ReferencedBy()[0]["nested"].([]interface{})[0] = "mutated"
	first.Extra()["extension"].(map[string]interface{})["values"].([]interface{})[0] = "mutated"
	second := object.JSONSnapshot()
	if second.ReferencedBy()[0]["nested"].([]interface{})[0] != json.Number("1") || second.Extra()["extension"].(map[string]interface{})["values"].([]interface{})[0] != json.Number("2") {
		t.Fatal("snapshot mutation changed cached JSON")
	}
	if size := second.SizeBytes(); size == nil || *size != 9007199254740993 {
		t.Fatalf("snapshot lost integer precision: %v", size)
	}
	object.JSON = json.RawMessage(`{"bucket":"second"}`)
	if bucket := object.JSONSnapshot().Bucket(); bucket == nil || *bucket != "second" {
		t.Fatal("snapshot did not observe raw JSON replacement")
	}
	if bucket := second.Bucket(); bucket == nil || *bucket != "first" {
		t.Fatal("raw JSON replacement changed an earlier snapshot")
	}
	for _, size := range []string{"-1", "1.5", "1.0", "9223372036854775808", `"7"`} {
		object.JSON = json.RawMessage(`{"size_bytes":` + size + `}`)
		if object.JSONSnapshot().SizeBytes() != nil {
			t.Errorf("snapshot accepted invalid size %s", size)
		}
	}
}
