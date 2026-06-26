package actions

import (
	"context"
	"time"

	"github.com/the-drunken-coder/atlas/atlas_core/internal/models"
)

// EntityCheckinActions coordinates the entity check-in write with the follow-up
// task query used by the check-in response.
type EntityCheckinActions struct {
	entityActions *EntityActions
	taskActions   *TaskActions
}

// NewEntityCheckinActions creates a check-in action service from existing
// entity and task actions.
func NewEntityCheckinActions(entityActions *EntityActions, taskActions *TaskActions) *EntityCheckinActions {
	return &EntityCheckinActions{
		entityActions: entityActions,
		taskActions:   taskActions,
	}
}

// EntityCheckinParams holds the non-HTTP inputs for an entity check-in.
type EntityCheckinParams struct {
	EntityID        string
	Components      map[string]interface{}
	ExpectedVersion *int64
	TaskStatuses    []string
	Since           *time.Time
	TaskLimit       int
	TaskCursor      string
}

// EntityCheckinResult contains the updated entity and matching task page.
type EntityCheckinResult struct {
	Entity *models.Entity
	Tasks  *ListPage[*models.Task]
}

// CheckIn applies check-in components to an entity and retrieves matching tasks.
func (a *EntityCheckinActions) CheckIn(ctx context.Context, params EntityCheckinParams) (*EntityCheckinResult, error) {
	entity, err := a.entityActions.Update(ctx, params.EntityID, UpdateEntityParams{
		Components:      params.Components,
		ExpectedVersion: params.ExpectedVersion,
	})
	if err != nil {
		return nil, err
	}

	tasks, err := a.taskActions.GetByEntityFiltered(ctx, params.EntityID, params.TaskStatuses, params.Since, params.TaskLimit, params.TaskCursor)
	if err != nil {
		return nil, err
	}

	return &EntityCheckinResult{
		Entity: entity,
		Tasks:  tasks,
	}, nil
}
