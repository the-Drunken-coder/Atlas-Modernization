package actions

import (
	"github.com/the-drunken-coder/atlas/atlas_core/internal/models"
	protocol "github.com/the-drunken-coder/atlas/atlas_protocol/generated/go/atlasprotocol"
)

type ChangeEvent = protocol.FeedEventName
type ChangeResource = protocol.ResourceType

const (
	ChangeEventCreate ChangeEvent = protocol.FeedEventCreate
	ChangeEventUpdate ChangeEvent = protocol.FeedEventUpdate
	ChangeEventDelete ChangeEvent = protocol.FeedEventDelete

	ChangeResourceEntity ChangeResource = protocol.ResourceTypeEntity
	ChangeResourceTask   ChangeResource = protocol.ResourceTypeTask
	ChangeResourceObject ChangeResource = protocol.ResourceTypeObject
)

// ResourceChange is emitted only after a write transaction commits.
type ResourceChange struct {
	Event        ChangeEvent
	ResourceType ChangeResource
	ID           string
	Version      int64

	BeforeEntity *models.Entity
	AfterEntity  *models.Entity
	BeforeTask   *models.Task
	AfterTask    *models.Task
	BeforeObject *models.MediaObject
	AfterObject  *models.MediaObject
}

// ChangeSink receives committed resource changes. PublishResourceChange should
// complete within 10ms under normal load; delegate slower work to a buffered
// queue or worker and return immediately.
type ChangeSink interface {
	PublishResourceChange(ResourceChange)
}

func cloneRawMessage(raw []byte) []byte {
	if raw == nil {
		return nil
	}
	return append([]byte(nil), raw...)
}

func cloneStringPointer(value *string) *string {
	if value == nil {
		return nil
	}
	cloned := *value
	return &cloned
}

func cloneEntityModel(entity *models.Entity) *models.Entity {
	if entity == nil {
		return nil
	}
	return &models.Entity{
		EntityID:  entity.EntityID,
		Type:      entity.Type,
		Subtype:   cloneStringPointer(entity.Subtype),
		Alias:     cloneStringPointer(entity.Alias),
		JSON:      cloneRawMessage(entity.JSON),
		CreatedAt: entity.CreatedAt,
		UpdatedAt: entity.UpdatedAt,
		Version:   entity.Version,
	}
}

func cloneTaskModel(task *models.Task) *models.Task {
	if task == nil {
		return nil
	}
	return &models.Task{
		TaskID:    task.TaskID,
		Status:    task.Status,
		EntityID:  cloneStringPointer(task.EntityID),
		JSON:      cloneRawMessage(task.JSON),
		CreatedAt: task.CreatedAt,
		UpdatedAt: task.UpdatedAt,
		Version:   task.Version,
	}
}

func cloneObjectModel(object *models.MediaObject) *models.MediaObject {
	if object == nil {
		return nil
	}
	return &models.MediaObject{
		ObjectID:    object.ObjectID,
		Path:        cloneStringPointer(object.Path),
		ContentType: cloneStringPointer(object.ContentType),
		Type:        cloneStringPointer(object.Type),
		JSON:        cloneRawMessage(object.JSON),
		CreatedAt:   object.CreatedAt,
		UpdatedAt:   object.UpdatedAt,
		Version:     object.Version,
	}
}

func publishChange(sink ChangeSink, change ResourceChange) {
	if sink == nil {
		return
	}
	change.BeforeEntity = cloneEntityModel(change.BeforeEntity)
	change.AfterEntity = cloneEntityModel(change.AfterEntity)
	change.BeforeTask = cloneTaskModel(change.BeforeTask)
	change.AfterTask = cloneTaskModel(change.AfterTask)
	change.BeforeObject = cloneObjectModel(change.BeforeObject)
	change.AfterObject = cloneObjectModel(change.AfterObject)
	sink.PublishResourceChange(change)
}
