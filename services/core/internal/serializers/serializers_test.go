package serializers_test

import (
	"bytes"
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/rs/zerolog"
	"github.com/rs/zerolog/log"
	"github.com/the-drunken-coder/atlas/services/core/internal/models"
	"github.com/the-drunken-coder/atlas/services/core/internal/serializers"
	protocol "github.com/the-drunken-coder/atlas/packages/protocol/generated/go/atlasprotocol"
)

var serializerLogMu sync.Mutex

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
		"version":     999,
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
		Version:   77,
	}

	result := serializers.SerializeEntity(entity)

	if result.EntityID != "entity-1" {
		t.Errorf("Expected EntityID entity-1, got %s", result.EntityID)
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
	if _, ok := result.Extra["version"]; ok {
		t.Error("Expected blob version to be excluded from Extra")
	}
	if result.Metadata.CreatedAt == "" {
		t.Error("Expected CreatedAt to be set")
	}
	if result.Metadata.Version != 77 {
		t.Errorf("Expected metadata version 77, got %d", result.Metadata.Version)
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

func TestSerializeTaskUsesFlatProtocolResource(t *testing.T) {
	now := time.Date(2026, 8, 19, 12, 0, 0, 0, time.UTC)
	progress := 0.4
	task := &models.Task{
		TaskID: "task-1", AssetID: "asset-1", Command: "fixture.queued",
		Input: []byte(`{"value":1}`), Status: "in_progress", Progress: &progress,
		CreatedAt: now, AcknowledgedAt: &now, StartedAt: &now, UpdatedAt: now, Version: 7,
	}
	result := serializers.SerializeTask(task)
	if result.TaskID != task.TaskID || result.AssetID != task.AssetID || result.Command != task.Command || result.Status != protocol.TaskStatusInProgress {
		t.Fatalf("SerializeTask = %#v", result)
	}
	if result.Progress == nil || *result.Progress != progress {
		t.Fatalf("progress = %#v", result.Progress)
	}
	if errors := protocol.ValidateTaskResource(result); len(errors) > 0 {
		t.Fatalf("serialized Task failed Protocol validation: %v", errors)
	}
}

func TestSerializeTaskPreservesExplicitNullOutput(t *testing.T) {
	now := time.Date(2026, 8, 20, 0, 0, 0, 0, time.UTC)
	result := serializers.SerializeTask(&models.Task{
		TaskID: "task-null", AssetID: "asset-1", Command: "fixture.null",
		Input: []byte(`{}`), Output: []byte(`null`), Status: "completed",
		CreatedAt: now, UpdatedAt: now, Version: 1,
	})
	if result.Output == nil || *result.Output != nil {
		t.Fatalf("explicit null output = %#v", result.Output)
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(encoded, []byte(`"output":null`)) {
		t.Fatalf("serialized Task omitted explicit null output: %s", encoded)
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
		"custom":  "value",
		"version": 999,
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
		Version:     99,
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
	if result.ReferencedBy[0].EntityID == nil || *result.ReferencedBy[0].EntityID != "entity-1" {
		t.Errorf("Expected first referenced_by entity_id entity-1, got %#v", result.ReferencedBy[0])
	}
	if result.ReferencedBy[1].TaskID == nil || *result.ReferencedBy[1].TaskID != "task-1" {
		t.Errorf("Expected second referenced_by task_id task-1, got %#v", result.ReferencedBy[1])
	}
	if result.Extra == nil || result.Extra["custom"] != "value" {
		t.Errorf("Expected Extra custom value, got %#v", result.Extra)
	}
	if result.Extra["version"] != nil {
		t.Error("Expected blob version to be excluded from Extra")
	}
	if result.Metadata.Version != 99 {
		t.Errorf("Expected metadata version 99, got %d", result.Metadata.Version)
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("marshal object detail: %v", err)
	}
	if bytes.Contains(encoded, []byte(`"payload"`)) || !bytes.Contains(encoded, []byte(`"extra"`)) {
		t.Fatalf("object detail contract = %s, want extra without payload", encoded)
	}
}

func TestSerializeObjectReferencedByJSONUsesProtocolShape(t *testing.T) {
	now := time.Now().UTC()
	obj := &models.MediaObject{
		ObjectID: "obj-reference-json",
		JSON: json.RawMessage(`{
			"usage_hints": [],
			"referenced_by": [
				{"entity_id": "entity-1", "extra": "ignored"},
				{"task_id": "task-1", "role": "ignored"}
			]
		}`),
		CreatedAt: now,
		UpdatedAt: now,
	}

	encoded, err := json.Marshal(serializers.SerializeObject(obj))
	if err != nil {
		t.Fatalf("marshal object response: %v", err)
	}
	var response struct {
		ReferencedBy []map[string]any `json:"referenced_by"`
	}
	if err := json.Unmarshal(encoded, &response); err != nil {
		t.Fatalf("decode object response: %v", err)
	}
	if len(response.ReferencedBy) != 2 {
		t.Fatalf("referenced_by length = %d, want 2", len(response.ReferencedBy))
	}
	if response.ReferencedBy[0]["entity_id"] != "entity-1" || response.ReferencedBy[0]["extra"] != nil {
		t.Fatalf("first reference JSON = %#v, want only entity_id", response.ReferencedBy[0])
	}
	if response.ReferencedBy[1]["task_id"] != "task-1" || response.ReferencedBy[1]["role"] != nil {
		t.Fatalf("second reference JSON = %#v, want only task_id", response.ReferencedBy[1])
	}
}

func TestSerializeObjectUsesModelSizeParsing(t *testing.T) {
	now := time.Now().UTC()
	obj := &models.MediaObject{
		ObjectID:  "obj-large",
		JSON:      json.RawMessage(`{"size_bytes":9007199254740993}`),
		CreatedAt: now,
		UpdatedAt: now,
	}

	detail := serializers.SerializeObject(obj)
	if detail.SizeBytes == nil || *detail.SizeBytes != 9007199254740993 {
		t.Fatalf("detail size_bytes = %v, want exact large integer", detail.SizeBytes)
	}

	list := serializers.SerializeObjectForList(obj)
	if list.SizeBytes == nil || *list.SizeBytes != 9007199254740993 {
		t.Fatalf("list size_bytes = %v, want exact large integer", list.SizeBytes)
	}
}

func TestSerializeObjectForFeedTransformsObjectReferences(t *testing.T) {
	var logs bytes.Buffer

	now := time.Now().UTC()
	obj := &models.MediaObject{
		ObjectID: "object-feed-refs",
		JSON: json.RawMessage(`{
			"usage_hints": [],
			"referenced_by": [
				{"entity_id": " entity-1 "},
				{"task_id": "task-1"},
				{"entity_id": "entity-2", "task_id": "task-2"},
				{"entity_id": "entity-3", "task_id": ""},
				{},
				{"entity_id": ""},
				{"task_id": " "},
				{"entity_id": null},
				{"entity_id": null, "task_id": null},
				{"entity_id": 42}
			]
		}`),
		CreatedAt: now,
		UpdatedAt: now,
	}

	var result *protocol.ObjectResource
	var logOutput string
	func() {
		serializerLogMu.Lock()
		defer serializerLogMu.Unlock()
		previousLogger := log.Logger
		log.Logger = zerolog.New(&logs)
		defer func() {
			log.Logger = previousLogger
		}()

		result = serializers.SerializeObjectForFeed(obj)
		logOutput = logs.String()
	}()
	if result == nil {
		t.Fatal("SerializeObjectForFeed returned nil")
	}
	if len(result.ReferencedBy) != 4 {
		t.Fatalf("ReferencedBy length = %d, want 4", len(result.ReferencedBy))
	}
	if result.ReferencedBy[0].EntityID == nil || *result.ReferencedBy[0].EntityID != "entity-1" {
		t.Fatalf("first reference entity_id = %#v, want entity-1", result.ReferencedBy[0].EntityID)
	}
	if result.ReferencedBy[1].TaskID == nil || *result.ReferencedBy[1].TaskID != "task-1" {
		t.Fatalf("second reference task_id = %#v, want task-1", result.ReferencedBy[1].TaskID)
	}
	if result.ReferencedBy[2].EntityID == nil || result.ReferencedBy[2].TaskID == nil {
		t.Fatalf("third reference should include both IDs: %#v", result.ReferencedBy[2])
	}
	if *result.ReferencedBy[2].EntityID != "entity-2" || *result.ReferencedBy[2].TaskID != "task-2" {
		t.Fatalf("third reference = %#v, want entity-2/task-2", result.ReferencedBy[2])
	}
	if result.ReferencedBy[3].EntityID == nil || *result.ReferencedBy[3].EntityID != "entity-3" || result.ReferencedBy[3].TaskID != nil {
		t.Fatalf("fourth reference should include only entity_id: %#v", result.ReferencedBy[3])
	}
	if strings.Count(logOutput, `"level":"warn"`) != 1 {
		t.Fatalf("expected one warning log for the non-string reference field, got %q", logOutput)
	}
	if !strings.Contains(logOutput, "Dropping object feed reference field with non-string id") {
		t.Fatalf("expected non-string reference-field warning, got %q", logOutput)
	}
	if !strings.Contains(logOutput, `"key":"entity_id"`) || !hasNonStringNumericReferenceType(logOutput) {
		t.Fatalf("expected non-string warning to include key and type, got %q", logOutput)
	}
	if strings.Count(logOutput, "object-feed-refs") != 1 {
		t.Fatalf("expected non-string reference log to include object id once, got %q", logOutput)
	}
}

func hasNonStringNumericReferenceType(logOutput string) bool {
	return strings.Contains(logOutput, `"actual_type":"json.Number"`) ||
		strings.Contains(logOutput, `"actual_type":"float64"`) ||
		strings.Contains(logOutput, `"actual_type":"int"`) ||
		strings.Contains(logOutput, `"actual_type":"int64"`)
}

func TestSerializeObjectForFeedPopulatesObjectResourceFields(t *testing.T) {
	now := time.Now().UTC()
	path := "objects/feed-test"
	contentType := "application/json"
	objectType := "data"
	obj := &models.MediaObject{
		ObjectID:    "feed-object-full",
		Path:        &path,
		ContentType: &contentType,
		Type:        &objectType,
		JSON:        json.RawMessage(`{"size_bytes":2048,"bucket":"feed-bucket","usage_hints":["export","thumbnail"]}`),
		CreatedAt:   now,
		UpdatedAt:   now.Add(time.Minute),
		Version:     42,
	}

	result := serializers.SerializeObjectForFeed(obj)
	if result == nil {
		t.Fatal("SerializeObjectForFeed returned nil")
	}
	if result.ObjectID != "feed-object-full" {
		t.Fatalf("ObjectID = %q, want feed-object-full", result.ObjectID)
	}
	if result.Path == nil || *result.Path != path {
		t.Fatalf("Path = %#v, want %q", result.Path, path)
	}
	if result.ContentType == nil || *result.ContentType != contentType {
		t.Fatalf("ContentType = %#v, want %q", result.ContentType, contentType)
	}
	if result.Type == nil || *result.Type != objectType {
		t.Fatalf("Type = %#v, want %q", result.Type, objectType)
	}
	if result.SizeBytes == nil || *result.SizeBytes != 2048 {
		t.Fatalf("SizeBytes = %#v, want 2048", result.SizeBytes)
	}
	if len(result.UsageHints) != 2 || result.UsageHints[0] != "export" || result.UsageHints[1] != "thumbnail" {
		t.Fatalf("UsageHints = %#v, want export/thumbnail", result.UsageHints)
	}
	if result.Bucket == nil || *result.Bucket != "feed-bucket" {
		t.Fatalf("Bucket = %#v, want feed-bucket", result.Bucket)
	}
	if result.Metadata.CreatedAt != now.UTC().Format(serializers.APIMetadataTimeLayout) {
		t.Fatalf("Metadata.CreatedAt = %q", result.Metadata.CreatedAt)
	}
	if result.Metadata.UpdatedAt != now.Add(time.Minute).UTC().Format(serializers.APIMetadataTimeLayout) {
		t.Fatalf("Metadata.UpdatedAt = %q", result.Metadata.UpdatedAt)
	}
	if result.Metadata.Version != 42 {
		t.Fatalf("Metadata.Version = %d, want 42", result.Metadata.Version)
	}
}

func TestSerializeObjectForFeedOmitsEmptyObjectReferences(t *testing.T) {
	now := time.Now().UTC()
	obj := &models.MediaObject{
		ObjectID:  "object-no-feed-refs",
		JSON:      json.RawMessage(`{"usage_hints":[],"referenced_by":[{},{"entity_id":""}]}`),
		CreatedAt: now,
		UpdatedAt: now,
	}

	result := serializers.SerializeObjectForFeed(obj)
	if result == nil {
		t.Fatal("SerializeObjectForFeed returned nil")
	}
	if result.ReferencedBy != nil {
		t.Fatalf("ReferencedBy = %#v, want nil", result.ReferencedBy)
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
	if serializers.SerializeObjectForFeed(nil) != nil {
		t.Error("Expected nil for nil feed object")
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

func TestSerializeEntityDoesNotEmitDuplicateTypeField(t *testing.T) {
	now := time.Now().UTC()
	entity := &models.Entity{
		EntityID:  "entity-no-duplicate-type",
		Type:      "asset",
		JSON:      []byte("{}"),
		CreatedAt: now,
		UpdatedAt: now,
	}

	encoded, err := json.Marshal(serializers.SerializeEntity(entity))
	if err != nil {
		t.Fatalf("marshal entity response: %v", err)
	}

	var response map[string]interface{}
	if err := json.Unmarshal(encoded, &response); err != nil {
		t.Fatalf("decode entity response: %v", err)
	}
	if response["entity_type"] != "asset" {
		t.Fatalf("expected entity_type asset, got %#v", response["entity_type"])
	}
	if _, ok := response["type"]; ok {
		t.Fatalf("entity response should not include duplicate type field: %s", string(encoded))
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
	if result.Extra == nil {
		t.Error("Expected Extra to be an empty object")
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
	if result.Extra == nil {
		t.Error("Expected Extra to be an empty object")
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

func TestSerializeObjects(t *testing.T) {
	now := time.Now().UTC()
	objects := []*models.MediaObject{
		{ObjectID: "o1", CreatedAt: now, UpdatedAt: now},
		{ObjectID: "o2", CreatedAt: now, UpdatedAt: now},
	}

	result := serializers.SerializeObjects(objects)

	if len(result) != 2 {
		t.Fatalf("Expected 2 results, got %d", len(result))
	}
	if result[0].ObjectID != "o1" || result[1].ObjectID != "o2" {
		t.Errorf("Expected object IDs o1,o2, got %s,%s", result[0].ObjectID, result[1].ObjectID)
	}

	empty := serializers.SerializeObjects(nil)
	if empty == nil || len(empty) != 0 {
		t.Errorf("Expected empty non-nil slice for nil input, got %#v", empty)
	}
}

func TestSerializeObjectsForList(t *testing.T) {
	now := time.Now().UTC()
	objects := []*models.MediaObject{
		{ObjectID: "o1", CreatedAt: now, UpdatedAt: now},
		{ObjectID: "o2", CreatedAt: now, UpdatedAt: now},
	}

	result := serializers.SerializeObjectsForList(objects)

	if len(result) != 2 {
		t.Fatalf("Expected 2 results, got %d", len(result))
	}
	if result[0].ObjectID != "o1" || result[1].ObjectID != "o2" {
		t.Errorf("Expected object IDs o1,o2, got %s,%s", result[0].ObjectID, result[1].ObjectID)
	}

	empty := serializers.SerializeObjectsForList(nil)
	if empty == nil || len(empty) != 0 {
		t.Errorf("Expected empty non-nil slice for nil input, got %#v", empty)
	}
}

func TestSerializedResourcesConformToAtlasProtocol(t *testing.T) {
	now := time.Date(2026, 8, 10, 12, 0, 0, 0, time.UTC)
	tests := []struct {
		name     string
		value    any
		validate func(any) []string
	}{
		{
			name:     "entity",
			value:    serializers.SerializeEntity(&models.Entity{EntityID: "entity-1", Type: "asset", CreatedAt: now, UpdatedAt: now, Version: 1}),
			validate: protocol.ValidateEntityResource,
		},
		{
			name:     "task",
			value:    serializers.SerializeTask(&models.Task{TaskID: "task-1", AssetID: "asset-1", Command: "fixture.immediate", Input: []byte(`{}`), Status: "pending", CreatedAt: now, UpdatedAt: now, Version: 1}),
			validate: protocol.ValidateTaskResource,
		},
		{
			name:     "object detail",
			value:    serializers.SerializeObject(&models.MediaObject{ObjectID: "object-1", CreatedAt: now, UpdatedAt: now, Version: 1}),
			validate: protocol.ValidateObjectDetailResource,
		},
		{
			name:     "object list",
			value:    serializers.SerializeObjectForList(&models.MediaObject{ObjectID: "object-1", CreatedAt: now, UpdatedAt: now, Version: 1}),
			validate: protocol.ValidateObjectResource,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			encoded, err := json.Marshal(test.value)
			if err != nil {
				t.Fatal(err)
			}
			if validationErrors := test.validate(json.RawMessage(encoded)); len(validationErrors) > 0 {
				t.Fatalf("serialized resource failed Protocol validation: %v\n%s", validationErrors, encoded)
			}
		})
	}
}
