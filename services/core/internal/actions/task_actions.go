package actions

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	protocol "github.com/the-drunken-coder/atlas/packages/protocol/generated/go/atlasprotocol"
	"github.com/the-drunken-coder/atlas/services/core/internal/models"
)

const taskColumns = `task_id, asset_id, command, input, status, progress, output, completion_attempt, failure, cancellation, idempotency_key, runtime_id, created_at, acknowledged_at, started_at, finished_at, updated_at, version`
const taskSelectSQL = `SELECT ` + taskColumns + ` FROM tasks`

// TaskActions owns Task validation, persistence, lifecycle, ordering, and
// runtime fencing. Transport and HTTP handlers are adapters around this seam.
type TaskActions struct {
	pool         *pgxpool.Pool
	catalog      map[string]protocol.CommandDefinition
	pluginAssets map[string]string
}

// NewTaskActions creates the production Task module from the generated catalog.
func NewTaskActions(pool *pgxpool.Pool) *TaskActions {
	return NewTaskActionsWithPlugins(pool, nil)
}

func NewTaskActionsWithPlugins(pool *pgxpool.Pool, pluginIDs []string) *TaskActions {
	var catalog protocol.CommandCatalog
	if err := json.Unmarshal([]byte(protocol.CommandCatalogJSON), &catalog); err != nil {
		panic(fmt.Sprintf("decode generated Command Catalog: %v", err))
	}
	return newTaskActions(pool, catalog, pluginIDs)
}

// NewTaskActionsWithCatalog creates a Task module with an explicit catalog.
// It exists so shared conformance fixtures can exercise behavior while the
// production catalog remains empty.
func NewTaskActionsWithCatalog(pool *pgxpool.Pool, catalog protocol.CommandCatalog) *TaskActions {
	return newTaskActions(pool, catalog, nil)
}

func NewTaskActionsWithCatalogAndPlugins(pool *pgxpool.Pool, catalog protocol.CommandCatalog, pluginIDs []string) *TaskActions {
	return newTaskActions(pool, catalog, pluginIDs)
}

func newTaskActions(pool *pgxpool.Pool, catalog protocol.CommandCatalog, pluginIDs []string) *TaskActions {
	byName := make(map[string]protocol.CommandDefinition, len(catalog))
	for _, command := range catalog {
		byName[command.Command] = command
	}
	return &TaskActions{pool: pool, catalog: byName, pluginAssets: configuredToolAssets(pluginIDs)}
}

func scanTask(row rowScanner) (*models.Task, error) {
	var task models.Task
	err := row.Scan(
		&task.TaskID, &task.AssetID, &task.Command, &task.Input, &task.Status,
		&task.Progress, &task.Output, &task.CompletionAttempt, &task.Failure, &task.Cancellation,
		&task.IdempotencyKey, &task.RuntimeID, &task.CreatedAt,
		&task.AcknowledgedAt, &task.StartedAt, &task.FinishedAt,
		&task.UpdatedAt, &task.Version,
	)
	return &task, err
}

// Get retrieves a Task by ID.
func (a *TaskActions) Get(ctx context.Context, taskID string) (*models.Task, error) {
	if err := ValidateTaskID(taskID); err != nil {
		return nil, err
	}
	taskID = SanitizeID(taskID)
	task, err := scanTask(a.pool.QueryRow(ctx, taskSelectSQL+` WHERE task_id = $1`, taskID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, NewTaskNotFoundError(taskID)
	}
	if err != nil {
		return nil, fmt.Errorf("get task: %w", err)
	}
	return task, nil
}

// List retrieves Tasks with the existing stable cursor contract.
func (a *TaskActions) List(ctx context.Context, limit int, cursor string) (*ListPage[*models.Task], error) {
	limit = ClampListLimit(limit)
	return readCursorListPage(ctx, a.pool, cursorListPageOptions[*models.Task]{
		limit: limit, cursor: cursor, cursorLabel: "cursor", operation: "task list", cursorName: "task",
		query: func(ctx context.Context, tx pgx.Tx, upper time.Time, continuation bool, parsed *parsedQueryCursor, limit int) ([]*models.Task, bool, error) {
			return taskResourceQuery.query(ctx, tx, "created_at", time.Time{}, upper, continuation, parsed, limit, 0)
		},
		rowCursor: func(task *models.Task) (time.Time, string) { return task.CreatedAt, task.TaskID },
	})
}

// GetByEntity retains the existing route name while Tasks now use asset_id.
func (a *TaskActions) GetByEntity(ctx context.Context, assetID string, limit int, cursor string) (*ListPage[*models.Task], error) {
	if err := ValidateEntityID(assetID); err != nil {
		return nil, err
	}
	assetID = SanitizeID(assetID)
	limit = ClampListLimit(limit)
	return readCursorListPage(ctx, a.pool, cursorListPageOptions[*models.Task]{
		limit: limit, cursor: cursor, cursorLabel: "cursor", operation: "asset task list", cursorName: "asset task",
		query: func(ctx context.Context, tx pgx.Tx, upper time.Time, continuation bool, parsed *parsedQueryCursor, limit int) ([]*models.Task, bool, error) {
			return taskResourceQuery.queryFiltered(
				ctx, tx, "created_at", time.Time{}, upper, continuation, parsed, limit, 0,
				&cursorPageEqFilter{column: "asset_id", value: assetID}, "tasks by entity",
			)
		},
		rowCursor: func(task *models.Task) (time.Time, string) { return task.CreatedAt, task.TaskID },
	})
}

func commandDefinitionName(reference string) string {
	if index := strings.LastIndex(reference, "."); index >= 0 {
		return reference[index+1:]
	}
	return reference
}

func manifestEntry(manifest protocol.CommandManifest, command string) (protocol.CommandManifestEntry, bool) {
	for _, entry := range manifest {
		if entry.Command == command {
			return entry, true
		}
	}
	return protocol.CommandManifestEntry{}, false
}

func resolveScheduling(command protocol.CommandDefinition, entry protocol.CommandManifestEntry) (protocol.CommandScheduling, error) {
	if command.Scheduling != "" {
		if entry.Scheduling != command.Scheduling {
			return "", NewValidationError("Command Manifest scheduling does not match the Command Catalog")
		}
		return command.Scheduling, nil
	}
	if entry.Scheduling != protocol.CommandSchedulingQueued && entry.Scheduling != protocol.CommandSchedulingImmediate {
		return "", NewValidationError("Command Manifest must choose queued or immediate scheduling")
	}
	return entry.Scheduling, nil
}

func (a *TaskActions) storedCommandDefinition(taskID, commandName string) (protocol.CommandDefinition, error) {
	command, ok := a.catalog[commandName]
	if !ok {
		return protocol.CommandDefinition{}, fmt.Errorf("stored Task %s references unknown Command %s", taskID, commandName)
	}
	return command, nil
}

// persistTaskState is the single persistence boundary for lifecycle changes.
// Callers retain ownership of policy, row locking, and transaction commit.
func persistTaskState(ctx context.Context, tx pgx.Tx, task *models.Task) (*models.Task, error) {
	version, err := nextChangeVersion(ctx, tx)
	if err != nil {
		return nil, err
	}
	task.Version = version
	updated, err := scanTask(tx.QueryRow(ctx, `
		UPDATE tasks SET status = $2, progress = $3, output = $4, completion_attempt = $5, failure = $6,
			cancellation = $7, acknowledged_at = $8, started_at = $9,
			finished_at = $10, updated_at = clock_timestamp(), version = $11
		WHERE task_id = $1 RETURNING `+taskColumns,
		task.TaskID, task.Status, task.Progress, nullableJSON(task.Output), nullableJSON(task.CompletionAttempt), nullableJSON(task.Failure),
		nullableJSON(task.Cancellation), task.AcknowledgedAt, task.StartedAt, task.FinishedAt, version))
	if err != nil {
		return nil, fmt.Errorf("persist Task transition: %w", err)
	}
	if err := RecordResourceChange(ctx, tx, ResourceChange{
		Event:        ChangeEventUpdate,
		ResourceType: ChangeResourceTask,
		ID:           updated.TaskID,
		Version:      updated.Version,
		AfterTask:    cloneTaskModel(updated),
	}); err != nil {
		return nil, err
	}
	return updated, nil
}
