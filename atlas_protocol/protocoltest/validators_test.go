package protocoltest

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"

	protocol "github.com/the-drunken-coder/atlas/atlas_protocol/generated/go/atlasprotocol"
)

func TestEntityExamplesValidate(t *testing.T) {
	root := moduleRoot(t)
	assertExamplesValidate(t, filepath.Join(root, "examples", "entities"), protocol.ValidateEntityBlob)
}

func TestTaskExamplesValidate(t *testing.T) {
	root := moduleRoot(t)
	assertExamplesValidate(t, filepath.Join(root, "examples", "tasks"), protocol.ValidateTaskBlob)
}

func TestObjectExamplesValidate(t *testing.T) {
	root := moduleRoot(t)
	assertExamplesValidate(t, filepath.Join(root, "examples", "objects"), protocol.ValidateObjectBlob)
}

func TestEntityComponentKeys(t *testing.T) {
	valid := map[string]any{
		"components": map[string]any{
			"telemetry":    map[string]any{},
			"custom_notes": "free-form",
		},
	}
	if errors := protocol.ValidateEntityBlob(valid); len(errors) > 0 {
		t.Fatalf("ValidateEntityBlob(valid) errors = %v", errors)
	}

	invalid := map[string]any{
		"components": map[string]any{
			"geomtry": map[string]any{},
		},
	}
	assertErrorContains(t, protocol.ValidateEntityBlob(invalid), "geomtry")
}

func TestComponentValidationUnknownKeysAreSorted(t *testing.T) {
	entityErrors := protocol.ValidateEntityComponents(map[string]any{
		"z_unknown":   true,
		"a_unknown":   true,
		"custom_free": true,
	})
	wantEntityErrors := []string{"Unknown component 'a_unknown'", "Unknown component 'z_unknown'"}
	if !reflect.DeepEqual(entityErrors, wantEntityErrors) {
		t.Fatalf("ValidateEntityComponents unknown errors = %v, want %v", entityErrors, wantEntityErrors)
	}

	taskErrors := protocol.ValidateTaskComponents(map[string]any{
		"z_unknown":   true,
		"a_unknown":   true,
		"custom_free": true,
	})
	wantTaskErrors := []string{"Unknown component 'a_unknown'", "Unknown component 'z_unknown'"}
	if !reflect.DeepEqual(taskErrors, wantTaskErrors) {
		t.Fatalf("ValidateTaskComponents unknown errors = %v, want %v", taskErrors, wantTaskErrors)
	}
}

func TestTelemetryValidation(t *testing.T) {
	valid := map[string]any{
		"latitude":    40.7,
		"longitude":   -73.9,
		"altitude_m":  120.0,
		"speed_m_s":   8.2,
		"heading_deg": 165.0,
		"last_update": "2026-05-29T10:00:00Z",
	}
	if errors := protocol.ValidateTelemetryComponent(valid); len(errors) > 0 {
		t.Fatalf("ValidateTelemetryComponent(valid) errors = %v", errors)
	}

	tests := []struct {
		name      string
		telemetry map[string]any
		contains  []string
	}{
		{name: "latitude out of range", telemetry: map[string]any{"latitude": 91.0}, contains: []string{"latitude"}},
		{name: "longitude out of range", telemetry: map[string]any{"longitude": -181.0}, contains: []string{"longitude"}},
		{name: "non finite", telemetry: map[string]any{"speed_m_s": math.NaN()}, contains: []string{"speed_m_s"}},
		{name: "negative speed", telemetry: map[string]any{"speed_m_s": -1.0}, contains: []string{"speed_m_s"}},
		{name: "invalid heading", telemetry: map[string]any{"heading_deg": 360.0}, contains: []string{"heading_deg"}},
		{name: "invalid last_update", telemetry: map[string]any{"last_update": "not-a-date"}, contains: []string{"last_update"}},
		{name: "legacy alias rejected", telemetry: map[string]any{"speed_ms": 10.0}, contains: []string{"speed_ms"}},
		{name: "null rejected", telemetry: map[string]any{"latitude": nil}, contains: []string{"latitude"}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assertErrorsContainAll(t, protocol.ValidateTelemetryComponent(tt.telemetry), tt.contains...)
		})
	}
}

func TestGeometryValidation(t *testing.T) {
	validGeoJSON := map[string]any{
		"type":        "Polygon",
		"coordinates": []any{[]any{[]any{-74.0, 40.0}, []any{-73.0, 40.0}, []any{-73.0, 41.0}, []any{-74.0, 40.0}}},
	}
	if errors := protocol.ValidateGeometryComponent(validGeoJSON); len(errors) > 0 {
		t.Fatalf("ValidateGeometryComponent(valid GeoJSON) errors = %v", errors)
	}

	validAtlas := map[string]any{
		"point_lat": 40.7,
		"point_lng": -73.9,
		"radius_m":  25.0,
	}
	if errors := protocol.ValidateGeometryComponent(validAtlas); len(errors) > 0 {
		t.Fatalf("ValidateGeometryComponent(valid Atlas) errors = %v", errors)
	}

	tests := []struct {
		name     string
		geometry map[string]any
		contains []string
	}{
		{name: "bad longitude", geometry: map[string]any{"type": "Point", "coordinates": []any{181.0, 40.0}}, contains: []string{"coordinates"}},
		{name: "non finite", geometry: map[string]any{"type": "Point", "coordinates": []any{math.Inf(1), 40.0}}, contains: []string{"coordinates[0]"}},
		{name: "bad radius", geometry: map[string]any{"point_lat": 40.0, "point_lng": -73.0, "radius_m": 0.0}, contains: []string{"radius_m"}},
		{name: "point latitude requires longitude", geometry: map[string]any{"point_lat": 40.0}, contains: []string{"point_lng"}},
		{name: "radius requires point coordinates", geometry: map[string]any{"radius_m": 25.0}, contains: []string{"point_lat"}},
		{name: "partial GeoJSON", geometry: map[string]any{"type": "Point"}, contains: []string{"coordinates"}},
		{name: "empty", geometry: map[string]any{}, contains: []string{"type"}},
		{name: "unclosed polygon", geometry: map[string]any{"type": "Polygon", "coordinates": []any{[]any{[]any{0.0, 0.0}, []any{1.0, 0.0}, []any{1.0, 1.0}, []any{0.0, 1.0}}}}, contains: []string{"closed"}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assertErrorsContainAll(t, protocol.ValidateGeometryComponent(tt.geometry), tt.contains...)
		})
	}
}

func TestGeneratedJSONSchemaConstraints(t *testing.T) {
	root := moduleRoot(t)

	geometrySchema := readSchema(t, filepath.Join(root, "generated", "jsonschema", "components", "geometry.schema.json"))
	geometryDefs := schemaObject(t, geometrySchema["$defs"])
	geoJSONPosition := schemaObject(t, geometryDefs["#GeoJSONPosition"])
	assertSchemaNumber(t, geoJSONPosition, "minItems", 2)
	assertSchemaMissing(t, geoJSONPosition, "minLength")

	atlasPosition := schemaObject(t, geometryDefs["#AtlasPosition"])
	assertSchemaNumber(t, atlasPosition, "minItems", 2)
	assertSchemaNumber(t, atlasPosition, "maxItems", 2)
	assertSchemaMissing(t, atlasPosition, "minLength")
	assertSchemaMissing(t, atlasPosition, "maxLength")

	atlasGeometry := schemaObject(t, geometryDefs["#AtlasGeometry"])
	assertSchemaNumber(t, atlasGeometry, "minProperties", 1)
	assertDependentRequired(t, atlasGeometry, "point_lat", "point_lng")
	assertDependentRequired(t, atlasGeometry, "point_lng", "point_lat")
	assertDependentRequired(t, atlasGeometry, "radius_m", "point_lat", "point_lng")

	objectReferenceSchema := readSchema(t, filepath.Join(root, "generated", "jsonschema", "components", "object-reference.schema.json"))
	assertSchemaNumber(t, objectReferenceSchema, "minProperties", 1)

	objectSchema := readSchema(t, filepath.Join(root, "generated", "jsonschema", "object.schema.json"))
	objectDefs := schemaObject(t, objectSchema["$defs"])
	objectReferenceDef := schemaObject(t, objectDefs["#ObjectReference"])
	assertSchemaNumber(t, objectReferenceDef, "minProperties", 1)
	objectProps := schemaObject(t, objectSchema["properties"])
	sizeBytes := schemaObject(t, objectProps["size_bytes"])
	if got, want := sizeBytes["type"], "integer"; got != want {
		t.Fatalf("object size_bytes type = %v, want %s", got, want)
	}

	entitySchema := readSchema(t, filepath.Join(root, "generated", "jsonschema", "entity.schema.json"))
	entityDefs := schemaObject(t, entitySchema["$defs"])
	telemetryDef := schemaObject(t, entityDefs["#TelemetryComponent"])
	assertSchemaMissing(t, telemetryDef, "$ref")
	telemetryProps := schemaObject(t, telemetryDef["properties"])
	latitude := schemaObject(t, telemetryProps["latitude"])
	if got, want := latitude["$ref"], "#/$defs/%23Latitude"; got != want {
		t.Fatalf("telemetry latitude ref = %v, want %s", got, want)
	}
	healthDef := schemaObject(t, entityDefs["#HealthComponent"])
	assertSchemaMissing(t, healthDef, "$ref")
	healthProps := schemaObject(t, healthDef["properties"])
	batteryPercent := schemaObject(t, healthProps["battery_percent"])
	assertSchemaNumber(t, batteryPercent, "maximum", 100)
}

func TestEntityComponentPayloadValidation(t *testing.T) {
	valid := map[string]any{
		"task_catalog": map[string]any{
			"supported_tasks": []any{"move_to_location", "survey_grid"},
		},
		"health": map[string]any{
			"battery_percent": 76.0,
		},
		"mil_view": map[string]any{
			"classification": "friendly",
			"last_seen":      "2026-05-29T10:05:00Z",
		},
		"communications": map[string]any{
			"link_state": "connected",
		},
		"task_queue": map[string]any{
			"current_task_id": nil,
			"queued_task_ids": []any{"task-1"},
		},
		"status": map[string]any{
			"value":       "available",
			"last_update": "2026-05-29T10:05:00Z",
		},
		"heartbeat": map[string]any{
			"last_seen": "2026-05-29T10:05:00Z",
		},
		"media_refs": []any{
			map[string]any{"object_id": "obj-1", "role": "thumbnail"},
		},
		"sensor_refs": []any{
			map[string]any{
				"sensor_id":              "sensor-1",
				"type":                   "radar",
				"horizontal_fov":         90.0,
				"vertical_fov":           60.0,
				"horizontal_orientation": 45.0,
				"vertical_orientation":   10.0,
			},
		},
	}
	if errors := protocol.ValidateEntityComponents(valid); len(errors) > 0 {
		t.Fatalf("ValidateEntityComponents(valid) errors = %v", errors)
	}

	tests := []struct {
		name       string
		components map[string]any
		contains   string
	}{
		{name: "bad task catalog", components: map[string]any{"task_catalog": map[string]any{"supported_tasks": []any{"move", ""}}}, contains: "task_catalog.supported_tasks.1"},
		{name: "bad health", components: map[string]any{"health": map[string]any{"battery_percent": 101.0}}, contains: "health.battery_percent"},
		{name: "null health battery", components: map[string]any{"health": map[string]any{"battery_percent": nil}}, contains: "health.battery_percent"},
		{name: "bad classification", components: map[string]any{"mil_view": map[string]any{"classification": "enemy"}}, contains: "mil_view.classification"},
		{name: "null classification", components: map[string]any{"mil_view": map[string]any{"classification": nil}}, contains: "mil_view.classification"},
		{name: "null last seen", components: map[string]any{"mil_view": map[string]any{"last_seen": nil}}, contains: "mil_view.last_seen"},
		{name: "bad link state", components: map[string]any{"communications": map[string]any{"link_state": "offline"}}, contains: "communications.link_state"},
		{name: "null link state", components: map[string]any{"communications": map[string]any{"link_state": nil}}, contains: "communications.link_state"},
		{name: "bad queue id", components: map[string]any{"task_queue": map[string]any{"current_task_id": " "}}, contains: "task_queue.current_task_id"},
		{name: "null queued task ids", components: map[string]any{"task_queue": map[string]any{"queued_task_ids": nil}}, contains: "task_queue.queued_task_ids"},
		{name: "bad status", components: map[string]any{"status": map[string]any{"value": ""}}, contains: "status.value"},
		{name: "bad heartbeat", components: map[string]any{"heartbeat": map[string]any{}}, contains: "heartbeat.last_seen"},
		{name: "bad media role", components: map[string]any{"media_refs": []any{map[string]any{"object_id": "obj-1", "role": "bad"}}}, contains: "media_refs.0.role"},
		{name: "legacy sensor alias rejected", components: map[string]any{"sensor_refs": []any{map[string]any{"sensor_id": "sensor-1", "type": "radar", "fov_horizontal": 90.0}}}, contains: "fov_horizontal"},
		{name: "null sensor number", components: map[string]any{"sensor_refs": []any{map[string]any{"sensor_id": "sensor-1", "type": "radar", "horizontal_fov": nil}}}, contains: "sensor_refs.0.horizontal_fov"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assertErrorContains(t, protocol.ValidateEntityComponents(tt.components), tt.contains)
		})
	}
}

func TestTaskValidation(t *testing.T) {
	valid := map[string]any{
		"command": map[string]any{"type": "move_to_location"},
		"parameters": map[string]any{
			"latitude":   40.7,
			"longitude":  -73.9,
			"altitude_m": 120,
		},
		"progress": map[string]any{
			"percent":       75.5,
			"updated_at":    "2026-05-29T10:00:00Z",
			"status_detail": "en route",
		},
		"custom_note": "operator supplied",
	}
	if errors := protocol.ValidateTaskComponents(valid); len(errors) > 0 {
		t.Fatalf("ValidateTaskComponents(valid) errors = %v", errors)
	}

	tests := []struct {
		name       string
		components map[string]any
		contains   []string
	}{
		{name: "legacy command string rejected", components: map[string]any{"command": "legacy"}, contains: []string{"command"}},
		{name: "unknown key", components: map[string]any{"unknown": true}, contains: []string{"Unknown component 'unknown'"}},
		{name: "missing command type", components: map[string]any{"command": map[string]any{}}, contains: []string{"command.type"}},
		{name: "empty command type", components: map[string]any{"command": map[string]any{"type": "   "}}, contains: []string{"command.type"}},
		{name: "bad parameters latitude", components: map[string]any{"parameters": map[string]any{"latitude": 91.0}}, contains: []string{"parameters.latitude"}},
		{name: "bad progress percent", components: map[string]any{"progress": map[string]any{"percent": 101.0}}, contains: []string{"progress.percent"}},
		{name: "bad progress timestamp", components: map[string]any{"progress": map[string]any{"updated_at": "not-a-date"}}, contains: []string{"progress.updated_at"}},
		{name: "bad status message", components: map[string]any{"status_message": 123}, contains: []string{"status_message"}},
		{name: "null status message", components: map[string]any{"status_message": nil}, contains: []string{"status_message"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assertErrorsContainAll(t, protocol.ValidateTaskComponents(tt.components), tt.contains...)
		})
	}
}

func TestObjectValidation(t *testing.T) {
	valid := map[string]any{
		"bucket":     "atlas-media",
		"size_bytes": 2048,
		"usage_hints": []any{
			"camera_feed",
			"thumbnail",
		},
		"referenced_by": []any{
			map[string]any{"entity_id": "entity-1"},
			map[string]any{"task_id": "task-1"},
			map[string]any{"entity_id": "entity-2", "task_id": "task-2"},
		},
		"checksum": "sha256:test",
	}
	if errors := protocol.ValidateObjectBlob(valid); len(errors) > 0 {
		t.Fatalf("ValidateObjectBlob(valid) errors = %v", errors)
	}

	tests := []struct {
		name     string
		blob     map[string]any
		contains []string
	}{
		{name: "bad size", blob: map[string]any{"size_bytes": -1}, contains: []string{"size_bytes"}},
		{name: "fractional size", blob: map[string]any{"size_bytes": 1.5}, contains: []string{"size_bytes"}},
		{name: "usage hints not array", blob: map[string]any{"usage_hints": "camera_feed"}, contains: []string{"usage_hints"}},
		{name: "empty usage hint", blob: map[string]any{"usage_hints": []any{""}}, contains: []string{"usage_hints"}},
		{name: "references not array", blob: map[string]any{"referenced_by": "entity-1"}, contains: []string{"referenced_by"}},
		{name: "reference not object", blob: map[string]any{"referenced_by": []any{"entity-1"}}, contains: []string{"referenced_by.0"}},
		{name: "reference missing ids", blob: map[string]any{"referenced_by": []any{map[string]any{}}}, contains: []string{"referenced_by.0"}},
		{name: "reference blank id", blob: map[string]any{"referenced_by": []any{map[string]any{"entity_id": " "}}}, contains: []string{"referenced_by"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assertErrorsContainAll(t, protocol.ValidateObjectBlob(tt.blob), tt.contains...)
		})
	}
}

func TestRawJSONValidatorsRejectTrailingValues(t *testing.T) {
	tests := []struct {
		name     string
		raw      json.RawMessage
		validate func(any) []string
		contains string
	}{
		{
			name:     "entity",
			raw:      json.RawMessage(`{"components":{}}{"extra":true}`),
			validate: protocol.ValidateEntityBlob,
			contains: "trailing JSON value",
		},
		{
			name:     "task",
			raw:      json.RawMessage(`{"components":{}}{"extra":true}`),
			validate: protocol.ValidateTaskBlob,
			contains: "trailing JSON value",
		},
		{
			name:     "object",
			raw:      json.RawMessage(`{"size_bytes":1}{"bad":true}`),
			validate: protocol.ValidateObjectBlob,
			contains: "trailing JSON value",
		},
		{
			name:     "array component",
			raw:      json.RawMessage(`[{"object_id":"object-1","role":"thumbnail"}][]`),
			validate: protocol.ValidateMediaRefsComponent,
			contains: "trailing JSON value",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assertErrorContains(t, tt.validate(tt.raw), tt.contains)
		})
	}
}

func moduleRoot(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(file), ".."))
}

func assertExamplesValidate(t *testing.T, dir string, validate func(any) []string) {
	t.Helper()
	examples, err := filepath.Glob(filepath.Join(dir, "*.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(examples) == 0 {
		t.Fatalf("expected examples in %s", dir)
	}

	for _, example := range examples {
		t.Run(filepath.Base(example), func(t *testing.T) {
			data, err := os.ReadFile(example)
			if err != nil {
				t.Fatal(err)
			}
			if errors := validate(json.RawMessage(data)); len(errors) > 0 {
				t.Fatalf("validate() errors = %v", errors)
			}
		})
	}
}

func readSchema(t *testing.T, path string) map[string]any {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var schema map[string]any
	if err := json.Unmarshal(data, &schema); err != nil {
		t.Fatal(err)
	}
	return schema
}

func schemaObject(t *testing.T, value any) map[string]any {
	t.Helper()
	object, ok := value.(map[string]any)
	if !ok {
		t.Fatalf("expected schema object, got %T", value)
	}
	return object
}

func assertSchemaNumber(t *testing.T, schema map[string]any, key string, want float64) {
	t.Helper()
	got, ok := schema[key].(float64)
	if !ok {
		t.Fatalf("schema[%q] = %T, want number", key, schema[key])
	}
	if got != want {
		t.Fatalf("schema[%q] = %v, want %v", key, got, want)
	}
}

func assertSchemaMissing(t *testing.T, schema map[string]any, key string) {
	t.Helper()
	if _, ok := schema[key]; ok {
		t.Fatalf("schema[%q] should be absent, got %v", key, schema[key])
	}
}

func assertDependentRequired(t *testing.T, schema map[string]any, key string, want ...string) {
	t.Helper()
	dependencies := schemaObject(t, schema["dependentRequired"])
	rawItems, ok := dependencies[key].([]any)
	if !ok {
		t.Fatalf("dependentRequired[%q] = %T, want array", key, dependencies[key])
	}
	if len(rawItems) != len(want) {
		t.Fatalf("dependentRequired[%q] = %v, want %v", key, rawItems, want)
	}
	for i, rawItem := range rawItems {
		item, ok := rawItem.(string)
		if !ok || item != want[i] {
			t.Fatalf("dependentRequired[%q][%d] = %v, want %q", key, i, rawItem, want[i])
		}
	}
}

func assertErrorContains(t *testing.T, errors []string, want string) {
	t.Helper()
	for _, err := range errors {
		if strings.Contains(err, want) {
			return
		}
	}
	t.Fatalf("expected error containing %q, got %v", want, errors)
}

func assertErrorsContainAll(t *testing.T, errors []string, want ...string) {
	t.Helper()
	if len(errors) == 0 {
		t.Fatalf("expected validation errors containing %v, got none", want)
	}
	joined := strings.Join(errors, "\n")
	for _, fragment := range want {
		if !strings.Contains(joined, fragment) {
			t.Fatalf("expected errors containing %q, got %v", fragment, errors)
		}
	}
}
