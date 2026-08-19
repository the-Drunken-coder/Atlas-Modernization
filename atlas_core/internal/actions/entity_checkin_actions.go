package actions

import (
	"context"

	"github.com/the-drunken-coder/atlas/atlas_core/internal/models"
)

// EntityCheckinActions coordinates the task-page read with the entity check-in
// write used by the response.
type EntityCheckinActions struct {
	entityActions *EntityActions
}

// NewEntityCheckinActions creates a check-in action service from existing
// entity and task actions.
func NewEntityCheckinActions(entityActions *EntityActions, taskActions *TaskActions) *EntityCheckinActions {
	return &EntityCheckinActions{
		entityActions: entityActions,
	}
}

// EntityCheckinParams holds the non-HTTP inputs for an entity check-in.
type EntityCheckinParams struct {
	EntityID        string
	Components      map[string]interface{}
	ExpectedVersion *int64
}

// EntityCheckinResult contains the updated telemetry Entity.
type EntityCheckinResult struct {
	Entity *models.Entity
}

// CheckIn applies observed state. Task delivery is push-driven and deliberately
// absent from periodic telemetry check-in.
func (a *EntityCheckinActions) CheckIn(ctx context.Context, params EntityCheckinParams) (*EntityCheckinResult, error) {
	if err := a.entityActions.checkExpectedVersion(ctx, params.EntityID, params.ExpectedVersion); err != nil {
		return nil, err
	}
	entity, err := a.entityActions.Update(ctx, params.EntityID, UpdateEntityParams{
		Components:      params.Components,
		ExpectedVersion: params.ExpectedVersion,
	})
	if err != nil {
		return nil, err
	}

	return &EntityCheckinResult{Entity: entity}, nil
}
