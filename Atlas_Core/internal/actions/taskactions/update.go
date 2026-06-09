package taskactions

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/actions"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/models"
)

// UpdateParams holds parameters for updating a task.
type UpdateParams struct {
	Status          *string
	EntityID        *string
	Components      map[string]interface{}
	Extra           map[string]interface{}
	ExpectedVersion *int64
}

func isNoOpTaskUpdate(params UpdateParams) bool {
	if params.Status != nil || params.EntityID != nil {
		return false
	}
	if len(params.Components) > 0 {
		return false
	}
	if len(params.Extra) > 0 {
		return false
	}
	return true
}

// Update updates a task.
func (a *Actions) Update(ctx context.Context, taskID string, params UpdateParams) (*models.Task, error) {
	if err := actions.ValidateTaskID(taskID); err != nil {
		return nil, err
	}
	taskID = actions.SanitizeID(taskID)

	if isNoOpTaskUpdate(params) {
		task, err := a.Get(ctx, taskID)
		if err != nil {
			return nil, err
		}
		if !actions.ExpectedVersionMatches(params.ExpectedVersion, task.Version) {
			return nil, actions.NewPreconditionFailedError("task")
		}
		return task, nil
	}

	// Begin transaction for atomic read-modify-write.
	tx, err := actions.BeginChangeTx(ctx, a.pool, "task update")
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Fetch existing task with row lock
	var task models.Task
	err = tx.QueryRow(ctx, `
		SELECT task_id, status, entity_id, json, created_at, updated_at, version
		FROM tasks WHERE task_id = $1
		FOR UPDATE
	`, taskID).Scan(
		&task.TaskID, &task.Status, &task.EntityID,
		&task.JSON, &task.CreatedAt, &task.UpdatedAt, &task.Version,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, actions.NewTaskNotFoundError(taskID)
		}
		return nil, fmt.Errorf("failed to get task: %w", err)
	}
	if !actions.ExpectedVersionMatches(params.ExpectedVersion, task.Version) {
		return nil, actions.NewPreconditionFailedError("task")
	}

	// Parse existing JSON
	var existingJSON map[string]interface{}
	if task.JSON != nil {
		if err := json.Unmarshal(task.JSON, &existingJSON); err != nil {
			return nil, fmt.Errorf("failed to parse existing task JSON: %w", err)
		}
		if existingJSON == nil {
			existingJSON = make(map[string]interface{})
		}
	} else {
		existingJSON = make(map[string]interface{})
	}

	// Update status if provided
	newStatus := task.Status
	if params.Status != nil {
		normalized, err := normalizeTaskStatus(*params.Status)
		if err != nil {
			return nil, err
		}
		if err := validateTaskStatusTransition(task.Status, normalized); err != nil {
			return nil, err
		}
		newStatus = normalized
	}

	// Update entity_id if provided
	newEntityID := task.EntityID
	if params.EntityID != nil {
		s := strings.TrimSpace(*params.EntityID)
		if s == "" {
			newEntityID = nil
		} else {
			if err := actions.ValidateEntityID(s); err != nil {
				return nil, err
			}
			newEntityID = &s
		}
	}

	// Validate and merge components
	if params.Components != nil {
		if err := actions.ValidateTaskComponents(params.Components); err != nil {
			return nil, err
		}

		existingComponents, ok := existingJSON["components"].(map[string]interface{})
		if !ok {
			existingComponents = make(map[string]interface{})
		}
		for k, v := range params.Components {
			existingComponents[k] = actions.MergeJSONValue(existingComponents[k], v)
		}
		existingJSON["components"] = existingComponents
	}

	// Merge extra; nil values remove keys (used to clear legacy fields).
	if params.Extra != nil {
		for k, v := range params.Extra {
			if k != "components" && k != "status" && k != "entity_id" && k != "version" {
				if v == nil {
					delete(existingJSON, k)
					continue
				}
				existingJSON[k] = v
			}
		}
	}
	if err := actions.ValidateTaskBlob(existingJSON); err != nil {
		return nil, err
	}

	jsonBytes, err := json.Marshal(existingJSON)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal JSON: %w", err)
	}

	err = tx.QueryRow(ctx, `
		UPDATE tasks
		SET status = $1, entity_id = $2, json = $3,
			updated_at = clock_timestamp(),
			version = nextval('atlas_change_version_seq')
		WHERE task_id = $4
		RETURNING task_id, status, entity_id, json, created_at, updated_at, version
	`, newStatus, newEntityID, jsonBytes, taskID).Scan(
		&task.TaskID, &task.Status, &task.EntityID,
		&task.JSON, &task.CreatedAt, &task.UpdatedAt, &task.Version,
	)
	if err != nil {
		if newEntityID != nil {
			if mapped := translateTaskEntityFK(err, *newEntityID); mapped != nil {
				return nil, mapped
			}
		}
		return nil, fmt.Errorf("failed to update task: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("failed to commit transaction: %w", err)
	}

	return &task, nil
}

func translateTaskEntityFK(err error, entityID string) error {
	if !actions.IsForeignKeyViolation(err) {
		return nil
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.ConstraintName != "" && pgErr.ConstraintName != "tasks_entity_id_fkey" {
		return nil
	}
	return actions.NewEntityNotFoundError(entityID)
}

// Acknowledge marks a task as acknowledged.
func (a *Actions) Acknowledge(ctx context.Context, taskID string, expectedVersion *int64) (*models.Task, error) {
	status := "acknowledged"
	return a.Update(ctx, taskID, UpdateParams{Status: &status, ExpectedVersion: expectedVersion})
}

// Complete marks a task as completed with optional result.
func (a *Actions) Complete(ctx context.Context, taskID string, result map[string]interface{}, expectedVersion *int64) (*models.Task, error) {
	status := "completed"
	var extra map[string]interface{}
	if result != nil {
		extra = map[string]interface{}{"result": result}
	}
	return a.Update(ctx, taskID, UpdateParams{Status: &status, Extra: extra, ExpectedVersion: expectedVersion})
}

// Fail marks a task as failed with optional error details.
func (a *Actions) Fail(ctx context.Context, taskID string, errorDetails map[string]interface{}, expectedVersion *int64) (*models.Task, error) {
	status := "failed"
	var extra map[string]interface{}
	if errorDetails != nil {
		extra = map[string]interface{}{"error": errorDetails}
	}
	return a.Update(ctx, taskID, UpdateParams{Status: &status, Extra: extra, ExpectedVersion: expectedVersion})
}

// normalizeTaskProgressPercent clamps progress to the canonical 0–100 percent scale.
// Values are not auto-scaled from 0–1; e.g. 1 means 1%, not 100%.
func normalizeTaskProgressPercent(p float64) float64 {
	if p < 0 {
		return 0
	}
	if p > 100 {
		return 100
	}
	return p
}

// TransitionStatus updates the task status and optional progress.
func (a *Actions) TransitionStatus(ctx context.Context, taskID, status string, progress *float64, message *string, expectedVersion *int64) (*models.Task, error) {
	var components map[string]interface{}
	var extra map[string]interface{}
	if progress != nil || message != nil {
		components = make(map[string]interface{})
		if progress != nil {
			p := normalizeTaskProgressPercent(*progress)
			components["progress"] = map[string]interface{}{"percent": p}
		}
		if message != nil {
			components["status_message"] = *message
		}
		extra = map[string]interface{}{
			"progress":       nil,
			"message":        nil,
			"status_message": nil,
		}
	}
	return a.Update(ctx, taskID, UpdateParams{Status: &status, Components: components, Extra: extra, ExpectedVersion: expectedVersion})
}
