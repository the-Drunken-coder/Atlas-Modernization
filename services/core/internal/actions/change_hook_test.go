package actions

import (
	"bytes"
	"context"
	"encoding/json"
	"testing"
	"time"

	protocol "github.com/the-drunken-coder/atlas/packages/protocol/generated/go/atlasprotocol"
	"github.com/the-drunken-coder/atlas/services/core/internal/models"
)

func TestCloneRawMessage(t *testing.T) {
	if cloneRawMessage(nil) != nil {
		t.Fatal("cloneRawMessage(nil) should return nil")
	}
	original := []byte(`{"a":1}`)
	cloned := cloneRawMessage(original)
	if !bytes.Equal(cloned, original) {
		t.Fatalf("cloneRawMessage = %s, want %s", cloned, original)
	}
	cloned[0] = '['
	if original[0] == '[' {
		t.Fatal("cloneRawMessage returned aliased bytes")
	}
}

func TestCloneStringPointer(t *testing.T) {
	if cloneStringPointer(nil) != nil {
		t.Fatal("cloneStringPointer(nil) should return nil")
	}
	original := "asset-1"
	cloned := cloneStringPointer(&original)
	if cloned == nil || *cloned != original {
		t.Fatalf("cloneStringPointer = %#v, want %q", cloned, original)
	}
	*cloned = "asset-2"
	if original == "asset-2" {
		t.Fatal("cloneStringPointer returned aliased pointer")
	}
}

func TestCloneEntityModelCopiesPublicFields(t *testing.T) {
	subtype := "air"
	alias := "falcon"
	now := time.Now().UTC()
	original := &models.Entity{
		EntityID:  "asset-1",
		Type:      "asset",
		Subtype:   &subtype,
		Alias:     &alias,
		JSON:      json.RawMessage(`{"components":{}}`),
		CreatedAt: now,
		UpdatedAt: now.Add(time.Second),
		Version:   4,
	}
	cloned := cloneEntityModel(original)
	if cloned == nil {
		t.Fatal("cloneEntityModel returned nil")
	}
	if cloned.EntityID != original.EntityID || cloned.Type != original.Type || cloned.CreatedAt != original.CreatedAt || cloned.UpdatedAt != original.UpdatedAt || cloned.Version != original.Version {
		t.Fatalf("cloneEntityModel did not copy scalar fields: %#v", cloned)
	}
	assertIndependentStringPointer(t, "Subtype", original.Subtype, cloned.Subtype)
	assertIndependentStringPointer(t, "Alias", original.Alias, cloned.Alias)
	assertIndependentJSON(t, original.JSON, cloned.JSON)
	if cloneEntityModel(nil) != nil {
		t.Fatal("cloneEntityModel(nil) should return nil")
	}
}

func TestCloneTaskModelCopiesPublicFields(t *testing.T) {
	progress := 0.5
	now := time.Now().UTC()
	original := &models.Task{
		TaskID: "task-1", AssetID: "asset-1", Command: "fixture.queued",
		Input: json.RawMessage(`{"value":1}`), Status: "in_progress", Progress: &progress,
		CompletionAttempt: json.RawMessage(`{"result":"rejected"}`),
		RuntimeID:         "runtime-1", IdempotencyKey: "attempt-1",
		CreatedAt: now, AcknowledgedAt: &now, StartedAt: &now,
		UpdatedAt: now.Add(time.Second), Version: 5,
	}
	cloned := cloneTaskModel(original)
	if cloned == nil {
		t.Fatal("cloneTaskModel returned nil")
	}
	if cloned.TaskID != original.TaskID || cloned.AssetID != original.AssetID || cloned.Command != original.Command || cloned.Status != original.Status || cloned.CreatedAt != original.CreatedAt || cloned.UpdatedAt != original.UpdatedAt || cloned.Version != original.Version {
		t.Fatalf("cloneTaskModel did not copy scalar fields: %#v", cloned)
	}
	assertIndependentJSON(t, original.Input, cloned.Input)
	assertIndependentJSON(t, original.CompletionAttempt, cloned.CompletionAttempt)
	if cloned.Progress == original.Progress || cloned.AcknowledgedAt == original.AcknowledgedAt {
		t.Fatal("cloneTaskModel returned aliased pointers")
	}
	if cloneTaskModel(nil) != nil {
		t.Fatal("cloneTaskModel(nil) should return nil")
	}
}

func TestCloneObjectModelCopiesPublicFields(t *testing.T) {
	path := "objects/object-1"
	contentType := "application/json"
	objectType := "data"
	now := time.Now().UTC()
	original := &models.MediaObject{
		ObjectID:    "object-1",
		Path:        &path,
		ContentType: &contentType,
		Type:        &objectType,
		JSON:        json.RawMessage(`{"size_bytes":10}`),
		CreatedAt:   now,
		UpdatedAt:   now.Add(time.Second),
		Version:     6,
	}
	cloned := cloneObjectModel(original)
	if cloned == nil {
		t.Fatal("cloneObjectModel returned nil")
	}
	if cloned.ObjectID != original.ObjectID || cloned.CreatedAt != original.CreatedAt || cloned.UpdatedAt != original.UpdatedAt || cloned.Version != original.Version {
		t.Fatalf("cloneObjectModel did not copy scalar fields: %#v", cloned)
	}
	assertIndependentStringPointer(t, "Path", original.Path, cloned.Path)
	assertIndependentStringPointer(t, "ContentType", original.ContentType, cloned.ContentType)
	assertIndependentStringPointer(t, "Type", original.Type, cloned.Type)
	assertIndependentJSON(t, original.JSON, cloned.JSON)
	if cloneObjectModel(nil) != nil {
		t.Fatal("cloneObjectModel(nil) should return nil")
	}
}

func TestResourceChangeRecordBuildsCanonicalTaskRoutingEvent(t *testing.T) {
	assetID := "asset-1"
	afterTask := &models.Task{
		TaskID: "task-1", AssetID: assetID, Command: "fixture.immediate",
		Input: json.RawMessage(`{}`), Status: "pending",
		CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC(), Version: 7,
	}

	record, err := resourceChangeRecord(ResourceChange{
		Event:        ChangeEventUpdate,
		ResourceType: ChangeResourceTask,
		ID:           "task-1",
		Version:      7,
		AfterTask:    afterTask,
	})
	if err != nil {
		t.Fatalf("resourceChangeRecord: %v", err)
	}
	if record.Event.Version != 7 || record.Event.ResourceType != ChangeResourceTask || record.Event.ID != "task-1" {
		t.Fatalf("event identity = %#v", record.Event)
	}
	if record.TaskAssetID != assetID {
		t.Fatalf("routing context = %#v", record)
	}
	if record.Event.Resource == nil {
		t.Fatal("task update resource is nil")
	}
}

func TestResourceChangeRecordBuildsEntityDelete(t *testing.T) {
	record, err := resourceChangeRecord(ResourceChange{
		Event: ChangeEventDelete, ResourceType: ChangeResourceEntity, ID: "entity-1", Version: 8,
	})
	if err != nil {
		t.Fatalf("resourceChangeRecord: %v", err)
	}
	if record.Event.Event != ChangeEventDelete || record.Event.ID != "entity-1" || record.Event.Resource != nil {
		t.Fatalf("entity delete event = %#v", record.Event)
	}
}

func TestResourceChangeRecordCarriesEntityChangeReason(t *testing.T) {
	record, err := resourceChangeRecord(ResourceChange{
		Event:        ChangeEventUpdate,
		ResourceType: ChangeResourceEntity,
		ID:           "entity-1",
		Version:      8,
		ChangeReason: protocol.EntityChangeReasonRuntimeManifestChanged,
		AfterEntity:  &models.Entity{EntityID: "entity-1", Type: "asset", JSON: json.RawMessage(`{}`), Version: 8},
	})
	if err != nil {
		t.Fatalf("resourceChangeRecord: %v", err)
	}
	if record.Event.ChangeReason != protocol.EntityChangeReasonRuntimeManifestChanged {
		t.Fatalf("change reason = %#v, want %q", record.Event.ChangeReason, protocol.EntityChangeReasonRuntimeManifestChanged)
	}
}

func TestResourceChangeRecordRejectsUnknownEntityChangeReason(t *testing.T) {
	_, err := resourceChangeRecord(ResourceChange{
		Event:        ChangeEventUpdate,
		ResourceType: ChangeResourceEntity,
		ID:           "entity-1",
		Version:      8,
		ChangeReason: protocol.EntityChangeReason("other"),
		AfterEntity:  &models.Entity{EntityID: "entity-1", Type: "asset", JSON: json.RawMessage(`{}`), Version: 8},
	})
	if err == nil {
		t.Fatal("resourceChangeRecord accepted unknown entity change reason")
	}
}

func TestResourceChangeRecordRejectsChangeReasonOutsideEntityUpdate(t *testing.T) {
	for _, change := range []ResourceChange{
		{Event: ChangeEventCreate, ResourceType: ChangeResourceEntity, ID: "entity-1", Version: 1, ChangeReason: protocol.EntityChangeReasonRuntimeManifestChanged},
		{Event: ChangeEventUpdate, ResourceType: ChangeResourceTask, ID: "task-1", Version: 1, ChangeReason: protocol.EntityChangeReasonRuntimeManifestChanged},
		{Event: ChangeEventDelete, ResourceType: ChangeResourceEntity, ID: "entity-1", Version: 1, ChangeReason: protocol.EntityChangeReasonRuntimeManifestChanged},
	} {
		if _, err := resourceChangeRecord(change); err == nil {
			t.Fatalf("resourceChangeRecord accepted invalid change reason for %#v", change)
		}
	}
}

func TestResourceChangeRecordRejectsMissingStateAndUnknownType(t *testing.T) {
	for _, change := range []ResourceChange{
		{Event: ChangeEventCreate, ResourceType: ChangeResourceEntity, ID: "entity-1", Version: 1},
		{Event: ChangeEventUpdate, ResourceType: ChangeResourceTask, ID: "task-1", Version: 1},
		{Event: ChangeEventCreate, ResourceType: ChangeResourceObject, ID: "object-1", Version: 1},
		{Event: ChangeEventCreate, ResourceType: ChangeResource("unknown"), ID: "unknown-1", Version: 1},
	} {
		if _, err := resourceChangeRecord(change); err == nil {
			t.Fatalf("expected invalid change %#v to fail", change)
		}
	}
}

func TestReadChangeRecordsRejectsNonPositiveLimit(t *testing.T) {
	for _, limit := range []int{0, -1} {
		records, hasMore, err := ReadChangeRecords(context.Background(), nil, 0, 1, limit)
		if err == nil || records != nil || hasMore {
			t.Fatalf("ReadChangeRecords limit %d = (%#v, %v, %v), want early error", limit, records, hasMore, err)
		}
	}
}

func TestReserveChangeVersionsRejectsNonPositiveCount(t *testing.T) {
	for _, count := range []int{0, -1} {
		if _, err := reserveChangeVersions(context.Background(), nil, count); err == nil {
			t.Fatalf("reserveChangeVersions count %d succeeded", count)
		}
	}
}

func assertIndependentStringPointer(t *testing.T, name string, original, cloned *string) {
	t.Helper()
	if original == nil || cloned == nil {
		t.Fatalf("%s pointer missing: original=%#v cloned=%#v", name, original, cloned)
	}
	if *cloned != *original {
		t.Fatalf("%s = %q, want %q", name, *cloned, *original)
	}
	*cloned = *cloned + "-changed"
	if *original == *cloned {
		t.Fatalf("%s clone aliases original pointer", name)
	}
}

func assertIndependentJSON(t *testing.T, original, cloned json.RawMessage) {
	t.Helper()
	if !bytes.Equal(original, cloned) {
		t.Fatalf("cloned JSON = %s, want %s", cloned, original)
	}
	if len(cloned) == 0 {
		t.Fatal("test requires non-empty JSON")
	}
	cloned[0] = '['
	if original[0] == '[' {
		t.Fatal("cloned JSON aliases original")
	}
}
