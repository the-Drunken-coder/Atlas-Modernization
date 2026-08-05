package validator

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"reflect"
	"sort"
	"strings"
	"sync"
	"testing"

	"github.com/the-drunken-coder/atlas/atlas_protocol/conformance"
)

func TestSchemaLoadsFromEmbeddedFiles(t *testing.T) {
	telemetry := map[string]any{
		"latitude":  40.7,
		"longitude": -73.9,
	}
	if errors := ValidateTelemetryComponent(telemetry); len(errors) > 0 {
		t.Fatalf("ValidateTelemetryComponent(valid) errors = %v", errors)
	}
}

func TestValidateCommandCatalogIncludesSemanticRules(t *testing.T) {
	valid := map[string]any{
		"type":        "command_catalog",
		"name":        "Commands",
		"description": "Test catalog",
		"commands": []any{
			map[string]any{
				"id":          "set_speed",
				"name":        "Set Speed",
				"description": "Set speed.",
				"parameters_schema": map[string]any{
					"speed": map[string]any{"type": "number", "description": "Speed", "required": true, "minimum": 0.0, "maximum": 10.0},
				},
			},
		},
	}
	if errors := ValidateCommandCatalog(valid); len(errors) != 0 {
		t.Fatalf("ValidateCommandCatalog(valid) errors = %v", errors)
	}

	invalid := map[string]any{
		"type":        "command_catalog",
		"name":        "Commands",
		"description": "Test catalog",
		"commands": []any{
			map[string]any{
				"id": "duplicate", "name": "First", "description": "First.",
				"parameters_schema": map[string]any{
					"count": map[string]any{"type": "number", "description": "Count", "required": false, "minimum": 2, "maximum": 1},
					"label": map[string]any{"type": "string", "description": "Label", "required": false, "minimum": 1},
				},
			},
			map[string]any{"id": "duplicate", "name": "Second", "description": "Second.", "parameters_schema": map[string]any{}},
		},
	}
	errors := ValidateCommandCatalog(invalid)
	joined := strings.Join(errors, "\n")
	for _, want := range []string{"duplicate", "minimum exceeds maximum", "bounds require number type"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("ValidateCommandCatalog(invalid) errors = %v, want %q", errors, want)
		}
	}
}

func TestValidateCommandCatalogRejectsNonNumericBounds(t *testing.T) {
	invalid := map[string]any{
		"type": "command_catalog", "name": "Commands", "description": "Test catalog",
		"commands": []any{map[string]any{
			"id": "set_speed", "name": "Set Speed", "description": "Set speed.",
			"parameters_schema": map[string]any{
				"speed": map[string]any{"type": "number", "description": "Speed", "required": true, "minimum": "fast"},
			},
		}},
	}
	if errors := ValidateCommandCatalog(invalid); len(errors) == 0 {
		t.Fatal("expected a non-numeric minimum to be rejected")
	}
}

func TestValidateCommandCatalogComparesJSONNumberBounds(t *testing.T) {
	invalid := map[string]any{
		"type": "command_catalog", "name": "Commands", "description": "Test catalog",
		"commands": []any{map[string]any{
			"id": "set_speed", "name": "Set Speed", "description": "Set speed.",
			"parameters_schema": map[string]any{
				"speed": map[string]any{
					"type": "number", "description": "Speed", "required": true,
					"minimum": json.Number("10"), "maximum": json.Number("1"),
				},
			},
		}},
	}
	if errors := ValidateCommandCatalog(invalid); !strings.Contains(strings.Join(errors, "\n"), "minimum exceeds maximum") {
		t.Fatalf("ValidateCommandCatalog errors = %v, want reversed-bound error", errors)
	}
}

func TestConcurrentValidationIsSafe(t *testing.T) {
	const goroutines = 16
	results := make(chan []string, goroutines)

	var wg sync.WaitGroup
	for i := 0; i < goroutines; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			if i%2 == 0 {
				results <- ValidateTelemetryComponent(map[string]any{"latitude": 40.7})
				return
			}
			results <- ValidateTelemetryComponent(map[string]any{"latitude": 91.0})
		}(i)
	}
	wg.Wait()
	close(results)

	var valid, invalid int
	for errors := range results {
		if len(errors) == 0 {
			valid++
		} else {
			invalid++
		}
	}
	if valid != goroutines/2 || invalid != goroutines/2 {
		t.Fatalf("concurrent validation: valid = %d, invalid = %d, want %d each", valid, invalid, goroutines/2)
	}
}

func TestUnknownComponentValidationUsesSchemaFields(t *testing.T) {
	valid := map[string]any{
		"telemetry":    map[string]any{},
		"custom_notes": "operator supplied",
	}
	if errors := ValidateEntityComponents(valid); len(errors) > 0 {
		t.Fatalf("ValidateEntityComponents(valid schema/custom fields) errors = %v", errors)
	}

	errors := ValidateTaskComponents(map[string]any{
		"z_unknown": true,
		"a_unknown": true,
		"command":   map[string]any{"type": "move_to_location"},
	})
	want := []string{"Unknown component 'a_unknown'", "Unknown component 'z_unknown'"}
	if !reflect.DeepEqual(errors, want) {
		t.Fatalf("ValidateTaskComponents unknown errors = %v, want %v", errors, want)
	}
}

func TestNonFinitePaths(t *testing.T) {
	tests := []struct {
		name     string
		validate func(any) []string
		value    any
		want     string
	}{
		{
			name:     "nested map path",
			validate: ValidateEntityBlob,
			value: map[string]any{
				"components": map[string]any{
					"telemetry": map[string]any{"speed_m_s": math.NaN()},
				},
			},
			want: "components.telemetry.speed_m_s: must be finite",
		},
		{
			name:     "positive infinity inside slice",
			validate: ValidateGeometryComponent,
			value: map[string]any{
				"type":        "Point",
				"coordinates": []any{math.Inf(1), 40.0},
			},
			want: "coordinates[0]: must be finite",
		},
		{
			name:     "negative infinity in top-level slice",
			validate: ValidateMediaRefsComponent,
			value:    []any{map[string]any{"object_id": math.Inf(-1)}},
			want:     "[0].object_id: must be finite",
		},
		{
			name:     "bare non-finite value",
			validate: ValidateTelemetryComponent,
			value:    math.NaN(),
			want:     "value: must be finite",
		},
		{
			name:     "float32 NaN",
			validate: ValidateTelemetryComponent,
			value:    map[string]any{"latitude": float32(math.NaN())},
			want:     "latitude: must be finite",
		},
		{
			name:     "typed float slice",
			validate: ValidateGeometryComponent,
			value: map[string]any{
				"type":        "Point",
				"coordinates": []float64{math.Inf(1), 40.0},
			},
			want: "coordinates[0]: must be finite",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			errors := tt.validate(tt.value)
			if len(errors) != 1 {
				t.Fatalf("errors = %v, want exactly one", errors)
			}
			if errors[0] != tt.want {
				t.Fatalf("errors[0] = %q, want %q", errors[0], tt.want)
			}
		})
	}
}

func TestValidateTaskParametersComponentPrefixing(t *testing.T) {
	invalid := map[string]any{"latitude": 91.0}

	tests := []struct {
		name       string
		prefix     string
		wantPrefix string
	}{
		{name: "plain prefix", prefix: "parameters", wantPrefix: "parameters."},
		{name: "trailing dot trimmed", prefix: "parameters.", wantPrefix: "parameters."},
		{name: "whitespace-only prefix passthrough", prefix: "   ", wantPrefix: ""},
		{name: "empty prefix passthrough", prefix: "", wantPrefix: ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			errors := ValidateTaskParametersComponent(invalid, tt.prefix)
			if len(errors) == 0 {
				t.Fatal("expected errors for invalid latitude")
			}
			for _, message := range errors {
				if tt.wantPrefix != "" && !strings.HasPrefix(message, tt.wantPrefix) {
					t.Fatalf("error %q does not start with %q", message, tt.wantPrefix)
				}
				if tt.wantPrefix == "" && strings.HasPrefix(message, ".") {
					t.Fatalf("error %q has stray leading dot", message)
				}
				if !strings.Contains(message, "latitude") {
					t.Fatalf("error %q does not mention latitude", message)
				}
			}
		})
	}
}

func TestMultipleViolationsAreSorted(t *testing.T) {
	invalid := map[string]any{
		"latitude":  91.0,
		"longitude": -181.0,
	}
	errors := ValidateTelemetryComponent(invalid)
	if len(errors) < 2 {
		t.Fatalf("errors = %v, want at least two", errors)
	}
	if !sort.StringsAreSorted(errors) {
		t.Fatalf("errors are not sorted: %v", errors)
	}
	assertAnyContains(t, errors, "latitude")
	assertAnyContains(t, errors, "longitude")
}

func TestObjectBlobAcceptsTypedUsageHints(t *testing.T) {
	blob := map[string]any{
		"bucket":      "atlas-media",
		"size_bytes":  int64(7966),
		"usage_hints": []string{"mission_plan"},
	}
	if errors := ValidateObjectBlob(blob); len(errors) > 0 {
		t.Fatalf("ValidateObjectBlob(typed usage_hints) errors = %v", errors)
	}
}

func TestObjectBlobAcceptsJSONNumberSizeBytes(t *testing.T) {
	blob := map[string]any{
		"bucket":     "atlas-media",
		"size_bytes": json.Number("7966"),
		"usage_hints": []any{
			"mission_plan",
		},
	}
	if errors := ValidateObjectBlob(blob); len(errors) > 0 {
		t.Fatalf("ValidateObjectBlob(json.Number size_bytes) errors = %v", errors)
	}
}

func TestObjectBlobRejectsOversizedJSONNumberSizeBytes(t *testing.T) {
	blob := map[string]any{
		"size_bytes": json.Number("1e10000"),
	}
	errors := ValidateObjectBlob(blob)
	if len(errors) == 0 {
		t.Fatal("ValidateObjectBlob(oversized json.Number size_bytes) returned no errors")
	}
	assertAnyContains(t, errors, "size_bytes")
}

func TestObjectDetailResourceUsesExtraWithoutWideningFeedResources(t *testing.T) {
	detail := map[string]any{
		"object_id":    "object-1",
		"path":         nil,
		"content_type": nil,
		"type":         nil,
		"size_bytes":   nil,
		"usage_hints":  []any{},
		"bucket":       nil,
		"metadata": map[string]any{
			"created_at": "2026-07-13T12:00:00Z",
			"updated_at": "2026-07-13T12:01:00Z",
			"version":    1,
		},
		"extra": map[string]any{"source": "local import"},
	}
	if errors := ValidateObjectDetailResource(detail); len(errors) > 0 {
		t.Fatalf("ValidateObjectDetailResource(extra) errors = %v", errors)
	}
	if errors := ValidateObjectResource(detail); len(errors) == 0 {
		t.Fatal("ValidateObjectResource accepted full-detail extra")
	}

	missingExtra := make(map[string]any, len(detail)-1)
	for key, value := range detail {
		if key != "extra" {
			missingExtra[key] = value
		}
	}
	if errors := ValidateObjectDetailResource(missingExtra); len(errors) == 0 {
		t.Fatal("ValidateObjectDetailResource accepted missing required extra")
	}

	detail["payload"] = detail["extra"]
	delete(detail, "extra")
	if errors := ValidateObjectDetailResource(detail); len(errors) == 0 {
		t.Fatal("ValidateObjectDetailResource accepted legacy payload field")
	}
}

func TestRawJSONUsesJSONNumberNormalization(t *testing.T) {
	raw := json.RawMessage(`{"bucket":"atlas-media","size_bytes":7966}`)
	if errors := ValidateObjectBlob(raw); len(errors) > 0 {
		t.Fatalf("ValidateObjectBlob(raw JSON) errors = %v", errors)
	}
}

func TestRawJSONRejectsTrailingValues(t *testing.T) {
	errors := ValidateObjectBlob(json.RawMessage(`{"size_bytes":1}{"bad":true}`))
	if len(errors) != 1 {
		t.Fatalf("errors = %v, want exactly one", errors)
	}
	if !strings.Contains(errors[0], "trailing JSON value") {
		t.Fatalf("errors[0] = %q, want trailing JSON message", errors[0])
	}
}

func TestRequestExamplesValidate(t *testing.T) {
	tests := []struct {
		name     string
		path     string
		validate func(any) []string
	}{
		{"entity_create", "../examples/requests/entity-create.json", ValidateEntityCreateRequest},
		{"entity_update", "../examples/requests/entity-update.json", ValidateEntityUpdateRequest},
		{"task_create", "../examples/requests/task-create.json", ValidateTaskCreateRequest},
		{"task_update", "../examples/requests/task-update.json", ValidateTaskUpdateRequest},
		{"object_create", "../examples/requests/object-create.json", ValidateObjectCreateRequest},
		{"object_update", "../examples/requests/object-update.json", ValidateObjectUpdateRequest},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if errors := tt.validate(readJSONExample(t, tt.path)); len(errors) > 0 {
				t.Fatalf("%s validation errors = %v", tt.path, errors)
			}
		})
	}
}

func TestPromotedStringRequestLengthBoundaries(t *testing.T) {
	tests := []struct {
		name     string
		limit    int
		request  func(string) any
		validate func(any) []string
	}{
		{
			name:  "entity id",
			limit: 50,
			request: func(value string) any {
				return map[string]any{"entity_id": value, "entity_type": "asset"}
			},
			validate: ValidateEntityCreateRequest,
		},
		{
			name:  "entity type",
			limit: 50,
			request: func(value string) any {
				return map[string]any{"entity_id": "entity-1", "entity_type": value}
			},
			validate: ValidateEntityCreateRequest,
		},
		{
			name:  "entity subtype",
			limit: 50,
			request: func(value string) any {
				return map[string]any{"entity_id": "entity-1", "entity_type": "asset", "subtype": value}
			},
			validate: ValidateEntityCreateRequest,
		},
		{
			name:  "entity alias",
			limit: 255,
			request: func(value string) any {
				return map[string]any{"entity_id": "entity-1", "entity_type": "asset", "alias": value}
			},
			validate: ValidateEntityCreateRequest,
		},
		{
			name:  "object id",
			limit: 50,
			request: func(value string) any {
				return map[string]any{"object_id": value}
			},
			validate: ValidateObjectCreateRequest,
		},
		{
			name:  "object path",
			limit: 500,
			request: func(value string) any {
				return map[string]any{"object_id": "object-1", "path": value}
			},
			validate: ValidateObjectCreateRequest,
		},
		{
			name:  "object content type",
			limit: 100,
			request: func(value string) any {
				return map[string]any{"object_id": "object-1", "content_type": value}
			},
			validate: ValidateObjectCreateRequest,
		},
		{
			name:  "object type",
			limit: 50,
			request: func(value string) any {
				return map[string]any{"object_id": "object-1", "type": value}
			},
			validate: ValidateObjectCreateRequest,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if errors := tt.validate(tt.request(strings.Repeat("x", tt.limit))); len(errors) > 0 {
				t.Fatalf("maximum-length value rejected: %v", errors)
			}
			errors := tt.validate(tt.request(strings.Repeat("x", tt.limit+1)))
			assertAnyContains(t, errors, "maxLength")
		})
	}
}

func TestRequestValidationConformance(t *testing.T) {
	cases, err := conformance.LoadRequestValidationCases()
	if err != nil {
		t.Fatal(err)
	}
	schema, err := getSchema()
	if err != nil {
		t.Fatal(err)
	}
	validators := map[string]func(any) []string{
		"EntityCreateRequest": ValidateEntityCreateRequest,
		"EntityUpdateRequest": ValidateEntityUpdateRequest,
		"TaskCreateRequest":   ValidateTaskCreateRequest,
		"TaskUpdateRequest":   ValidateTaskUpdateRequest,
		"ObjectCreateRequest": ValidateObjectCreateRequest,
		"ObjectUpdateRequest": ValidateObjectUpdateRequest,
	}

	for _, testCase := range cases {
		t.Run(testCase.Name, func(t *testing.T) {
			compiled, ok := schema.schemas[testCase.Definition]
			if !ok {
				t.Fatalf("schema definition %q is not compiled", testCase.Definition)
			}
			normalized, err := normalizeForJSONSchema(testCase.Value)
			if err != nil {
				t.Fatalf("normalize corpus value: %v", err)
			}
			schemaValid := compiled.Validate(normalized) == nil
			if schemaValid != testCase.SchemaValid {
				t.Fatalf("canonical schema valid = %t, want %t", schemaValid, testCase.SchemaValid)
			}

			validate, ok := validators[testCase.Definition]
			if !ok {
				t.Fatalf("no Go validator for %q", testCase.Definition)
			}
			runtimeErrors := validate(testCase.Value)
			if valid := len(runtimeErrors) == 0; valid != testCase.Valid {
				t.Fatalf("Go runtime valid = %t, want %t; errors = %v", valid, testCase.Valid, runtimeErrors)
			}
		})
	}
}

func TestObjectSizeBytesUsesJavaScriptSafeIntegerRange(t *testing.T) {
	metadata := map[string]any{
		"created_at": "2026-08-03T00:00:00Z",
		"updated_at": "2026-08-03T00:00:00Z",
		"version":    1,
	}
	tests := []struct {
		name     string
		value    func(int64) any
		validate func(any) []string
	}{
		{name: "blob", value: func(size int64) any { return map[string]any{"size_bytes": size} }, validate: ValidateObjectBlob},
		{name: "create", value: func(size int64) any { return map[string]any{"object_id": "object-1", "size_bytes": size} }, validate: ValidateObjectCreateRequest},
		{name: "resource", value: func(size int64) any {
			return map[string]any{"object_id": "object-1", "path": nil, "content_type": nil, "type": nil, "bucket": nil, "size_bytes": size, "usage_hints": []any{}, "referenced_by": []any{}, "metadata": metadata}
		}, validate: ValidateObjectResource},
		{name: "detail", value: func(size int64) any {
			return map[string]any{"object_id": "object-1", "path": nil, "content_type": nil, "type": nil, "bucket": nil, "size_bytes": size, "usage_hints": []any{}, "referenced_by": []any{}, "metadata": metadata, "extra": map[string]any{}}
		}, validate: ValidateObjectDetailResource},
		{name: "update", value: func(size int64) any { return map[string]any{"size_bytes": size} }, validate: ValidateObjectUpdateRequest},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			for _, accepted := range []int64{0, 9007199254740991} {
				if errors := tt.validate(tt.value(accepted)); len(errors) > 0 {
					t.Fatalf("size_bytes %d rejected: %v", accepted, errors)
				}
			}
			if errors := tt.validate(tt.value(9007199254740992)); len(errors) == 0 {
				t.Fatal("unsafe size_bytes was accepted")
			}
		})
	}
}

func TestNormalizeForJSONSchemaAllowsSharedAcyclicValues(t *testing.T) {
	shared := map[string]any{"value": 1}
	if _, err := normalizeForJSONSchema(map[string]any{"first": shared, "second": shared}); err != nil {
		t.Fatalf("shared acyclic value was rejected: %v", err)
	}
}

func TestRequestValidationRejectsEmptyUpdatesAndUnknownFields(t *testing.T) {
	tests := []struct {
		name     string
		path     string
		validate func(any) []string
	}{
		{"entity_update_empty", "../examples/requests/invalid-entity-update-empty.json", ValidateEntityUpdateRequest},
		{"task_update_empty", "../examples/requests/invalid-task-update-empty.json", ValidateTaskUpdateRequest},
		{"object_update_empty", "../examples/requests/invalid-object-update-empty.json", ValidateObjectUpdateRequest},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			errors := tt.validate(readJSONExample(t, tt.path))
			assertAnyContains(t, errors, "minProperties")
		})
	}

	errors := ValidateTaskCreateRequest(json.RawMessage(`{"task_id":"task-unknown","unknown":true}`))
	assertAnyContains(t, errors, "unknown")
}

func TestRequestValidationRejectsUnknownComponents(t *testing.T) {
	tests := []struct {
		name     string
		payload  string
		validate func(any) []string
	}{
		{"entity_create", `{"entity_id":"asset-unknown","entity_type":"asset","components":{"typo":true}}`, ValidateEntityCreateRequest},
		{"entity_update", `{"components":{"typo":true}}`, ValidateEntityUpdateRequest},
		{"task_create", `{"task_id":"task-unknown","components":{"typo":true}}`, ValidateTaskCreateRequest},
		{"task_update", `{"components":{"typo":true}}`, ValidateTaskUpdateRequest},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			errors := tt.validate(json.RawMessage(tt.payload))
			assertAnyContains(t, errors, "Unknown component 'typo'")
		})
	}
}

func TestTaskCreateRequestCommandTaskIDRules(t *testing.T) {
	validCommand := json.RawMessage(`{"entity_id":"asset-command","components":{"command":{"type":"goto"},"parameters":{"latitude":38,"longitude":-77}}}`)
	if errors := ValidateTaskCreateRequest(validCommand); len(errors) > 0 {
		t.Fatalf("ValidateTaskCreateRequest(command without task_id) errors = %v", errors)
	}

	tests := []struct {
		name    string
		payload string
		want    string
	}{
		{"normal_task_requires_task_id", `{"status":"pending"}`, "task_id"},
		{"command_task_rejects_task_id", `{"task_id":"task-command","entity_id":"asset-command","components":{"command":{"type":"goto"}}}`, "task_id"},
		{"command_task_requires_entity_id", `{"components":{"command":{"type":"goto"}}}`, "entity_id"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			errors := ValidateTaskCreateRequest(json.RawMessage(tt.payload))
			assertAnyContains(t, errors, tt.want)
		})
	}
}

func TestUnencodableInputReturnsError(t *testing.T) {
	values := []any{
		map[string]any{"latitude": make(chan int)},
		map[string]any{"latitude": func() {}},
	}
	for i, value := range values {
		t.Run(fmt.Sprintf("value_%d", i), func(t *testing.T) {
			errors := ValidateTelemetryComponent(value)
			if len(errors) != 1 {
				t.Fatalf("errors = %v, want exactly one", errors)
			}
			if !strings.Contains(errors[0], "input cannot be encoded as JSON") {
				t.Fatalf("errors[0] = %q, want encoding failure message", errors[0])
			}
		})
	}
}

func readJSONExample(t *testing.T, path string) json.RawMessage {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	var decoded any
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("decode %s: %v", path, err)
	}
	return json.RawMessage(data)
}

func assertAnyContains(t *testing.T, errors []string, want string) {
	t.Helper()
	for _, err := range errors {
		if strings.Contains(err, want) {
			return
		}
	}
	t.Fatalf("expected error containing %q, got %v", want, errors)
}
