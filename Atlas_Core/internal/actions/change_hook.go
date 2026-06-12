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

func cloneEntityModel(entity *models.Entity) *models.Entity {
	if entity == nil {
		return nil
	}
	out := *entity
	out.JSON = cloneRawMessage(entity.JSON)
	return &out
}

func cloneTaskModel(task *models.Task) *models.Task {
	if task == nil {
		return nil
	}
	out := *task
	out.JSON = cloneRawMessage(task.JSON)
	return &out
}

func cloneObjectModel(object *models.MediaObject) *models.MediaObject {
	if object == nil {
		return nil
	}
	out := *object
	out.JSON = cloneRawMessage(object.JSON)
	return &out
}

func publishChange(sink ChangeSink, change ResourceChange) {
	if sink == nil {
		return
	}
	sink.PublishResourceChange(change)
}
