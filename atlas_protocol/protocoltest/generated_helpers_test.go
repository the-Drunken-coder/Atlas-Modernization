package protocoltest

import (
	"encoding/json"
	"strings"
	"testing"

	protocol "github.com/the-drunken-coder/atlas/atlas_protocol/generated/go/atlasprotocol"
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

	entityID := "entity-1"
	task := protocol.TaskDeleteEvent{ID: "task-1", Version: 3, EntityID: &entityID}
	taskEvent := task.FeedEvent()
	assertDeleteEvent(t, task, taskEvent, protocol.ResourceTypeTask, "task-1", 3)
	if taskEvent.EntityID == nil || *taskEvent.EntityID != entityID {
		t.Fatalf("TaskDeleteEvent.FeedEvent().EntityID = %#v, want %q", taskEvent.EntityID, entityID)
	}

	object := protocol.ObjectDeleteEvent{ID: "object-1", Version: 4}
	assertDeleteEvent(t, object, object.FeedEvent(), protocol.ResourceTypeObject, "object-1", 4)

	_, err := json.Marshal(protocol.EntityDeleteEvent{Version: 1})
	if err == nil || !strings.Contains(err.Error(), "invalid EntityDeleteEvent") {
		t.Fatalf("Marshal invalid EntityDeleteEvent error = %v, want validation error", err)
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
