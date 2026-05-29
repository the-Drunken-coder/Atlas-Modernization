package serializers_test

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/the-drunken-coder/atlas/atlas_core/internal/models"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/serializers"
)

func TestSerializeEntity(t *testing.T) {
	now := time.Now().UTC()
	subtype := "drone"
	alias := "test-drone"

	jsonData := map[string]interface{}{
		"components": map[string]interface{}{
			"telemetry": map[string]interface{}{
				"latitude":  40.7128,
				"longitude": -74.0060,
			},
		},
		"extra_field": "extra_value",
	}
	jsonBytes, _ := json.Marshal(jsonData)

	entity := &models.Entity{
		EntityID:  "entity-1",
		Type:      "asset",
		Subtype:   &subtype,
		Alias:     &alias,
		JSON:      jsonBytes,
		CreatedAt: now,
		UpdatedAt: now,
	}

	result := serializers.SerializeEntity(entity)

	if result.EntityID != "entity-1" {
		t.Errorf("Expected EntityID entity-1, got %s", result.EntityID)
	}
	if result.Type != "asset" {
		t.Errorf("Expected Type asset, got %s", result.Type)
	}
	if result.EntityType != "asset" {
		t.Errorf("Expected EntityType asset, got %s", result.EntityType)
	}
	if result.Subtype == nil {
		t.Fatal("Expected Subtype to be non-nil")
	}
	if result.Alias == nil {
		t.Fatal("Expected Alias to be non-nil")
	}
	if *result.Subtype != "drone" {
		t.Errorf("Expected Subtype drone, got %s", *result.Subtype)
	}
	if *result.Alias != "test-drone" {
		t.Errorf("Expected Alias test-drone, got %s", *result.Alias)
	}
	if result.Components == nil {
		t.Error("Expected Components to be set")
	}
	if result.Extra == nil {
		t.Error("Expected Extra to be set")
	}
	if result.Metadata.CreatedAt == "" {
		t.Error("Expected CreatedAt to be set")
	}
}

func TestSerializeEntityEmptyJSONUsesEmptyComponents(t *testing.T) {
	now := time.Now().UTC()
	entity := &models.Entity{
		EntityID:  "entity-empty-json",
		Type:      "asset",
		JSON:      []byte("{}"),
		CreatedAt: now,
		UpdatedAt: now,
	}
	result := serializers.SerializeEntity(entity)
	if result == nil {
		t.Fatal("expected non-nil response")
	}
	if result.Components == nil {
		t.Fatal("SerializeEntity must return non-nil components for empty JSON blob")
	}
	if len(result.Components) != 0 {
		t.Fatalf("expected empty components, got %d keys", len(result.Components))
	}
}

func TestSerializeTask(t *testing.T) {
	now := time.Now().UTC()
	entityID := "entity-1"

	jsonData := map[string]interface{}{
		"components": map[string]interface{}{
			"command": map[string]interface{}{
				"type": "move_to",
			},
		},
	}
	jsonBytes, _ := json.Marshal(jsonData)

	task := &models.Task{
		TaskID:    "task-1",
		Status:    "pending",
		EntityID:  &entityID,
		JSON:      jsonBytes,
		CreatedAt: now,
		UpdatedAt: now,
	}

	result := serializers.SerializeTask(task)

	if result.TaskID != "task-1" {
		t.Errorf("Expected TaskID task-1, got %s", result.TaskID)
	}
	if result.Status != "pending" {
		t.Errorf("Expected Status pending, got %s", result.Status)
	}
	if result.EntityID == nil {
		t.Fatalf("Expected EntityID to be set")
	}
	if *result.EntityID != "entity-1" {
		t.Errorf("Expected EntityID entity-1, got %s", *result.EntityID)
	}
	if result.Components == nil {
		t.Error("Expected Components to be set")
	}
}

func TestSerializeObject(t *testing.T) {
	now := time.Now().UTC()
	path := "objects/obj-1"
	contentType := "image/png"
	objType := "image"

	jsonData := map[string]interface{}{
		"size_bytes":  float64(1024),
		"bucket":      "atlas-media",
		"usage_hints": []interface{}{"thumbnail"},
		"referenced_by": []interface{}{
			map[string]interface{}{"entity_id": "entity-1"},
			map[string]interface{}{"task_id": "task-1"},
		},
	}
	jsonBytes, _ := json.Marshal(jsonData)

	obj := &models.MediaObject{
		ObjectID:    "obj-1",
		Path:        &path,
		ContentType: &contentType,
		Type:        &objType,
		JSON:        jsonBytes,
		CreatedAt:   now,
		UpdatedAt:   now,
	}

	result := serializers.SerializeObject(obj)

	if result.ObjectID != "obj-1" {
		t.Errorf("Expected ObjectID obj-1, got %s", result.ObjectID)
	}
	if result.Path == nil {
		t.Fatalf("Expected Path to be set")
	}
	if *result.Path != "objects/obj-1" {
		t.Errorf("Expected Path objects/obj-1, got %s", *result.Path)
	}
	if result.ContentType == nil {
		t.Fatalf("Expected ContentType to be set")
	}
	if *result.ContentType != "image/png" {
		t.Errorf("Expected ContentType image/png, got %s", *result.ContentType)
	}
	if result.SizeBytes == nil {
		t.Fatalf("Expected SizeBytes to be set")
	}
	if *result.SizeBytes != 1024 {
		t.Errorf("Expected SizeBytes 1024, got %d", *result.SizeBytes)
	}
	if len(result.UsageHints) != 1 || result.UsageHints[0] != "thumbnail" {
		t.Errorf("Expected UsageHints [thumbnail], got %v", result.UsageHints)
	}
	if len(result.ReferencedBy) != 2 {
		t.Fatalf("Expected 2 referenced_by entries, got %d", len(result.ReferencedBy))
	}
	if result.ReferencedBy[0]["entity_id"] != "entity-1" {
		t.Errorf("Expected first referenced_by entity_id entity-1, got %v", result.ReferencedBy[0]["entity_id"])
	}
	if result.ReferencedBy[1]["task_id"] != "task-1" {
		t.Errorf("Expected second referenced_by task_id task-1, got %v", result.ReferencedBy[1]["task_id"])
	}
}

func TestSerializeNil(t *testing.T) {
	if serializers.SerializeEntity(nil) != nil {
		t.Error("Expected nil for nil entity")
	}
	if serializers.SerializeTask(nil) != nil {
		t.Error("Expected nil for nil task")
	}
	if serializers.SerializeObject(nil) != nil {
		t.Error("Expected nil for nil object")
	}
}

func TestSerializeEntityWithNilJSON(t *testing.T) {
	now := time.Now().UTC()
	entity := &models.Entity{
		EntityID:  "entity-nil-json",
		Type:      "asset",
		Subtype:   nil,
		Alias:     nil,
		JSON:      nil, // nil JSON
		CreatedAt: now,
		UpdatedAt: now,
	}

	result := serializers.SerializeEntity(entity)

	if result.EntityID != "entity-nil-json" {
		t.Errorf("Expected EntityID entity-nil-json, got %s", result.EntityID)
	}
	if result.Type != "asset" {
		t.Errorf("Expected Type asset, got %s", result.Type)
	}
	if result.EntityType != "asset" {
		t.Errorf("Expected EntityType asset, got %s", result.EntityType)
	}
	if result.Subtype != nil {
		t.Error("Expected Subtype to be nil")
	}
	if result.Alias != nil {
		t.Error("Expected Alias to be nil")
	}
}

func TestSerializeEntityWithEmptyJSON(t *testing.T) {
	now := time.Now().UTC()
	entity := &models.Entity{
		EntityID:  "entity-empty-json",
		Type:      "track",
		JSON:      []byte("{}"), // empty JSON object
		CreatedAt: now,
		UpdatedAt: now,
	}

	result := serializers.SerializeEntity(entity)

	if result.EntityID != "entity-empty-json" {
		t.Errorf("Expected EntityID entity-empty-json, got %s", result.EntityID)
	}
	if result.Components == nil {
		t.Fatal("Expected Components to be non-nil (empty map) for empty JSON")
	}
	if len(result.Components) != 0 {
		t.Errorf("Expected Components to be empty for empty JSON, got %d keys", len(result.Components))
	}
}

func TestSerializeEntityWithMalformedJSON(t *testing.T) {
	now := time.Now().UTC()
	entity := &models.Entity{
		EntityID:  "entity-bad-json",
		Type:      "asset",
		JSON:      []byte("not valid json{{{"), // malformed JSON
		CreatedAt: now,
		UpdatedAt: now,
	}

	// Should not panic — components degrade to an empty map when JSON cannot be decoded.
	result := serializers.SerializeEntity(entity)

	if result.EntityID != "entity-bad-json" {
		t.Errorf("Expected EntityID entity-bad-json, got %s", result.EntityID)
	}
	if len(result.Components) != 0 {
		t.Errorf("Expected empty components map for malformed JSON, got %#v", result.Components)
	}
}

func TestSerializeTaskWithNilJSON(t *testing.T) {
	now := time.Now().UTC()
	task := &models.Task{
		TaskID:    "task-nil-json",
		Status:    "pending",
		EntityID:  nil, // nil entity reference
		JSON:      nil, // nil JSON
		CreatedAt: now,
		UpdatedAt: now,
	}

	result := serializers.SerializeTask(task)

	if result.TaskID != "task-nil-json" {
		t.Errorf("Expected TaskID task-nil-json, got %s", result.TaskID)
	}
	if result.Status != "pending" {
		t.Errorf("Expected Status pending, got %s", result.Status)
	}
	if result.EntityID != nil {
		t.Error("Expected EntityID to be nil")
	}
}

func TestSerializeTaskWithEmptyJSON(t *testing.T) {
	now := time.Now().UTC()
	task := &models.Task{
		TaskID:    "task-empty-json",
		Status:    "in_progress",
		JSON:      []byte("{}"), // empty JSON object
		CreatedAt: now,
		UpdatedAt: now,
	}

	result := serializers.SerializeTask(task)

	if result.TaskID != "task-empty-json" {
		t.Errorf("Expected TaskID task-empty-json, got %s", result.TaskID)
	}
	if result.Status != "in_progress" {
		t.Errorf("Expected Status in_progress, got %s", result.Status)
	}
	if result.Components == nil {
		t.Fatal("Expected Components non-nil (empty map)")
	}
	if len(result.Components) != 0 {
		t.Errorf("Expected empty components, got %d keys", len(result.Components))
	}
	if result.Metadata.CreatedAt == "" || result.Metadata.UpdatedAt == "" {
		t.Errorf("Expected metadata timestamps set, got created=%q updated=%q", result.Metadata.CreatedAt, result.Metadata.UpdatedAt)
	}
}

func TestSerializeTaskWithMalformedJSON(t *testing.T) {
	now := time.Now().UTC()
	task := &models.Task{
		TaskID:    "task-bad-json",
		Status:    "failed",
		JSON:      []byte("}{invalid"), // malformed JSON
		CreatedAt: now,
		UpdatedAt: now,
	}

	// Should not panic - should handle gracefully
	result := serializers.SerializeTask(task)

	if result.TaskID != "task-bad-json" {
		t.Errorf("Expected TaskID task-bad-json, got %s", result.TaskID)
	}
}

func TestSerializeObjectWithNilJSON(t *testing.T) {
	now := time.Now().UTC()
	obj := &models.MediaObject{
		ObjectID:    "obj-nil-json",
		Path:        nil, // nil path
		ContentType: nil, // nil content type
		Type:        nil, // nil type
		JSON:        nil, // nil JSON
		CreatedAt:   now,
		UpdatedAt:   now,
	}

	result := serializers.SerializeObject(obj)

	if result.ObjectID != "obj-nil-json" {
		t.Errorf("Expected ObjectID obj-nil-json, got %s", result.ObjectID)
	}
	if result.Path != nil {
		t.Error("Expected Path to be nil")
	}
	if result.ContentType != nil {
		t.Error("Expected ContentType to be nil")
	}
}

func TestSerializeObjectWithEmptyJSON(t *testing.T) {
	now := time.Now().UTC()
	obj := &models.MediaObject{
		ObjectID:  "obj-empty-json",
		JSON:      []byte("{}"), // empty JSON object
		CreatedAt: now,
		UpdatedAt: now,
	}

	result := serializers.SerializeObject(obj)

	if result.ObjectID != "obj-empty-json" {
		t.Errorf("Expected ObjectID obj-empty-json, got %s", result.ObjectID)
	}
	if result.Metadata.CreatedAt == "" || result.Metadata.UpdatedAt == "" {
		t.Errorf("Expected metadata timestamps set, got created=%q updated=%q", result.Metadata.CreatedAt, result.Metadata.UpdatedAt)
	}
}

func TestSerializeObjectWithMalformedJSON(t *testing.T) {
	now := time.Now().UTC()
	obj := &models.MediaObject{
		ObjectID:  "obj-bad-json",
		JSON:      []byte("malformed json data"), // malformed JSON
		CreatedAt: now,
		UpdatedAt: now,
	}

	// Should not panic - should handle gracefully
	result := serializers.SerializeObject(obj)

	if result.ObjectID != "obj-bad-json" {
		t.Errorf("Expected ObjectID obj-bad-json, got %s", result.ObjectID)
	}
}

func TestSerializeEntityWithMissingPromotedFields(t *testing.T) {
	now := time.Now().UTC()
	// JSON with no "components" key - just a random field
	jsonData := map[string]interface{}{
		"random_field": "some_value",
	}
	jsonBytes, _ := json.Marshal(jsonData)

	entity := &models.Entity{
		EntityID:  "entity-no-promoted",
		Type:      "asset",
		JSON:      jsonBytes,
		CreatedAt: now,
		UpdatedAt: now,
	}

	result := serializers.SerializeEntity(entity)

	if result.EntityID != "entity-no-promoted" {
		t.Errorf("Expected EntityID entity-no-promoted, got %s", result.EntityID)
	}
	// When there's no "components" key, GetComponents returns empty map (not nil)
	// This is intentional - serializer always ensures a valid map for consistent API responses
	if result.Components == nil {
		t.Error("Expected Components to be initialized (not nil)")
	}
	if len(result.Components) != 0 {
		t.Error("Expected Components to be empty when not present in JSON")
	}
}

func TestSerializeEntities(t *testing.T) {
	now := time.Now().UTC()
	entities := []*models.Entity{
		{EntityID: "e1", Type: "asset", CreatedAt: now, UpdatedAt: now},
		{EntityID: "e2", Type: "track", CreatedAt: now, UpdatedAt: now},
	}

	result := serializers.SerializeEntities(entities)

	if len(result) != 2 {
		t.Errorf("Expected 2 results, got %d", len(result))
	}
	if result[0].EntityID != "e1" {
		t.Errorf("Expected first entity ID e1, got %s", result[0].EntityID)
	}
	if result[1].EntityID != "e2" {
		t.Errorf("Expected second entity ID e2, got %s", result[1].EntityID)
	}
}
