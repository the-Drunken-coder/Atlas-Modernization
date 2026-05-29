package actions

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/models"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/serializers"
)

// TaskActions handles task business logic.
type TaskActions struct {
	pool *pgxpool.Pool
}

// NewTaskActions creates a new TaskActions instance.
func NewTaskActions(pool *pgxpool.Pool) *TaskActions {
	return &TaskActions{pool: pool}
}

// CreateTaskParams holds parameters for creating a task.
type CreateTaskParams struct {
	TaskID     string
	Status     string
	EntityID   *string
	Components map[string]interface{}
	Extra      map[string]interface{}
}

// Create creates a new task.
func (a *TaskActions) Create(ctx context.Context, params CreateTaskParams) (*serializers.TaskResponse, error) {
	if err := ValidateTaskID(params.TaskID); err != nil {
		return nil, err
	}
	taskID := SanitizeID(params.TaskID)

	status := strings.TrimSpace(params.Status)
	if status == "" {
		status = "pending"
	}

	// Validate components
	if params.Components != nil {
		if err := ValidateTaskComponents(params.Components); err != nil {
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
			if k != "status" && k != "entity_id" && k != "components" {
				jsonData[k] = v
			}
		}
	}

	jsonBytes, err := json.Marshal(jsonData)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal JSON: %w", err)
	}

	var entityID *string
	if params.EntityID != nil && strings.TrimSpace(*params.EntityID) != "" {
		trimmed := strings.TrimSpace(*params.EntityID)
		if err := ValidateEntityID(trimmed); err != nil {
			return nil, err
		}
		entityID = &trimmed
	}

	var task models.Task
	err = a.pool.QueryRow(ctx, `
		INSERT INTO tasks (task_id, status, entity_id, json)
		VALUES ($1, $2, $3, $4)
		RETURNING task_id, status, entity_id, json, created_at, updated_at
	`, taskID, status, entityID, jsonBytes).Scan(
		&task.TaskID, &task.Status, &task.EntityID,
		&task.JSON, &task.CreatedAt, &task.UpdatedAt,
	)
	if err != nil {
		if isUniqueViolation(err) {
			var pgErr *pgconn.PgError
			if errors.As(err, &pgErr) && pgErr.ConstraintName == "tasks_pkey" {
				return nil, NewTaskConflictError(taskID)
			}
		}
		return nil, fmt.Errorf("failed to create task: %w", err)
	}

	return serializers.SerializeTask(&task), nil
}

// Get retrieves a task by ID.
func (a *TaskActions) Get(ctx context.Context, taskID string) (*serializers.TaskResponse, error) {
	if err := ValidateTaskID(taskID); err != nil {
		return nil, err
	}
	taskID = SanitizeID(taskID)

	var task models.Task
	err := a.pool.QueryRow(ctx, `
		SELECT task_id, status, entity_id, json, created_at, updated_at
		FROM tasks WHERE task_id = $1
	`, taskID).Scan(
		&task.TaskID, &task.Status, &task.EntityID,
		&task.JSON, &task.CreatedAt, &task.UpdatedAt,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, NewTaskNotFoundError(taskID)
		}
		return nil, fmt.Errorf("failed to get task: %w", err)
	}

	return serializers.SerializeTask(&task), nil
}

// List retrieves tasks with pagination.
func (a *TaskActions) List(ctx context.Context, limit, offset int) ([]*serializers.TaskResponse, int, error) {
	limit = ClampListLimit(limit)
	if offset < 0 {
		offset = 0
	}

	// Get tasks with total count using window function (single query)
	rows, err := a.pool.Query(ctx, `
		SELECT task_id, status, entity_id, json, created_at, updated_at,
		       COUNT(*) OVER() as total_count
		FROM tasks
		ORDER BY created_at DESC, task_id DESC
		LIMIT $1 OFFSET $2
	`, limit, offset)
	if err != nil {
		return nil, 0, fmt.Errorf("failed to list tasks: %w", err)
	}
	defer rows.Close()

	var total int
	var tasks []*models.Task
	for rows.Next() {
		var t models.Task
		if err := rows.Scan(&t.TaskID, &t.Status, &t.EntityID, &t.JSON, &t.CreatedAt, &t.UpdatedAt, &total); err != nil {
			return nil, 0, fmt.Errorf("failed to scan task: %w", err)
		}
		tasks = append(tasks, &t)
	}

	if err := rows.Err(); err != nil {
		return nil, 0, fmt.Errorf("failed to iterate tasks: %w", err)
	}

	if len(tasks) == 0 {
		if err := a.pool.QueryRow(ctx, `SELECT COUNT(*) FROM tasks`).Scan(&total); err != nil {
			return nil, 0, fmt.Errorf("failed to count tasks: %w", err)
		}
	}

	return serializers.SerializeTasks(tasks), total, nil
}

// GetByEntity retrieves tasks for a specific entity.
func (a *TaskActions) GetByEntity(ctx context.Context, entityID string, limit, offset int) ([]*serializers.TaskResponse, int, error) {
	if err := ValidateEntityID(entityID); err != nil {
		return nil, 0, err
	}
	entityID = SanitizeID(entityID)

	limit = ClampListLimit(limit)
	if offset < 0 {
		offset = 0
	}

	// Get tasks with total count using window function (single query)
	rows, err := a.pool.Query(ctx, `
		SELECT task_id, status, entity_id, json, created_at, updated_at,
		       COUNT(*) OVER() as total_count
		FROM tasks WHERE entity_id = $1
		ORDER BY created_at DESC, task_id DESC
		LIMIT $2 OFFSET $3
	`, entityID, limit, offset)
	if err != nil {
		return nil, 0, fmt.Errorf("failed to list tasks: %w", err)
	}
	defer rows.Close()

	var total int
	var tasks []*models.Task
	for rows.Next() {
		var t models.Task
		if err := rows.Scan(&t.TaskID, &t.Status, &t.EntityID, &t.JSON, &t.CreatedAt, &t.UpdatedAt, &total); err != nil {
			return nil, 0, fmt.Errorf("failed to scan task: %w", err)
		}
		tasks = append(tasks, &t)
	}

	if err := rows.Err(); err != nil {
		return nil, 0, fmt.Errorf("failed to iterate tasks: %w", err)
	}

	if len(tasks) == 0 {
		if err := a.pool.QueryRow(ctx, `SELECT COUNT(*) FROM tasks WHERE entity_id = $1`, entityID).Scan(&total); err != nil {
			return nil, 0, fmt.Errorf("failed to count tasks: %w", err)
		}
	}

	return serializers.SerializeTasks(tasks), total, nil
}

// GetByEntityFiltered retrieves entity tasks filtered by status and updated-since timestamp.
func (a *TaskActions) GetByEntityFiltered(
	ctx context.Context,
	entityID string,
	statusList []string,
	since *time.Time,
	limit, offset int,
) ([]*serializers.TaskResponse, error) {
	if err := ValidateEntityID(entityID); err != nil {
		return nil, err
	}
	entityID = SanitizeID(entityID)

	limit = ClampLimit(limit, 10, MaxListLimit)
	if offset < 0 {
		offset = 0
	}

	whereClauses := []string{"entity_id = $1"}
	args := []interface{}{entityID}

	normalizedStatuses := make([]string, 0, len(statusList))
	for _, status := range statusList {
		s := strings.ToLower(strings.TrimSpace(status))
		if s != "" {
			normalizedStatuses = append(normalizedStatuses, s)
		}
	}
	if len(normalizedStatuses) > 0 {
		whereClauses = append(whereClauses, fmt.Sprintf("LOWER(status) = ANY($%d)", len(args)+1))
		args = append(args, normalizedStatuses)
	}

	if since != nil {
		whereClauses = append(whereClauses, fmt.Sprintf("updated_at >= $%d", len(args)+1))
		args = append(args, *since)
	}

	limitPos := len(args) + 1
	args = append(args, limit)
	offsetPos := len(args) + 1
	args = append(args, offset)

	query := fmt.Sprintf(`
		SELECT task_id, status, entity_id, json, created_at, updated_at
		FROM tasks
		WHERE %s
		ORDER BY updated_at DESC, task_id DESC
		LIMIT $%d OFFSET $%d
	`, strings.Join(whereClauses, " AND "), limitPos, offsetPos)

	rows, err := a.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("failed to list tasks: %w", err)
	}
	defer rows.Close()

	var tasks []*models.Task
	for rows.Next() {
		var t models.Task
		if err := rows.Scan(&t.TaskID, &t.Status, &t.EntityID, &t.JSON, &t.CreatedAt, &t.UpdatedAt); err != nil {
			return nil, fmt.Errorf("failed to scan task: %w", err)
		}
		tasks = append(tasks, &t)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("failed to iterate tasks: %w", err)
	}

	return serializers.SerializeTasks(tasks), nil
}

// UpdateTaskParams holds parameters for updating a task.
type UpdateTaskParams struct {
	Status     *string
	EntityID   *string
	Components map[string]interface{}
	Extra      map[string]interface{}
}

func isNoOpTaskUpdate(params UpdateTaskParams) bool {
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
func (a *TaskActions) Update(ctx context.Context, taskID string, params UpdateTaskParams) (*serializers.TaskResponse, error) {
	if err := ValidateTaskID(taskID); err != nil {
		return nil, err
	}
	taskID = SanitizeID(taskID)

	if isNoOpTaskUpdate(params) {
		return a.Get(ctx, taskID)
	}

	// Begin transaction for atomic read-modify-write
	tx, err := a.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Fetch existing task with row lock
	var task models.Task
	err = tx.QueryRow(ctx, `
		SELECT task_id, status, entity_id, json, created_at, updated_at
		FROM tasks WHERE task_id = $1
		FOR UPDATE
	`, taskID).Scan(
		&task.TaskID, &task.Status, &task.EntityID,
		&task.JSON, &task.CreatedAt, &task.UpdatedAt,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, NewTaskNotFoundError(taskID)
		}
		return nil, fmt.Errorf("failed to get task: %w", err)
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
		trimmed := strings.TrimSpace(*params.Status)
		if trimmed == "" {
			return nil, NewValidationError("status must not be empty")
		}
		newStatus = trimmed
	}

	// Update entity_id if provided
	newEntityID := task.EntityID
	if params.EntityID != nil {
		s := strings.TrimSpace(*params.EntityID)
		if s == "" {
			newEntityID = nil
		} else {
			if err := ValidateEntityID(s); err != nil {
				return nil, err
			}
			newEntityID = &s
		}
	}

	// Validate and merge components
	if params.Components != nil {
		if err := ValidateTaskComponents(params.Components); err != nil {
			return nil, err
		}

		existingComponents, ok := existingJSON["components"].(map[string]interface{})
		if !ok {
			existingComponents = make(map[string]interface{})
		}
		for k, v := range params.Components {
			existingComponents[k] = mergeJSONValue(existingComponents[k], v)
		}
		existingJSON["components"] = existingComponents
	}

	// Merge extra; nil values remove keys (used to clear legacy fields).
	if params.Extra != nil {
		for k, v := range params.Extra {
			if k != "components" && k != "status" && k != "entity_id" {
				if v == nil {
					delete(existingJSON, k)
					continue
				}
				existingJSON[k] = v
			}
		}
	}

	jsonBytes, err := json.Marshal(existingJSON)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal JSON: %w", err)
	}

	err = tx.QueryRow(ctx, `
		UPDATE tasks SET status = $1, entity_id = $2, json = $3, updated_at = CURRENT_TIMESTAMP
		WHERE task_id = $4
		RETURNING task_id, status, entity_id, json, created_at, updated_at
	`, newStatus, newEntityID, jsonBytes, taskID).Scan(
		&task.TaskID, &task.Status, &task.EntityID,
		&task.JSON, &task.CreatedAt, &task.UpdatedAt,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to update task: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("failed to commit transaction: %w", err)
	}

	return serializers.SerializeTask(&task), nil
}

// Delete removes a task.
func (a *TaskActions) Delete(ctx context.Context, taskID string) error {
	if err := ValidateTaskID(taskID); err != nil {
		return err
	}
	taskID = SanitizeID(taskID)

	tx, err := a.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("failed to begin delete transaction: %w", err)
	}
	defer func() {
		_ = tx.Rollback(ctx)
	}()

	result, err := tx.Exec(ctx, "DELETE FROM tasks WHERE task_id = $1", taskID)
	if err != nil {
		return fmt.Errorf("failed to delete task: %w", err)
	}

	if result.RowsAffected() == 0 {
		return NewTaskNotFoundError(taskID)
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

// Acknowledge marks a task as acknowledged.
func (a *TaskActions) Acknowledge(ctx context.Context, taskID string) (*serializers.TaskResponse, error) {
	status := "acknowledged"
	return a.Update(ctx, taskID, UpdateTaskParams{Status: &status})
}

// Complete marks a task as completed with optional result.
func (a *TaskActions) Complete(ctx context.Context, taskID string, result map[string]interface{}) (*serializers.TaskResponse, error) {
	status := "completed"
	var extra map[string]interface{}
	if result != nil {
		extra = map[string]interface{}{"result": result}
	}
	return a.Update(ctx, taskID, UpdateTaskParams{Status: &status, Extra: extra})
}

// Fail marks a task as failed with optional error details.
func (a *TaskActions) Fail(ctx context.Context, taskID string, errorDetails map[string]interface{}) (*serializers.TaskResponse, error) {
	status := "failed"
	var extra map[string]interface{}
	if errorDetails != nil {
		extra = map[string]interface{}{"error": errorDetails}
	}
	return a.Update(ctx, taskID, UpdateTaskParams{Status: &status, Extra: extra})
}

// TransitionStatus updates the task status and optional progress.
func (a *TaskActions) TransitionStatus(ctx context.Context, taskID, status string, progress *float64, message *string) (*serializers.TaskResponse, error) {
	var components map[string]interface{}
	var extra map[string]interface{}
	if progress != nil || message != nil {
		components = make(map[string]interface{})
		if progress != nil {
			p := *progress
			// Accept 0–1 or 0–100 for API convenience; store as progress.percent (0–100).
			if p > 0 && p < 1 {
				p *= 100
			}
			if p < 0 {
				p = 0
			}
			if p > 100 {
				p = 100
			}
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
	return a.Update(ctx, taskID, UpdateTaskParams{Status: &status, Components: components, Extra: extra})
}

// Count returns the total number of tasks.
func (a *TaskActions) Count(ctx context.Context) (int, error) {
	var count int
	err := a.pool.QueryRow(ctx, "SELECT COUNT(*) FROM tasks").Scan(&count)
	if err != nil {
		return 0, fmt.Errorf("failed to count tasks: %w", err)
	}
	return count, nil
}
