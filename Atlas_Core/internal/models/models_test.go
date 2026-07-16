package models_test

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/the-drunken-coder/atlas/atlas_core/internal/models"
)

func TestEntityGetComponents(t *testing.T) {
	jsonData := map[string]interface{}{
		"components": map[string]interface{}{
			"telemetry": map[string]interface{}{
				"latitude":  40.7128,
				"longitude": -74.0060,
			},
		},
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

	components := entity.GetComponents()
	if components == nil {
		t.Error("Expected components, got nil")
	}
	if components["telemetry"] == nil {
		t.Error("Expected telemetry component")
	}
}

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

func TestTaskGetComponents(t *testing.T) {
	jsonData := map[string]interface{}{
		"components": map[string]interface{}{
			"command": map[string]interface{}{
				"type": "move_to",
			},
		},
	}
	jsonBytes, err := json.Marshal(jsonData)
	if err != nil {
		t.Fatalf("json.Marshal: %v", err)
	}

	task := &models.Task{
		TaskID: "test-task",
		Status: "pending",
		JSON:   jsonBytes,
	}

	components := task.GetComponents()
	if components == nil {
		t.Error("Expected components, got nil")
	}
	if components["command"] == nil {
		t.Error("Expected command component")
	}
}

func TestTaskGetExtra(t *testing.T) {
	jsonData := map[string]interface{}{
		"components": map[string]interface{}{},
		"priority":   "high",
		"version":    999,
	}
	jsonBytes, err := json.Marshal(jsonData)
	if err != nil {
		t.Fatalf("json.Marshal: %v", err)
	}

	task := &models.Task{
		TaskID: "test-task",
		Status: "pending",
		JSON:   jsonBytes,
	}

	extra := task.GetExtra()
	if extra == nil {
		t.Error("Expected extra, got nil")
	}
	if extra["priority"] != "high" {
		t.Errorf("Expected priority 'high', got %v", extra["priority"])
	}
	if extra["version"] != nil {
		t.Error("version should be excluded from extra")
	}
}

func TestMediaObjectGetSizeBytes(t *testing.T) {
	jsonData := map[string]interface{}{
		"size_bytes": float64(1024),
	}
	jsonBytes, err := json.Marshal(jsonData)
	if err != nil {
		t.Fatalf("json.Marshal: %v", err)
	}

	obj := &models.MediaObject{
		ObjectID: "test-obj",
		JSON:     jsonBytes,
	}

	size := obj.GetSizeBytes()
	if size == nil {
		t.Fatal("Expected size, got nil")
	}
	if *size != 1024 {
		t.Errorf("Expected 1024, got %d", *size)
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

func TestMediaObjectGetSizeBytesRejectsNegative(t *testing.T) {
	jsonData := map[string]interface{}{
		"size_bytes": float64(-1),
	}
	jsonBytes, err := json.Marshal(jsonData)
	if err != nil {
		t.Fatalf("json.Marshal: %v", err)
	}
	obj := &models.MediaObject{ObjectID: "test-obj", JSON: jsonBytes}
	if obj.GetSizeBytes() != nil {
		t.Fatal("expected nil for negative size_bytes")
	}
}

func TestMediaObjectGetSizeBytesRejectsFractional(t *testing.T) {
	obj := &models.MediaObject{
		ObjectID: "test-obj",
		JSON:     json.RawMessage(`{"size_bytes":1.5}`),
	}
	if obj.GetSizeBytes() != nil {
		t.Fatal("expected nil for fractional size_bytes")
	}

	integerValuedFloat := &models.MediaObject{
		ObjectID: "test-obj-2",
		JSON:     json.RawMessage(`{"size_bytes":1.0}`),
	}
	if integerValuedFloat.GetSizeBytes() != nil {
		t.Fatal("expected nil for integer-valued float size_bytes")
	}
}

func TestMediaObjectGetUsageHints(t *testing.T) {
	jsonData := map[string]interface{}{
		"usage_hints": []interface{}{"thumbnail", "preview"},
	}
	jsonBytes, err := json.Marshal(jsonData)
	if err != nil {
		t.Fatalf("json.Marshal: %v", err)
	}

	obj := &models.MediaObject{
		ObjectID: "test-obj",
		JSON:     jsonBytes,
	}

	hints := obj.GetUsageHints()
	if len(hints) != 2 {
		t.Fatalf("Expected 2 hints, got %d", len(hints))
	}
	if hints[0] != "thumbnail" || hints[1] != "preview" {
		t.Errorf("Unexpected hints: %v", hints)
	}
}

func TestMediaObjectGetBucket(t *testing.T) {
	jsonData := map[string]interface{}{
		"bucket": "atlas-media",
	}
	jsonBytes, err := json.Marshal(jsonData)
	if err != nil {
		t.Fatalf("json.Marshal: %v", err)
	}

	obj := &models.MediaObject{
		ObjectID: "test-obj",
		JSON:     jsonBytes,
	}

	bucket := obj.GetBucket()
	if bucket == nil {
		t.Fatal("Expected bucket, got nil")
	}
	if *bucket != "atlas-media" {
		t.Errorf("Expected 'atlas-media', got %s", *bucket)
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

func TestMediaObjectGetReferencedBy(t *testing.T) {
	jsonData := map[string]interface{}{
		"referenced_by": []interface{}{
			map[string]interface{}{"entity_id": "entity-1"},
			map[string]interface{}{"task_id": "task-1"},
		},
	}
	jsonBytes, err := json.Marshal(jsonData)
	if err != nil {
		t.Fatalf("json.Marshal: %v", err)
	}

	obj := &models.MediaObject{
		ObjectID: "test-obj",
		JSON:     jsonBytes,
	}

	refs := obj.GetReferencedBy()
	if len(refs) != 2 {
		t.Errorf("Expected 2 refs, got %d", len(refs))
	}
}

func TestEntityTimestamps(t *testing.T) {
	now := time.Now().UTC()
	entity := &models.Entity{
		EntityID:  "test",
		Type:      "asset",
		CreatedAt: now,
		UpdatedAt: now,
	}

	if entity.CreatedAt.IsZero() {
		t.Error("CreatedAt should not be zero")
	}
	if entity.UpdatedAt.IsZero() {
		t.Error("UpdatedAt should not be zero")
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

func TestEntityDecodedJSONRejectsTrailingData(t *testing.T) {
	entity := &models.Entity{
		EntityID: "entity-trailing",
		Type:     "asset",
		JSON:     json.RawMessage(`{"components":{}}{"unexpected":true}`),
	}

	if got := entity.DecodedJSON(); got != nil {
		t.Fatalf("expected nil for entity JSON with trailing data, got %#v", got)
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

func TestTaskDecodedJSONInvalidatesWhenJSONChanges(t *testing.T) {
	task := &models.Task{
		TaskID: "task-cache",
		Status: "pending",
		JSON:   []byte(`{"priority":"low"}`),
	}

	first := task.GetExtra()
	if first["priority"] != "low" {
		t.Fatalf("expected initial priority, got %#v", first)
	}

	task.JSON = []byte(`{"priority":"high"}`)
	second := task.GetExtra()
	if second["priority"] != "high" {
		t.Fatalf("expected updated priority after JSON reassignment, got %#v", second)
	}
}

func TestTaskDecodedJSONRejectsTrailingData(t *testing.T) {
	task := &models.Task{
		TaskID: "task-trailing",
		Status: "pending",
		JSON:   json.RawMessage(`{"priority":"low"}{"unexpected":true}`),
	}

	if got := task.DecodedJSON(); got != nil {
		t.Fatalf("expected nil for task JSON with trailing data, got %#v", got)
	}
}

func TestMediaObjectDecodedJSONInvalidatesWhenJSONChanges(t *testing.T) {
	obj := &models.MediaObject{
		ObjectID: "object-cache",
		JSON:     []byte(`{"bucket":"atlas-a"}`),
	}

	first := obj.GetBucket()
	if first == nil || *first != "atlas-a" {
		t.Fatalf("expected initial bucket atlas-a, got %#v", first)
	}

	obj.JSON = []byte(`{"bucket":"atlas-b"}`)
	second := obj.GetBucket()
	if second == nil || *second != "atlas-b" {
		t.Fatalf("expected updated bucket atlas-b after JSON reassignment, got %#v", second)
	}
}
