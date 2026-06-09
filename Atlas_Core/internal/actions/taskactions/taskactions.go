// Package taskactions provides task CRUD and status state-machine business logic.
package taskactions

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/actions"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/models"
)

// Actions handles task business logic.
type Actions struct {
	pool *pgxpool.Pool
}

// New creates a new task Actions instance.
func New(pool *pgxpool.Pool) *Actions {
	return &Actions{pool: pool}
}

func normalizeTaskStatus(raw string) (string, error) {
	status := strings.ToLower(strings.TrimSpace(raw))
	switch status {
	case "pending", "acknowledged", "completed", "failed", "cancelled":
		return status, nil
	case "":
		return "", actions.NewValidationError("status must not be empty")
	default:
		return "", actions.NewValidationError("invalid status")
	}
}

func normalizeInitialTaskStatus(raw string) (string, error) {
	if strings.TrimSpace(raw) == "" {
		return "pending", nil
	}
	status, err := normalizeTaskStatus(raw)
	if err != nil {
		return "", err
	}
	if status != "pending" {
		return "", actions.NewValidationError("new tasks must start as pending")
	}
	return status, nil
}

var allowedTaskStatusTransitions = map[string]map[string]struct{}{
	"pending": {
		"acknowledged": {},
		"completed":    {},
		"failed":       {},
		"cancelled":    {},
	},
	"acknowledged": {
		"completed": {},
		"failed":    {},
		"cancelled": {},
	},
	"completed": {},
	"failed":    {},
	"cancelled": {},
}

func validateTaskStatusTransition(current, next string) error {
	if current == next {
		return nil
	}
	allowed, ok := allowedTaskStatusTransitions[current]
	if !ok {
		return actions.NewValidationError(fmt.Sprintf("unknown current task status %q", current))
	}
	if _, ok := allowed[next]; ok {
		return nil
	}
	return actions.NewValidationError(fmt.Sprintf("invalid task status transition from %q to %q", current, next))
}

// CreateParams holds parameters for creating a task.
type CreateParams struct {
	TaskID     string
	Status     string
	EntityID   *string
	Components map[string]interface{}
	Extra      map[string]interface{}
}

// Create creates a new task.
func (a *Actions) Create(ctx context.Context, params CreateParams) (*models.Task, error) {
	if err := actions.ValidateTaskID(params.TaskID); err != nil {
		return nil, err
	}
	taskID := actions.SanitizeID(params.TaskID)

	status, err := normalizeInitialTaskStatus(params.Status)
	if err != nil {
		return nil, err
	}

	// Validate components
	if params.Components != nil {
		if err := actions.ValidateTaskComponents(params.Components); err != nil {
			return nil, err
		}
	}

	// Build JSON payload
	jsonData := make(map[string]interface{})
	if params.Components != nil {
		jsonData["components"] = params.Components
	}
	if params.Extra != nil {
		for k, v := range params.Extra {
			if k != "status" && k != "entity_id" && k != "components" && k != "version" {
				jsonData[k] = v
			}
		}
	}
	if err := actions.ValidateTaskBlob(jsonData); err != nil {
		return nil, err
	}

	jsonBytes, err := json.Marshal(jsonData)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal JSON: %w", err)
	}

	var entityID *string
	if params.EntityID != nil && strings.TrimSpace(*params.EntityID) != "" {
		trimmed := strings.TrimSpace(*params.EntityID)
		if err := actions.ValidateEntityID(trimmed); err != nil {
			return nil, err
		}
		entityID = &trimmed
	}

	tx, err := actions.BeginChangeTx(ctx, a.pool, "task create")
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var task models.Task
	err = tx.QueryRow(ctx, `
		INSERT INTO tasks (task_id, status, entity_id, json)
		VALUES ($1, $2, $3, $4)
		RETURNING task_id, status, entity_id, json, created_at, updated_at, version
	`, taskID, status, entityID, jsonBytes).Scan(
		&task.TaskID, &task.Status, &task.EntityID,
		&task.JSON, &task.CreatedAt, &task.UpdatedAt, &task.Version,
	)
	if err != nil {
		if actions.IsUniqueViolation(err) {
			var pgErr *pgconn.PgError
			if errors.As(err, &pgErr) && pgErr.ConstraintName == "tasks_pkey" {
				return nil, actions.NewTaskConflictError(taskID)
			}
		}
		if entityID != nil {
			if mapped := translateTaskEntityFK(err, *entityID); mapped != nil {
				return nil, mapped
			}
		}
		return nil, fmt.Errorf("failed to create task: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("failed to commit task create transaction: %w", err)
	}

	return &task, nil
}

// Get retrieves a task by ID.
func (a *Actions) Get(ctx context.Context, taskID string) (*models.Task, error) {
	if err := actions.ValidateTaskID(taskID); err != nil {
		return nil, err
	}
	taskID = actions.SanitizeID(taskID)

	var task models.Task
	err := a.pool.QueryRow(ctx, `
		SELECT task_id, status, entity_id, json, created_at, updated_at, version
		FROM tasks WHERE task_id = $1
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

	return &task, nil
}

// Delete removes a task.
func (a *Actions) Delete(ctx context.Context, taskID string) error {
	if err := actions.ValidateTaskID(taskID); err != nil {
		return err
	}
	taskID = actions.SanitizeID(taskID)

	tx, err := actions.BeginChangeTx(ctx, a.pool, "task delete")
	if err != nil {
		return err
	}
	defer func() {
		_ = tx.Rollback(ctx)
	}()

	result, err := tx.Exec(ctx, "DELETE FROM tasks WHERE task_id = $1", taskID)
	if err != nil {
		return fmt.Errorf("failed to delete task: %w", err)
	}

	if result.RowsAffected() == 0 {
		return actions.NewTaskNotFoundError(taskID)
	}

	// Record tombstone so changed-since can notify clients
	if _, err := tx.Exec(ctx,
		"INSERT INTO deletions (resource_type, resource_id) VALUES ('task', $1)", taskID); err != nil {
		return fmt.Errorf("failed to record task deletion tombstone: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("failed to commit delete transaction: %w", err)
	}

	return nil
}

// Count returns the total number of tasks.
func (a *Actions) Count(ctx context.Context) (int, error) {
	var count int
	err := a.pool.QueryRow(ctx, "SELECT COUNT(*) FROM tasks").Scan(&count)
	if err != nil {
		return 0, fmt.Errorf("failed to count tasks: %w", err)
	}
	return count, nil
}
