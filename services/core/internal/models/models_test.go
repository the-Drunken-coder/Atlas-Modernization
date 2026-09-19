package models_test

import (
	"encoding/json"
	"testing"

	"github.com/the-drunken-coder/atlas/services/core/internal/models"
)

func TestEntityGetComponentsNil(t *testing.T) {
	entity := &models.Entity{
		EntityID: "test-entity",
		Type:     "asset",
		JSON:     nil,
	}

	components := entity.GetComponents()
	if components != nil {
		t.Error("Expected nil for nil JSON")
	}
}

func TestEntityGetComponentsInvalidJSON(t *testing.T) {
	entity := &models.Entity{
		EntityID: "test-entity",
		Type:     "asset",
		JSON:     []byte("invalid json"),
	}

	components := entity.GetComponents()
	if components != nil {
		t.Error("Expected nil for invalid JSON")
	}
}

func TestEntityGetExtra(t *testing.T) {
	jsonData := map[string]interface{}{
		"components":  map[string]interface{}{},
		"extra_field": "extra_value",
		"another":     123,
		"version":     999,
	}
	jsonBytes, err := json.Marshal(jsonData)
	if err != nil {
		t.Fatalf("json.Marshal: %v", err)
	}

	entity := &models.Entity{
		EntityID: "test-entity",
		Type:     "asset",
		JSON:     jsonBytes,
	}

	extra := entity.GetExtra()
	if extra == nil {
		t.Error("Expected extra, got nil")
	}
	if extra["extra_field"] != "extra_value" {
		t.Errorf("Expected extra_field to be 'extra_value', got %v", extra["extra_field"])
	}
	if extra["components"] != nil {
		t.Error("components should be excluded from extra")
	}
	if extra["version"] != nil {
		t.Error("version should be excluded from extra")
	}
}

func TestEntityGetExtraEmpty(t *testing.T) {
	jsonData := map[string]interface{}{
		"components": map[string]interface{}{},
	}
	jsonBytes, err := json.Marshal(jsonData)
	if err != nil {
		t.Fatalf("json.Marshal: %v", err)
	}

	entity := &models.Entity{
		EntityID: "test-entity",
		Type:     "asset",
		JSON:     jsonBytes,
	}

	extra := entity.GetExtra()
	if extra != nil {
		t.Error("Expected nil for empty extra")
	}
}

func TestMediaObjectRejectsTrailingGarbage(t *testing.T) {
	// A valid JSON object followed by trailing bytes must be treated as corrupt,
	// not silently accepted (the streaming decoder would otherwise ignore the tail).
	obj := &models.MediaObject{
		ObjectID: "test-obj",
		JSON:     json.RawMessage(`{"size_bytes":1024}{"injected":true}`),
	}
	if got := obj.GetSizeBytes(); got != nil {
		t.Fatalf("expected nil size for JSON with trailing garbage, got %d", *got)
	}

	// A well-formed payload (optionally with surrounding whitespace) still parses.
	ok := &models.MediaObject{
		ObjectID: "test-obj",
		JSON:     json.RawMessage(`  {"size_bytes":1024}  `),
	}
	if got := ok.GetSizeBytes(); got == nil || *got != 1024 {
		t.Fatalf("expected size 1024 for valid JSON, got %v", got)
	}
}

func TestMediaObjectGetExtra(t *testing.T) {
	jsonData := map[string]interface{}{
		"size_bytes":  float64(1024),
		"usage_hints": []interface{}{"thumbnail"},
		"bucket":      "atlas-media",
		"custom":      "value",
		"version":     999,
	}
	jsonBytes, err := json.Marshal(jsonData)
	if err != nil {
		t.Fatalf("json.Marshal: %v", err)
	}

	obj := &models.MediaObject{
		ObjectID: "test-obj",
		JSON:     jsonBytes,
	}

	extra := obj.GetExtra()
	if extra == nil {
		t.Fatal("Expected extra, got nil")
	}
	if extra["custom"] != "value" {
		t.Errorf("Expected custom='value', got %v", extra["custom"])
	}
	// Promoted fields should be excluded
	if _, ok := extra["size_bytes"]; ok {
		t.Error("size_bytes should be excluded from extra")
	}
	if _, ok := extra["version"]; ok {
		t.Error("version should be excluded from extra")
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

func TestEntityDecodedJSONPreservesNumbers(t *testing.T) {
	entity := &models.Entity{
		EntityID: "entity-number",
		Type:     "asset",
		JSON:     json.RawMessage(`{"large":9007199254740993}`),
	}

	data := entity.DecodedJSON()
	large, ok := data["large"].(json.Number)
	if !ok {
		t.Fatalf("large type = %T, want json.Number", data["large"])
	}
	got, err := large.Int64()
	if err != nil {
		t.Fatalf("large Int64: %v", err)
	}
	if got != 9007199254740993 {
		t.Fatalf("large = %d, want exact large integer", got)
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
