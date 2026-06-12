package actions

import (
	"bytes"
	"encoding/json"
	"testing"
	"time"

	"github.com/the-drunken-coder/atlas/atlas_core/internal/models"
)

type recordingChangeSink struct {
	change ResourceChange
	called bool
}

func (s *recordingChangeSink) PublishResourceChange(change ResourceChange) {
	s.called = true
	s.change = change
}

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
	entityID := "asset-1"
	now := time.Now().UTC()
	original := &models.Task{
		TaskID:    "task-1",
		Status:    "pending",
		EntityID:  &entityID,
		JSON:      json.RawMessage(`{"components":{}}`),
		CreatedAt: now,
		UpdatedAt: now.Add(time.Second),
		Version:   5,
	}
	cloned := cloneTaskModel(original)
	if cloned == nil {
		t.Fatal("cloneTaskModel returned nil")
	}
	if cloned.TaskID != original.TaskID || cloned.Status != original.Status || cloned.CreatedAt != original.CreatedAt || cloned.UpdatedAt != original.UpdatedAt || cloned.Version != original.Version {
		t.Fatalf("cloneTaskModel did not copy scalar fields: %#v", cloned)
	}
	assertIndependentStringPointer(t, "EntityID", original.EntityID, cloned.EntityID)
	assertIndependentJSON(t, original.JSON, cloned.JSON)
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

func TestPublishChangeClonesModelsAndIgnoresNilSink(t *testing.T) {
	beforeEntityAlias := "before-alias"
	beforeEntity := &models.Entity{EntityID: "before", Alias: &beforeEntityAlias, JSON: json.RawMessage(`{"before":true}`)}
	afterEntityAlias := "after-alias"
	afterEntity := &models.Entity{EntityID: "after", Alias: &afterEntityAlias, JSON: json.RawMessage(`{"after":true}`)}
	beforeTaskEntity := "asset-before"
	beforeTask := &models.Task{TaskID: "task-before", EntityID: &beforeTaskEntity, JSON: json.RawMessage(`{"before_task":true}`)}
	afterTaskEntity := "asset-after"
	afterTask := &models.Task{TaskID: "task-after", EntityID: &afterTaskEntity, JSON: json.RawMessage(`{"after_task":true}`)}
	beforeObjectPath := "objects/object-before"
	beforeObject := &models.MediaObject{ObjectID: "object-before", Path: &beforeObjectPath, JSON: json.RawMessage(`{"before_object":true}`)}
	afterObjectPath := "objects/object-1"
	afterObject := &models.MediaObject{ObjectID: "object-1", Path: &afterObjectPath, JSON: json.RawMessage(`{"after_object":true}`)}

	publishChange(nil, ResourceChange{ID: "ignored"})

	sink := &recordingChangeSink{}
	publishChange(sink, ResourceChange{
		Event:        ChangeEventUpdate,
		ResourceType: ChangeResourceTask,
		ID:           "task-1",
		Version:      7,
		BeforeEntity: beforeEntity,
		AfterEntity:  afterEntity,
		BeforeTask:   beforeTask,
		AfterTask:    afterTask,
		BeforeObject: beforeObject,
		AfterObject:  afterObject,
	})
	if !sink.called {
		t.Fatal("publishChange did not call sink")
	}
	if sink.change.BeforeEntity == beforeEntity ||
		sink.change.AfterEntity == afterEntity ||
		sink.change.BeforeTask == beforeTask ||
		sink.change.AfterTask == afterTask ||
		sink.change.BeforeObject == beforeObject ||
		sink.change.AfterObject == afterObject {
		t.Fatalf("publishChange passed aliased models: %#v", sink.change)
	}
	assertIndependentJSON(t, beforeEntity.JSON, sink.change.BeforeEntity.JSON)
	assertIndependentStringPointer(t, "BeforeEntity.Alias", beforeEntity.Alias, sink.change.BeforeEntity.Alias)
	assertIndependentJSON(t, afterEntity.JSON, sink.change.AfterEntity.JSON)
	assertIndependentStringPointer(t, "AfterEntity.Alias", afterEntity.Alias, sink.change.AfterEntity.Alias)
	assertIndependentJSON(t, beforeTask.JSON, sink.change.BeforeTask.JSON)
	assertIndependentStringPointer(t, "BeforeTask.EntityID", beforeTask.EntityID, sink.change.BeforeTask.EntityID)
	assertIndependentJSON(t, afterTask.JSON, sink.change.AfterTask.JSON)
	assertIndependentStringPointer(t, "AfterTask.EntityID", afterTask.EntityID, sink.change.AfterTask.EntityID)
	assertIndependentJSON(t, beforeObject.JSON, sink.change.BeforeObject.JSON)
	assertIndependentStringPointer(t, "BeforeObject.Path", beforeObject.Path, sink.change.BeforeObject.Path)
	assertIndependentJSON(t, afterObject.JSON, sink.change.AfterObject.JSON)
	assertIndependentStringPointer(t, "AfterObject.Path", afterObject.Path, sink.change.AfterObject.Path)
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
