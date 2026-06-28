package actions

import (
	"context"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	commandcatalog "github.com/the-drunken-coder/atlas/atlas_core/command_catalog"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/models"
)

// TaskActions handles task business logic.
type TaskActions struct {
	pool       *pgxpool.Pool
	changeSink ChangeSink
}

// NewTaskActions creates a new TaskActions instance.
func NewTaskActions(pool *pgxpool.Pool) *TaskActions {
	return NewTaskActionsWithChangeSink(pool, nil)
}

// NewTaskActionsWithChangeSink creates a new TaskActions instance that emits
// committed changes to sink.
func NewTaskActionsWithChangeSink(pool *pgxpool.Pool, sink ChangeSink) *TaskActions {
	return &TaskActions{pool: pool, changeSink: sink}
}

func normalizeTaskStatus(raw string) (string, error) {
	status := strings.ToLower(strings.TrimSpace(raw))
	switch status {
	case "pending", "acknowledged", "completed", "failed", "cancelled":
		return status, nil
	case "":
		return "", NewValidationError("status must not be empty")
	default:
		return "", NewValidationError("invalid status")
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
		return "", NewValidationError("new tasks must start as pending")
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
		return NewValidationError(fmt.Sprintf("unknown current task status %q", current))
	}
	if _, ok := allowed[next]; ok {
		return nil
	}
	return NewValidationError(fmt.Sprintf("invalid task status transition from %q to %q", current, next))
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
	if isCommandTask(params.Components) {
		normalized, err := a.prepareCommandTask(ctx, params)
		if err != nil {
			return nil, err
		}
		params = normalized
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
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("failed to commit task create transaction: %w", err)
	}

	publishChange(a.changeSink, ResourceChange{
		Event:        ChangeEventCreate,
		ResourceType: ChangeResourceTask,
		ID:           task.TaskID,
		Version:      task.Version,
		AfterTask:    cloneTaskModel(&task),
	})

	return &task, nil
}

func isCommandTask(components map[string]interface{}) bool {
	if components == nil {
		return false
	}
	_, ok := components["command"]
	return ok
}

func (a *TaskActions) prepareCommandTask(ctx context.Context, params CreateTaskParams) (CreateTaskParams, error) {
	if strings.TrimSpace(params.TaskID) != "" {
		return params, NewValidationError("command task_id must be generated by Core")
	}
	if params.EntityID == nil || strings.TrimSpace(*params.EntityID) == "" {
		return params, NewValidationError("command tasks require entity_id")
	}
	entityID := SanitizeID(*params.EntityID)
	if err := ValidateEntityID(entityID); err != nil {
		return params, err
	}
	entity, err := a.getCommandTargetEntity(ctx, entityID)
	if err != nil {
		return params, err
	}
	commandID, err := commandIDFromComponents(params.Components)
	if err != nil {
		return params, err
	}
	if err := entitySupportsCommand(entity, commandID); err != nil {
		return params, err
	}
	catalog, err := commandcatalog.Default()
	if err != nil {
		return params, fmt.Errorf("failed to load command catalog: %w", err)
	}
	command, ok := catalog.Command(commandID)
	if !ok {
		return params, NewValidationError("unsupported command id")
	}
	coerced, err := command.CoerceParameters(params.Components["parameters"])
	if err != nil {
		return params, NewValidationError(err.Error())
	}
	params.TaskID = "command-" + uuid.NewString()
	params.Status = "pending"
	params.EntityID = &entityID
	params.Components = cloneMap(params.Components)
	params.Components["command"] = map[string]interface{}{"type": commandID, "id": commandID}
	params.Components["parameters"] = coerced
	return params, nil
}

func (a *TaskActions) getCommandTargetEntity(ctx context.Context, entityID string) (*models.Entity, error) {
	var entity models.Entity
	err := a.pool.QueryRow(ctx, `
		SELECT entity_id, type, subtype, alias, json, created_at, updated_at, version
		FROM entities WHERE entity_id = $1
	`, entityID).Scan(
		&entity.EntityID, &entity.Type, &entity.Subtype, &entity.Alias,
		&entity.JSON, &entity.CreatedAt, &entity.UpdatedAt, &entity.Version,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, NewEntityNotFoundError(entityID)
		}
		return nil, fmt.Errorf("failed to load command target entity: %w", err)
	}
	return &entity, nil
}

func commandIDFromComponents(components map[string]interface{}) (string, error) {
	command, ok := components["command"].(map[string]interface{})
	if !ok {
		return "", NewValidationError("command component must be an object")
	}
	id, _ := command["id"].(string)
	typ, _ := command["type"].(string)
	id = strings.TrimSpace(id)
	typ = strings.TrimSpace(typ)
	if id == "" {
		id = typ
	}
	if typ == "" {
		typ = id
	}
	if id == "" || typ == "" {
		return "", NewValidationError("command id is required")
	}
	if id != typ {
		return "", NewValidationError("command id and type must match")
	}
	return id, nil
}

func entitySupportsCommand(entity *models.Entity, commandID string) error {
	if entity.Type != "asset" {
		return NewValidationError("only asset entities can receive commands")
	}
	components := entity.GetComponents()
	taskCatalog, ok := components["task_catalog"].(map[string]interface{})
	if !ok {
		return NewValidationError("entity does not advertise command support")
	}
	supported, ok := taskCatalog["supported_tasks"].([]interface{})
	if !ok {
		return NewValidationError("entity does not advertise command support")
	}
	for _, value := range supported {
		if value == commandID {
			return nil
		}
	}
	return NewValidationError("entity does not support command")
}

func cloneMap(input map[string]interface{}) map[string]interface{} {
	out := make(map[string]interface{}, len(input))
	for key, value := range input {
		out[key] = value
	}
	return out
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
			return queryTasks(ctx, tx, "created_at", time.Time{}, snapshotUpperBound, continuation, parsedCursor, limit)
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

	normalizedStatuses := make([]string, 0, len(statusList))
	for _, status := range statusList {
		s := strings.ToLower(strings.TrimSpace(status))
		if s != "" {
			normalizedStatuses = append(normalizedStatuses, s)
		}
	}
	return readCursorListPage(ctx, a.pool, cursorListPageOptions[*models.Task]{
		limit:       limit,
		cursor:      cursor,
		cursorLabel: "task_cursor",
		operation:   "filtered entity task list",
		cursorName:  "filtered entity task",
		query: func(ctx context.Context, tx pgx.Tx, snapshotUpperBound time.Time, _ bool, parsedCursor *parsedQueryCursor, limit int) ([]*models.Task, bool, error) {
			return queryTasksByEntityFiltered(ctx, tx, entityID, normalizedStatuses, since, snapshotUpperBound, parsedCursor, limit)
		},
		rowCursor: func(task *models.Task) (time.Time, string) {
			return task.UpdatedAt, task.TaskID
		},
	})
}

func queryTasksByEntityFiltered(
	ctx context.Context,
	tx pgx.Tx,
	entityID string,
	normalizedStatuses []string,
	since *time.Time,
	snapshotUpperBound time.Time,
	parsedCursor *parsedQueryCursor,
	limit int,
) ([]*models.Task, bool, error) {
	whereClauses := []string{"entity_id = $1"}
	args := []interface{}{entityID}

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
		SELECT task_id, status, entity_id, json, created_at, updated_at, version
		FROM tasks
		WHERE %s
		ORDER BY updated_at DESC, task_id DESC
		LIMIT $%d
	`, strings.Join(whereClauses, " AND "), limitPos)

	rows, err := tx.Query(ctx, query, args...)
	if err != nil {
		return nil, false, fmt.Errorf("failed to list tasks: %w", err)
	}
	tasks, err := collectTasks(rows)
	if err != nil {
		return nil, false, err
	}
	out, hasMore := trimToLimitWithMore(tasks, limit)
	return out, hasMore, nil
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
	Status          *string
	EntityID        *string
	Components      map[string]interface{}
	Extra           map[string]interface{}
	RemoveExtraKeys []string
	ExpectedVersion *int64
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

	existingJSON, err := decodeJSONBlobForPatch(task.JSON, jsonBlobDecodeDefault)
	if err != nil {
		return nil, fmt.Errorf("failed to parse existing task JSON: %w", err)
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
			if err := ValidateEntityID(s); err != nil {
				return nil, err
			}
			newEntityID = &s
		}
	}

	if err := mergeTaskComponents(existingJSON, params.Components); err != nil {
		return nil, err
	}

	removeTaskExtraKeys(existingJSON, params.RemoveExtraKeys...)

	mergeBlobExtraFields(existingJSON, params.Extra, taskPromotedBlobFields)
	jsonBytes, err := marshalValidatedJSONBlob(existingJSON, ValidateTaskBlob)
	if err != nil {
		return nil, err
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

	publishChange(a.changeSink, ResourceChange{
		Event:        ChangeEventUpdate,
		ResourceType: ChangeResourceTask,
		ID:           task.TaskID,
		Version:      task.Version,
		BeforeTask:   before,
		AfterTask:    cloneTaskModel(&task),
	})

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

	// Record tombstone with entity_id context so changed-since can notify clients which entity's tasks changed.
	var tombstoneVersion int64
	if err := tx.QueryRow(ctx,
		"INSERT INTO deletions (resource_type, resource_id, context) VALUES ($1, $2, jsonb_strip_nulls(jsonb_build_object('entity_id', $3::text))) RETURNING version",
		ChangeResourceTask, taskID, task.EntityID,
	).Scan(&tombstoneVersion); err != nil {
		return fmt.Errorf("failed to record task deletion tombstone: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("failed to commit delete transaction: %w", err)
	}

	publishChange(a.changeSink, ResourceChange{
		Event:        ChangeEventDelete,
		ResourceType: ChangeResourceTask,
		ID:           task.TaskID,
		Version:      tombstoneVersion,
		BeforeTask:   cloneTaskModel(&task),
	})

	return nil
}

// Acknowledge marks a task as acknowledged.
func (a *TaskActions) Acknowledge(ctx context.Context, taskID string, expectedVersion *int64) (*models.Task, error) {
	status := "acknowledged"
	return a.Update(ctx, taskID, UpdateTaskParams{Status: &status, ExpectedVersion: expectedVersion})
}

// Complete marks a task as completed with optional result.
func (a *TaskActions) Complete(ctx context.Context, taskID string, result map[string]interface{}, expectedVersion *int64) (*models.Task, error) {
	status := "completed"
	var extra map[string]interface{}
	if result != nil {
		extra = map[string]interface{}{"result": result}
	}
	return a.Update(ctx, taskID, UpdateTaskParams{Status: &status, Extra: extra, ExpectedVersion: expectedVersion})
}

// Fail marks a task as failed with optional error details.
func (a *TaskActions) Fail(ctx context.Context, taskID string, errorDetails map[string]interface{}, expectedVersion *int64) (*models.Task, error) {
	status := "failed"
	var extra map[string]interface{}
	if errorDetails != nil {
		extra = map[string]interface{}{"error": errorDetails}
	}
	return a.Update(ctx, taskID, UpdateTaskParams{Status: &status, Extra: extra, ExpectedVersion: expectedVersion})
}

var legacyTaskTransitionExtraKeys = []string{"progress", "status_message", "message"}

func removeTaskExtraKeys(jsonData map[string]interface{}, keys ...string) {
	removeBlobExtraKeys(jsonData, taskPromotedBlobFields, keys...)
}

func taskStatusTransitionUpdate(status string, progress *float64, message *string) UpdateTaskParams {
	var components map[string]interface{}
	if progress != nil || message != nil {
		components = make(map[string]interface{})
		if progress != nil {
			p := normalizeTaskProgressPercent(*progress)
			components["progress"] = map[string]interface{}{"percent": p}
		}
		if message != nil {
			components["status_message"] = *message
		}
	}

	return UpdateTaskParams{
		Status:          &status,
		Components:      components,
		RemoveExtraKeys: append([]string(nil), legacyTaskTransitionExtraKeys...),
	}
}

// normalizeTaskProgressPercent clamps progress to the canonical 0–100 percent scale.
// NaN and infinite values are coerced to 0.
// Values are not auto-scaled from 0–1; e.g. 1 means 1%, not 100%.
func normalizeTaskProgressPercent(p float64) float64 {
	if math.IsNaN(p) || math.IsInf(p, 0) {
		return 0
	}
	if p < 0 {
		return 0
	}
	if p > 100 {
		return 100
	}
	return p
}

// TransitionStatus updates the task status and optional progress.
func (a *TaskActions) TransitionStatus(ctx context.Context, taskID, status string, progress *float64, message *string, expectedVersion *int64) (*models.Task, error) {
	params := taskStatusTransitionUpdate(status, progress, message)
	params.ExpectedVersion = expectedVersion
	return a.Update(ctx, taskID, params)
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
