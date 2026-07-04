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
		"usage_hints": []string{"command_catalog"},
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
			"command_catalog",
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
