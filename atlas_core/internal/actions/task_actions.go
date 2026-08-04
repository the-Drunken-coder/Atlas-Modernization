package actions

import (
	"context"
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
	commandID := ""
	if isCommandTask(params.Components) {
		normalized, normalizedCommandID, err := a.prepareCommandTask(params)
		if err != nil {
			return nil, err
		}
		params = normalized
		commandID = normalizedCommandID
	}
	if err := ValidateTaskID(params.TaskID); err != nil {
		return nil, err
	}
	taskID := SanitizeID(params.TaskID)

	status, err := normalizeInitialTaskStatus(params.Status)
	if err != nil {
		return nil, err
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
		jsonData[string(jsonBlobFieldComponents)] = params.Components
	}
	mergeBlobExtraFields(jsonData, params.Extra, taskPromotedBlobFields)

	jsonBytes, err := marshalValidatedJSONBlob(jsonData, ValidateTaskBlob)
	if err != nil {
		return nil, err
	}

	var entityID *string
	if params.EntityID != nil && strings.TrimSpace(*params.EntityID) != "" {
		trimmed := strings.TrimSpace(*params.EntityID)
		if err := ValidateEntityID(trimmed); err != nil {
			return nil, err
		}
		entityID = &trimmed
	}

	tx, err := beginChangeTx(ctx, a.pool, "task create")
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if commandID != "" {
		entity, err := getCommandTargetEntity(ctx, tx, *entityID)
		if err != nil {
			return nil, err
		}
		if err := entitySupportsCommand(entity, commandID); err != nil {
			return nil, err
		}
	}

	version, err := nextChangeVersion(ctx, tx)
	if err != nil {
		return nil, err
	}
	var task models.Task
	err = tx.QueryRow(ctx, `
		INSERT INTO tasks (task_id, status, entity_id, json, version)
		VALUES ($1, $2, $3, $4, $5)
		RETURNING task_id, status, entity_id, json, created_at, updated_at, version
	`, taskID, status, entityID, jsonBytes, version).Scan(
		&task.TaskID, &task.Status, &task.EntityID,
		&task.JSON, &task.CreatedAt, &task.UpdatedAt, &task.Version,
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
	if err := RecordResourceChange(ctx, tx, ResourceChange{
		Event:        ChangeEventCreate,
		ResourceType: ChangeResourceTask,
		ID:           task.TaskID,
		Version:      task.Version,
		AfterTask:    cloneTaskModel(&task),
	}); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("failed to commit task create transaction: %w", err)
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
		SELECT task_id, status, entity_id, json, created_at, updated_at, version
		FROM tasks WHERE task_id = $1
	`, taskID).Scan(
		&task.TaskID, &task.Status, &task.EntityID,
		&task.JSON, &task.CreatedAt, &task.UpdatedAt, &task.Version,
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
	return readCursorListPage(ctx, a.pool, cursorListPageOptions[*models.Task]{
		limit:       limit,
		cursor:      cursor,
		cursorLabel: "cursor",
		operation:   "task list",
		cursorName:  "task",
		query: func(ctx context.Context, tx pgx.Tx, snapshotUpperBound time.Time, continuation bool, parsedCursor *parsedQueryCursor, limit int) ([]*models.Task, bool, error) {
			return queryTasks(ctx, tx, "created_at", time.Time{}, snapshotUpperBound, continuation, parsedCursor, limit, 0)
		},
		rowCursor: func(task *models.Task) (time.Time, string) {
			return task.CreatedAt, task.TaskID
		},
	})
}

// GetByEntity retrieves tasks for a specific entity.
func (a *TaskActions) GetByEntity(ctx context.Context, entityID string, limit int, cursor string) (*ListPage[*models.Task], error) {
	if err := ValidateEntityID(entityID); err != nil {
		return nil, err
	}
	entityID = SanitizeID(entityID)

	limit = ClampListLimit(limit)
	return readCursorListPage(ctx, a.pool, cursorListPageOptions[*models.Task]{
		limit:       limit,
		cursor:      cursor,
		cursorLabel: "cursor",
		operation:   "entity task list",
		cursorName:  "entity task",
		query: func(ctx context.Context, tx pgx.Tx, snapshotUpperBound time.Time, continuation bool, parsedCursor *parsedQueryCursor, limit int) ([]*models.Task, bool, error) {
			return queryTasksByEntity(ctx, tx, entityID, "created_at", time.Time{}, snapshotUpperBound, continuation, parsedCursor, limit)
		},
		rowCursor: func(task *models.Task) (time.Time, string) {
			return task.CreatedAt, task.TaskID
		},
	})
}

// UpdateTaskParams holds parameters for updating a task.
type UpdateTaskParams struct {
	Status           *string
	EntityID         *string
	Components       map[string]interface{}
	Extra            map[string]interface{}
	RemoveExtraKeys  []string
	ExpectedVersion  *int64
	idempotentStatus bool
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
	if len(params.RemoveExtraKeys) > 0 {
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

	if isNoOpTaskUpdate(params) && params.ExpectedVersion == nil {
		return a.Get(ctx, taskID)
	}

	// Begin transaction for atomic read-modify-write.
	tx, err := beginChangeTx(ctx, a.pool, "task update")
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
			return nil, NewTaskNotFoundError(taskID)
		}
		return nil, fmt.Errorf("failed to get task: %w", err)
	}
	if err := checkExpectedVersion("task", params.ExpectedVersion, task.Version); err != nil {
		return nil, err
	}
	before := cloneTaskModel(&task)
	if isNoOpTaskUpdate(params) {
		if err := tx.Commit(ctx); err != nil {
			return nil, fmt.Errorf("failed to commit task precondition transaction: %w", err)
		}
		return &task, nil
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
		if params.idempotentStatus && task.Status == normalized {
			if err := tx.Commit(ctx); err != nil {
				return nil, fmt.Errorf("failed to commit idempotent task update: %w", err)
			}
			return &task, nil
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
			if err := ValidateEntityID(s); err != nil {
				return nil, err
			}
			newEntityID = &s
		}
	}

	jsonBytes, err := patchValidatedJSONBlob(jsonBlobPatch{
		rawMessage:      task.JSON,
		decodeMode:      jsonBlobDecodeDefault,
		decodeError:     "failed to parse existing task JSON",
		components:      params.Components,
		mergeComponents: mergeTaskComponents,
		extra:           params.Extra,
		removeExtraKeys: params.RemoveExtraKeys,
		promotedFields:  taskPromotedBlobFields,
		validate:        ValidateTaskBlob,
	})
	if err != nil {
		return nil, err
	}

	version, err := nextChangeVersion(ctx, tx)
	if err != nil {
		return nil, err
	}
	err = tx.QueryRow(ctx, `
		UPDATE tasks
		SET status = $1, entity_id = $2, json = $3,
			updated_at = clock_timestamp(),
			version = $4
		WHERE task_id = $5
		RETURNING task_id, status, entity_id, json, created_at, updated_at, version
	`, newStatus, newEntityID, jsonBytes, version, taskID).Scan(
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

	if err := RecordResourceChange(ctx, tx, ResourceChange{
		Event:        ChangeEventUpdate,
		ResourceType: ChangeResourceTask,
		ID:           task.TaskID,
		Version:      task.Version,
		BeforeTask:   before,
		AfterTask:    cloneTaskModel(&task),
	}); err != nil {
		return nil, err
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

	tx, err := beginChangeTx(ctx, a.pool, "task delete")
	if err != nil {
		return err
	}
	defer func() {
		_ = tx.Rollback(ctx)
	}()

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
			return NewTaskNotFoundError(taskID)
		}
		return fmt.Errorf("failed to get task for deletion: %w", err)
	}

	result, err := tx.Exec(ctx, "DELETE FROM tasks WHERE task_id = $1", taskID)
	if err != nil {
		return fmt.Errorf("failed to delete task: %w", err)
	}

	if result.RowsAffected() == 0 {
		return NewTaskNotFoundError(taskID)
	}

	deleteVersion, err := nextChangeVersion(ctx, tx)
	if err != nil {
		return err
	}
	if err := RecordResourceChange(ctx, tx, ResourceChange{
		Event:        ChangeEventDelete,
		ResourceType: ChangeResourceTask,
		ID:           task.TaskID,
		Version:      deleteVersion,
		BeforeTask:   cloneTaskModel(&task),
	}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("failed to commit delete transaction: %w", err)
	}

	return nil
}
