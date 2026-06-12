package actions

import "github.com/the-drunken-coder/atlas/atlas_core/internal/models"

const (
	ChangeEventCreate = "create"
	ChangeEventUpdate = "update"
	ChangeEventDelete = "delete"

	ChangeResourceEntity = "entity"
	ChangeResourceTask   = "task"
	ChangeResourceObject = "object"
)

// ResourceChange is emitted only after a write transaction commits.
type ResourceChange struct {
	Event        string
	ResourceType string
	ID           string
	Version      int64

	BeforeEntity *models.Entity
	AfterEntity  *models.Entity
	BeforeTask   *models.Task
	AfterTask    *models.Task
	BeforeObject *models.MediaObject
	AfterObject  *models.MediaObject
}

// ChangeSink receives committed resource changes. Implementations must not
// block write paths indefinitely.
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
	sink.PublishResourceChange(change)
}
