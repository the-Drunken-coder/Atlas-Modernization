package protocoltest

import (
	"encoding/json"
	"strings"
	"testing"

	protocol "github.com/the-drunken-coder/atlas/packages/protocol/generated/go/atlasprotocol"
)

func TestGeneratedErrorResponseHelpers(t *testing.T) {
	response, err := protocol.NewErrorResponse("invalid payload", protocol.ErrorCodeValidationError)
	if err != nil {
		t.Fatalf("NewErrorResponse returned error: %v", err)
	}
	if response.Success || response.Message != "invalid payload" || response.ErrorCode != protocol.ErrorCodeValidationError {
		t.Fatalf("NewErrorResponse = %#v", response)
	}
	data, err := json.Marshal(response)
	if err != nil {
		t.Fatalf("Marshal valid ErrorResponse: %v", err)
	}
	if !strings.Contains(string(data), `"success":false`) || !strings.Contains(string(data), `"error_code":"VALIDATION_ERROR"`) {
		t.Fatalf("marshaled ErrorResponse = %s", data)
	}

	_, err = json.Marshal(protocol.ErrorResponse{Success: true, Message: "bad", ErrorCode: protocol.ErrorCodeValidationError})
	if err == nil || !strings.Contains(err.Error(), "invalid ErrorResponse") {
		t.Fatalf("Marshal invalid ErrorResponse error = %v, want validation error", err)
	}
}

func TestGeneratedDeleteEventHelpers(t *testing.T) {
	entity := protocol.EntityDeleteEvent{ID: "entity-1", Version: 2}
	assertDeleteEvent(t, entity, entity.FeedEvent(), protocol.ResourceTypeEntity, "entity-1", 2)

	object := protocol.ObjectDeleteEvent{ID: "object-1", Version: 4}
	assertDeleteEvent(t, object, object.FeedEvent(), protocol.ResourceTypeObject, "object-1", 4)

	_, err := json.Marshal(protocol.EntityDeleteEvent{Version: 1})
	if err == nil || !strings.Contains(err.Error(), "invalid EntityDeleteEvent") {
		t.Fatalf("Marshal invalid EntityDeleteEvent error = %v, want validation error", err)
	}
}

func TestGeneratedIntegerUnmarshalAcceptsExactIntegralJSONNumbers(t *testing.T) {
	tests := []struct {
		name string
		raw  string
		want int64
	}{
		{name: "integer", raw: "1", want: 1},
		{name: "decimal integer", raw: "1.0", want: 1},
		{name: "exponent integer", raw: "1e3", want: 1_000},
		{name: "safe maximum", raw: "9007199254740991", want: 9_007_199_254_740_991},
		{name: "safe maximum decimal", raw: "9007199254740991.0", want: 9_007_199_254_740_991},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var ready protocol.FeedSubscriptionsReadyMessage
			data := []byte(`{"type":"subscriptions_ready","version":` + test.raw + `}`)
			if err := json.Unmarshal(data, &ready); err != nil {
				t.Fatalf("Unmarshal(%s) returned error: %v", data, err)
			}
			if ready.Version != test.want {
				t.Fatalf("Version = %d, want %d", ready.Version, test.want)
			}
		})
	}

	for _, raw := range []string{
		"9223372036854775808",
		"9223372036854775807.5",
		"1e-4000",
		"1e1000000",
		"1e-1000000",
		"9007199254740993",
	} {
		var ready protocol.FeedSubscriptionsReadyMessage
		data := []byte(`{"type":"subscriptions_ready","version":` + raw + `}`)
		if err := json.Unmarshal(data, &ready); err == nil {
			t.Fatalf("Unmarshal(%s) accepted an unrepresentable version", data)
		}
	}
	for _, raw := range []string{
		`{"type":"subscriptions_ready","version":1.5,"version":1}`,
		`{"type":"subscriptions_ready","version":1,"version":1.5}`,
		`{"type":"subscriptions_ready","version":1e1000000,"version":1e1000000}`,
	} {
		var ready protocol.FeedSubscriptionsReadyMessage
		if err := json.Unmarshal([]byte(raw), &ready); err == nil {
			t.Fatalf("Unmarshal(%s) accepted an invalid duplicate version", raw)
		}
	}

	var detail protocol.ObjectDetailResource
	if err := json.Unmarshal([]byte(`{"size_bytes":1.0}`), &detail); err != nil {
		t.Fatalf("Unmarshal optional integral size_bytes returned error: %v", err)
	}
	if detail.SizeBytes == nil || *detail.SizeBytes != 1 {
		t.Fatalf("SizeBytes = %v, want pointer to 1", detail.SizeBytes)
	}
	if err := json.Unmarshal([]byte(`{"size_bytes":null}`), &detail); err != nil {
		t.Fatalf("Unmarshal null size_bytes returned error: %v", err)
	}
	if detail.SizeBytes != nil {
		t.Fatalf("SizeBytes = %v, want nil", detail.SizeBytes)
	}

	ready := protocol.FeedSubscriptionsReadyMessage{Type: "subscriptions_ready", Version: 7}
	if err := json.Unmarshal([]byte(`{}`), &ready); err != nil {
		t.Fatalf("Unmarshal empty object returned error: %v", err)
	}
	if ready.Type != "subscriptions_ready" || ready.Version != 7 {
		t.Fatalf("Unmarshal empty object = %#v, want original values", ready)
	}

	for _, raw := range []string{
		`{"type":"subscriptions_ready","VERSION":9007199254740993}`,
		`{"type":"subscriptions_ready","Version":9007199254740993}`,
		`{"type":"subscriptions_ready","version":1,"unknown":true}`,
	} {
		var strict protocol.FeedSubscriptionsReadyMessage
		if err := json.Unmarshal([]byte(raw), &strict); err == nil {
			t.Fatalf("Unmarshal(%s) accepted an unknown or case-variant property", raw)
		}
	}

	var deletion protocol.EntityDeleteEvent
	if err := json.Unmarshal(
		[]byte(`{"event":"delete","resource_type":"entity","id":"entity-1","version":1}`),
		&deletion,
	); err != nil {
		t.Fatalf("Unmarshal valid EntityDeleteEvent wire properties: %v", err)
	}

	unknownPropertyManifest := `{"plugin_id":"fixture","display_name":"Fixture","operations":[{"operation_id":"run","display_name":"Run","timeout_ms":1,"UNKNOWN":true}]}`
	validManifest := strings.Replace(unknownPropertyManifest, `,"UNKNOWN":true`, "", 1)
	var manifest protocol.PluginManifest
	if err := json.Unmarshal([]byte(validManifest), &manifest); err != nil {
		t.Fatalf("Unmarshal valid PluginManifest fixture: %v", err)
	}
	if err := json.Unmarshal([]byte(unknownPropertyManifest), &manifest); err == nil {
		t.Fatal("Unmarshal accepted an unknown property inside PluginOperationDescriptor")
	}
}

func TestGeneratedFeedEventUnmarshalPreservesNestedJSONNumbers(t *testing.T) {
	const raw = `{"event":"create","resource_type":"task","id":"task-1","version":1,"resource":{"task_id":"task-1","input":{"value":9007199254740993}}}`
	var event protocol.FeedEvent
	if err := json.Unmarshal([]byte(raw), &event); err != nil {
		t.Fatalf("Unmarshal FeedEvent: %v", err)
	}
	encoded, err := json.Marshal(event.Resource)
	if err != nil {
		t.Fatalf("Marshal FeedEvent resource: %v", err)
	}
	if !strings.Contains(string(encoded), `"value":9007199254740993`) {
		t.Fatalf("FeedEvent resource lost nested number precision: %s", encoded)
	}
}

func assertDeleteEvent(t *testing.T, value json.Marshaler, event protocol.FeedEvent, resourceType protocol.ResourceType, id string, version int64) {
	t.Helper()
	if event.Event != protocol.FeedEventDelete || event.ResourceType != resourceType || event.ID != id || event.Version != version {
		t.Fatalf("FeedEvent() = %#v, want %s delete %s@%d", event, resourceType, id, version)
	}
	data, err := value.MarshalJSON()
	if err != nil {
		t.Fatalf("MarshalJSON(%T): %v", value, err)
	}
	var payload map[string]any
	if err := json.Unmarshal(data, &payload); err != nil {
		t.Fatalf("decode delete event JSON %s: %v", data, err)
	}
	if payload["event"] != "delete" || payload["resource_type"] != string(resourceType) || payload["id"] != id || payload["version"] != float64(version) {
		t.Fatalf("delete event JSON = %#v", payload)
	}
}
