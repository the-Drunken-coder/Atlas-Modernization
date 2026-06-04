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
func (a *TaskActions) Create(ctx context.Context, params CreateTaskParams) (*models.Task, error) {
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
		if entityID != nil {
			if mapped := translateTaskEntityFK(err, *entityID); mapped != nil {
				return nil, mapped
			}
		}
		return nil, fmt.Errorf("failed to create task: %w", err)
	}

	return &task, nil
}

// Get retrieves a task by ID.
func (a *TaskActions) Get(ctx context.Context, taskID string) (*models.Task, error) {
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

	return &task, nil
}

// List retrieves tasks with pagination.
func (a *TaskActions) List(ctx context.Context, limit int, cursor string) (*ListPage[*models.Task], error) {
	limit = ClampListLimit(limit)

	tx, err := a.pool.BeginTx(ctx, pgx.TxOptions{
		IsoLevel:   pgx.RepeatableRead,
		AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return nil, fmt.Errorf("begin task list transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var txUpperBound time.Time
	if err := tx.QueryRow(ctx, `SELECT statement_timestamp()`).Scan(&txUpperBound); err != nil {
		return nil, fmt.Errorf("read task list snapshot timestamp: %w", err)
	}

	parsedCursor, err := parseQueryCursor(cursor, "cursor")
	if err != nil {
		return nil, err
	}
	snapshotUpperBound, continuation, err := continuationUpperBound(txUpperBound, parsedCursor)
	if err != nil {
		return nil, err
	}
	tasks, hasMore, err := queryTasks(ctx, tx, "created_at", time.Time{}, snapshotUpperBound, continuation, parsedCursor, limit)
	if err != nil {
		return nil, err
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit task list transaction: %w", err)
	}

	page := &ListPage[*models.Task]{
		Items:   tasks,
		Limit:   limit,
		HasMore: hasMore,
	}
	if hasMore && len(tasks) > 0 {
		last := tasks[len(tasks)-1]
		page.NextCursor, err = encodeRowCursor(last.CreatedAt, last.TaskID, snapshotUpperBound)
		if err != nil {
			return nil, fmt.Errorf("encode task cursor: %w", err)
		}
	}
	return page, nil
}

// GetByEntity retrieves tasks for a specific entity.
func (a *TaskActions) GetByEntity(ctx context.Context, entityID string, limit int, cursor string) (*ListPage[*models.Task], error) {
	if err := ValidateEntityID(entityID); err != nil {
		return nil, err
	}
	entityID = SanitizeID(entityID)

	limit = ClampListLimit(limit)

	tx, err := a.pool.BeginTx(ctx, pgx.TxOptions{
		IsoLevel:   pgx.RepeatableRead,
		AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return nil, fmt.Errorf("begin entity task list transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var txUpperBound time.Time
	if err := tx.QueryRow(ctx, `SELECT statement_timestamp()`).Scan(&txUpperBound); err != nil {
		return nil, fmt.Errorf("read entity task list snapshot timestamp: %w", err)
	}

	parsedCursor, err := parseQueryCursor(cursor, "cursor")
	if err != nil {
		return nil, err
	}
	snapshotUpperBound, continuation, err := continuationUpperBound(txUpperBound, parsedCursor)
	if err != nil {
		return nil, err
	}
	tasks, hasMore, err := queryTasksByEntity(ctx, tx, entityID, "created_at", time.Time{}, snapshotUpperBound, continuation, parsedCursor, limit)
	if err != nil {
		return nil, err
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit entity task list transaction: %w", err)
	}

	page := &ListPage[*models.Task]{
		Items:   tasks,
		Limit:   limit,
		HasMore: hasMore,
	}
	if hasMore && len(tasks) > 0 {
		last := tasks[len(tasks)-1]
		page.NextCursor, err = encodeRowCursor(last.CreatedAt, last.TaskID, snapshotUpperBound)
		if err != nil {
			return nil, fmt.Errorf("encode entity task cursor: %w", err)
		}
	}
	return page, nil
}

// GetByEntityFiltered retrieves entity tasks filtered by status and updated-since timestamp.
func (a *TaskActions) GetByEntityFiltered(
	ctx context.Context,
	entityID string,
	statusList []string,
	since *time.Time,
	limit int,
	cursor string,
) (*ListPage[*models.Task], error) {
	if err := ValidateEntityID(entityID); err != nil {
		return nil, err
	}
	entityID = SanitizeID(entityID)

	limit, err := normalizeCheckinTaskLimit(limit)
	if err != nil {
		return nil, err
	}

	tx, err := a.pool.BeginTx(ctx, pgx.TxOptions{
		IsoLevel:   pgx.RepeatableRead,
		AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return nil, fmt.Errorf("begin filtered entity task list transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var txUpperBound time.Time
	if err := tx.QueryRow(ctx, `SELECT statement_timestamp()`).Scan(&txUpperBound); err != nil {
		return nil, fmt.Errorf("read filtered entity task list snapshot timestamp: %w", err)
	}

	parsedCursor, err := parseQueryCursor(cursor, "task_cursor")
	if err != nil {
		return nil, err
	}
	snapshotUpperBound, _, err := continuationUpperBound(txUpperBound, parsedCursor)
	if err != nil {
		return nil, err
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

	if parsedCursor != nil {
		cursorUpperBound := effectiveCursorUpperBound(parsedCursor, snapshotUpperBound)
		if !cursorUpperBound.IsZero() {
			whereClauses = append(whereClauses, fmt.Sprintf("updated_at <= $%d::timestamptz", len(args)+1))
			args = append(args, cursorUpperBound)
		}
		whereClauses = append(whereClauses, fmt.Sprintf("(updated_at, task_id) < ($%d::timestamptz, $%d::varchar)", len(args)+1, len(args)+2))
		args = append(args, parsedCursor.timestamp, parsedCursor.id)
	} else {
		whereClauses = append(whereClauses, fmt.Sprintf("updated_at <= $%d::timestamptz", len(args)+1))
		args = append(args, snapshotUpperBound)
	}

	limitPos := len(args) + 1
	args = append(args, limit+1)

	query := fmt.Sprintf(`
		SELECT task_id, status, entity_id, json, created_at, updated_at
		FROM tasks
		WHERE %s
		ORDER BY updated_at DESC, task_id DESC
		LIMIT $%d
	`, strings.Join(whereClauses, " AND "), limitPos)

	rows, err := tx.Query(ctx, query, args...)
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

	tasks, hasMore := trimToLimitWithMore(tasks, limit)

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit filtered entity task list transaction: %w", err)
	}

	page := &ListPage[*models.Task]{
		Items:   tasks,
		Limit:   limit,
		HasMore: hasMore,
	}
	if hasMore && len(tasks) > 0 {
		last := tasks[len(tasks)-1]
		page.NextCursor, err = encodeRowCursor(last.UpdatedAt, last.TaskID, snapshotUpperBound)
		if err != nil {
			return nil, fmt.Errorf("encode filtered entity task cursor: %w", err)
		}
	}
	return page, nil
}

func normalizeCheckinTaskLimit(limit int) (int, error) {
	const (
		defaultLimit = 10
		maxLimit     = 20
	)
	if limit == 0 {
		return defaultLimit, nil
	}
	if limit < 1 || limit > maxLimit {
		return 0, NewValidationError(fmt.Sprintf("limit must be between 1 and %d for check-in task pagination", maxLimit))
	}
	return limit, nil
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
func (a *TaskActions) Update(ctx context.Context, taskID string, params UpdateTaskParams) (*models.Task, error) {
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
	if !isForeignKeyViolation(err) {
		return nil
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.ConstraintName != "" && pgErr.ConstraintName != "tasks_entity_id_fkey" {
		return nil
	}
	return NewEntityNotFoundError(entityID)
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
func (a *TaskActions) Acknowledge(ctx context.Context, taskID string) (*models.Task, error) {
	status := "acknowledged"
	return a.Update(ctx, taskID, UpdateTaskParams{Status: &status})
}

// Complete marks a task as completed with optional result.
func (a *TaskActions) Complete(ctx context.Context, taskID string, result map[string]interface{}) (*models.Task, error) {
	status := "completed"
	var extra map[string]interface{}
	if result != nil {
		extra = map[string]interface{}{"result": result}
	}
	return a.Update(ctx, taskID, UpdateTaskParams{Status: &status, Extra: extra})
}

// Fail marks a task as failed with optional error details.
func (a *TaskActions) Fail(ctx context.Context, taskID string, errorDetails map[string]interface{}) (*models.Task, error) {
	status := "failed"
	var extra map[string]interface{}
	if errorDetails != nil {
		extra = map[string]interface{}{"error": errorDetails}
	}
	return a.Update(ctx, taskID, UpdateTaskParams{Status: &status, Extra: extra})
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
func (a *TaskActions) TransitionStatus(ctx context.Context, taskID, status string, progress *float64, message *string) (*models.Task, error) {
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
