package actions

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/models"
	protocol "github.com/the-drunken-coder/atlas/atlas_protocol/generated/go/atlasprotocol"
	protocolvalidator "github.com/the-drunken-coder/atlas/atlas_protocol/validator"
)

const immediateStartWindow = time.Minute
const immediateStartTimeoutMessage = "The immediate Task did not start within 60 seconds."

func (a *TaskActions) Acknowledge(ctx context.Context, taskID, runtimeID string) (*models.Task, error) {
	if err := requireRuntimeID(runtimeID); err != nil {
		return nil, err
	}
	return a.withTaskTransition(ctx, taskID, runtimeID, false, a.requireAcknowledgeOrder, acknowledgeTask)
}

func acknowledgeTask(task *models.Task, command protocol.CommandDefinition, _ protocol.CommandManifestEntry, now time.Time) (bool, error) {
	if effectiveScheduling(command.Scheduling) == protocol.CommandSchedulingImmediate {
		return false, NewValidationError("Immediate Tasks are started without acknowledgement")
	}
	if task.Status == string(protocol.TaskStatusAcknowledged) {
		return false, nil
	}
	if task.Status != string(protocol.TaskStatusPending) {
		return false, invalidTaskTransition(task, "acknowledge")
	}
	task.Status = string(protocol.TaskStatusAcknowledged)
	task.AcknowledgedAt = &now
	return true, nil
}

func (a *TaskActions) Start(ctx context.Context, taskID, runtimeID string) (*models.Task, error) {
	if err := requireRuntimeID(runtimeID); err != nil {
		return nil, err
	}
	return a.withTaskTransition(ctx, taskID, runtimeID, false, a.requireStartOrder, startTask)
}

func startTask(task *models.Task, command protocol.CommandDefinition, _ protocol.CommandManifestEntry, now time.Time) (bool, error) {
	if task.Status == string(protocol.TaskStatusInProgress) {
		return false, nil
	}
	if effectiveScheduling(command.Scheduling) == protocol.CommandSchedulingImmediate {
		if task.Status != string(protocol.TaskStatusPending) {
			return false, invalidTaskTransition(task, "start")
		}
		if !now.Before(task.CreatedAt.Add(immediateStartWindow)) {
			return failTask(task, command, protocol.CommandManifestEntry{}, now, immediateStartTimeoutFailure())
		}
		task.AcknowledgedAt = &now
	} else if task.Status != string(protocol.TaskStatusAcknowledged) {
		return false, invalidTaskTransition(task, "start")
	}
	task.Status = string(protocol.TaskStatusInProgress)
	task.StartedAt = &now
	return true, nil
}

func (a *TaskActions) Progress(ctx context.Context, taskID, runtimeID string, progress float64) (*models.Task, error) {
	if err := requireRuntimeID(runtimeID); err != nil {
		return nil, err
	}
	return a.withTaskTransition(ctx, taskID, runtimeID, false, nil, func(task *models.Task, command protocol.CommandDefinition, manifest protocol.CommandManifestEntry, now time.Time) (bool, error) {
		return progressTask(task, command, manifest, now, progress)
	})
}

func progressTask(task *models.Task, _ protocol.CommandDefinition, manifest protocol.CommandManifestEntry, _ time.Time, progress float64) (bool, error) {
	if task.Status != string(protocol.TaskStatusInProgress) {
		return false, invalidTaskTransition(task, "report progress")
	}
	if !manifest.SupportsProgress {
		return false, NewValidationError("Command Manifest does not advertise progress")
	}
	if progress < 0 || progress > 1 {
		return false, NewValidationError("progress must be between 0 and 1")
	}
	if task.Progress != nil {
		if progress < *task.Progress {
			return false, NewValidationError("progress cannot decrease")
		}
		if progress == *task.Progress {
			return false, nil
		}
	}
	task.Progress = &progress
	return true, nil
}

// TaskOutput distinguishes an omitted output property from an explicit JSON null.
type TaskOutput struct {
	Value protocol.JSONValue
}

func (a *TaskActions) Complete(ctx context.Context, taskID, runtimeID string, output *TaskOutput) (*models.Task, error) {
	if err := requireRuntimeID(runtimeID); err != nil {
		return nil, err
	}
	return a.withTaskTransition(ctx, taskID, runtimeID, false, nil, func(task *models.Task, command protocol.CommandDefinition, manifest protocol.CommandManifestEntry, now time.Time) (bool, error) {
		return completeTask(task, command, manifest, now, output)
	})
}

func completeTask(task *models.Task, command protocol.CommandDefinition, _ protocol.CommandManifestEntry, now time.Time, output *TaskOutput) (bool, error) {
	encoded, err := encodeTaskOutput(command, output)
	if task.Status == string(protocol.TaskStatusCompleted) {
		if err != nil {
			return false, err
		}
		if jsonEqual(task.Output, encoded) {
			return false, nil
		}
		return false, NewValidationError("Task was already completed with different output")
	}
	if task.Status != string(protocol.TaskStatusInProgress) {
		return false, invalidTaskTransition(task, "complete")
	}
	if err != nil {
		return failTask(task, command, protocol.CommandManifestEntry{}, now, protocol.TaskFailure{
			Code:    protocol.TaskFailureCodeInvalidOutput,
			Message: err.Error(),
		})
	}
	task.Status = string(protocol.TaskStatusCompleted)
	task.Output = encoded
	task.FinishedAt = &now
	return true, nil
}

func (a *TaskActions) Fail(ctx context.Context, taskID, runtimeID string, failure protocol.TaskFailure) (*models.Task, error) {
	if err := requireRuntimeID(runtimeID); err != nil {
		return nil, err
	}
	if err := validateAssetFailureCode(failure.Code); err != nil {
		return nil, err
	}
	return a.withTaskTransition(ctx, taskID, runtimeID, false, nil, func(task *models.Task, command protocol.CommandDefinition, manifest protocol.CommandManifestEntry, now time.Time) (bool, error) {
		return failTask(task, command, manifest, now, failure)
	})
}

func failTask(task *models.Task, _ protocol.CommandDefinition, _ protocol.CommandManifestEntry, now time.Time, failure protocol.TaskFailure) (bool, error) {
	encoded, _ := json.Marshal(failure)
	if task.Status == string(protocol.TaskStatusFailed) {
		if jsonEqual(task.Failure, encoded) {
			return false, nil
		}
		return false, NewValidationError("Task was already failed with a different reason")
	}
	if taskTerminal(task.Status) {
		return false, invalidTaskTransition(task, "fail")
	}
	task.Status = string(protocol.TaskStatusFailed)
	task.Failure = encoded
	task.FinishedAt = &now
	return true, nil
}

func (a *TaskActions) Cancel(ctx context.Context, taskID string, cancellation protocol.TaskCancellation) (*models.Task, error) {
	if cancellation.Code != protocol.TaskCancellationCodeRequested {
		return nil, NewValidationError(fmt.Sprintf("cancellation code %q can only be applied by Core", cancellation.Code))
	}
	return a.withTaskTransition(ctx, taskID, "", true, nil, func(task *models.Task, command protocol.CommandDefinition, manifest protocol.CommandManifestEntry, now time.Time) (bool, error) {
		return cancelTask(task, command, manifest, now, cancellation)
	})
}

func validateAssetFailureCode(code protocol.TaskFailureCode) error {
	switch code {
	case protocol.TaskFailureCodeUnsupportedCommand,
		protocol.TaskFailureCodePreconditionFailed,
		protocol.TaskFailureCodeExecutionFailed:
		return nil
	default:
		return NewValidationError(fmt.Sprintf("failure code %q can only be applied by Core", code))
	}
}

func immediateStartTimeoutFailure() protocol.TaskFailure {
	return protocol.TaskFailure{
		Code:    protocol.TaskFailureCodeImmediateStartTimeout,
		Message: immediateStartTimeoutMessage,
	}
}

func cancelTask(task *models.Task, _ protocol.CommandDefinition, manifest protocol.CommandManifestEntry, now time.Time, cancellation protocol.TaskCancellation) (bool, error) {
	encoded, _ := json.Marshal(cancellation)
	if task.Status == string(protocol.TaskStatusCancelled) {
		if jsonEqual(task.Cancellation, encoded) {
			return false, nil
		}
		return false, NewValidationError("Task was already cancelled with a different reason")
	}
	if taskTerminal(task.Status) {
		return false, invalidTaskTransition(task, "cancel")
	}
	if task.Status == string(protocol.TaskStatusInProgress) && !manifest.SupportsCancel {
		return false, NewValidationError("Command Manifest does not advertise in-progress cancellation")
	}
	task.Status = string(protocol.TaskStatusCancelled)
	task.Cancellation = encoded
	task.FinishedAt = &now
	return true, nil
}

type taskMutation func(*models.Task, protocol.CommandDefinition, protocol.CommandManifestEntry, time.Time) (bool, error)
type taskPrecondition func(context.Context, pgx.Tx, *models.Task, protocol.CommandDefinition) error

func (a *TaskActions) withTaskTransition(ctx context.Context, taskID, runtimeID string, allowTerminalRetryWithoutRuntime bool, precondition taskPrecondition, mutate taskMutation) (*models.Task, error) {
	if err := ValidateTaskID(taskID); err != nil {
		return nil, err
	}
	taskID = SanitizeID(taskID)
	tx, err := beginChangeTx(ctx, a.pool, "Task lifecycle transition")
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// Assignment and runtime binding are immutable, so read them first and lock the
	// runtime before the Task. Runtime replacement uses the same lock order and can
	// therefore fence lifecycle calls without a task/runtime deadlock.
	var assetID, boundRuntimeID string
	if allowTerminalRetryWithoutRuntime {
		// beginChangeTx holds the global change-clock lock, so a terminal Task
		// cannot change while cancellation idempotency is checked.
		task, err := scanTask(tx.QueryRow(ctx, taskSelectSQL+` WHERE task_id = $1`, taskID))
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, NewTaskNotFoundError(taskID)
		}
		if err != nil {
			return nil, fmt.Errorf("read Task for terminal retry: %w", err)
		}
		assetID, boundRuntimeID = task.AssetID, task.RuntimeID
		if taskTerminal(task.Status) {
			changed, err := mutate(task, protocol.CommandDefinition{}, protocol.CommandManifestEntry{}, time.Time{})
			if err != nil {
				return nil, err
			}
			if changed {
				return nil, errors.New("terminal retry unexpectedly changed Task state")
			}
			if err := tx.Commit(ctx); err != nil {
				return nil, fmt.Errorf("commit idempotent terminal Task retry: %w", err)
			}
			return task, nil
		}
	} else if err := tx.QueryRow(ctx, `SELECT asset_id, runtime_id FROM tasks WHERE task_id = $1`, taskID).Scan(&assetID, &boundRuntimeID); errors.Is(err, pgx.ErrNoRows) {
		return nil, NewTaskNotFoundError(taskID)
	} else if err != nil {
		return nil, fmt.Errorf("read Task runtime binding: %w", err)
	}
	manifest, err := a.lockCurrentRuntimeManifest(ctx, tx, assetID, boundRuntimeID, runtimeID)
	if err != nil {
		return nil, err
	}
	task, err := scanTask(tx.QueryRow(ctx, taskSelectSQL+` WHERE task_id = $1 FOR UPDATE`, taskID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, NewTaskNotFoundError(taskID)
	}
	if err != nil {
		return nil, fmt.Errorf("lock Task: %w", err)
	}
	command, err := a.storedCommandDefinition(task.TaskID, task.Command)
	if err != nil {
		return nil, err
	}
	entry, ok := manifestEntry(manifest, task.Command)
	if !ok {
		return nil, NewValidationError("current runtime no longer advertises the Task Command")
	}
	if precondition != nil {
		if err := precondition(ctx, tx, task, command); err != nil {
			return nil, err
		}
	}
	var now time.Time
	if err := tx.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&now); err != nil {
		return nil, fmt.Errorf("read database time for Task transition: %w", err)
	}
	changed, err := mutate(task, command, entry, now.UTC())
	if err != nil {
		return nil, err
	}
	if !changed {
		if err := tx.Commit(ctx); err != nil {
			return nil, fmt.Errorf("commit idempotent Task transition: %w", err)
		}
		return task, nil
	}
	updated, err := persistTaskState(ctx, tx, task)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit Task transition: %w", err)
	}
	return updated, nil
}

func (a *TaskActions) requireAcknowledgeOrder(ctx context.Context, tx pgx.Tx, task *models.Task, command protocol.CommandDefinition) error {
	if task.Status != string(protocol.TaskStatusPending) || effectiveScheduling(command.Scheduling) != protocol.CommandSchedulingQueued {
		return nil
	}
	return a.requireNoSchedulingBlocker(ctx, tx, task, protocol.CommandSchedulingQueued, []string{string(protocol.TaskStatusPending)}, false, false, "an earlier queued Task is still pending")
}

func (a *TaskActions) requireStartOrder(ctx context.Context, tx pgx.Tx, task *models.Task, command protocol.CommandDefinition) error {
	scheduling := effectiveScheduling(command.Scheduling)
	if scheduling == protocol.CommandSchedulingImmediate {
		if task.Status != string(protocol.TaskStatusPending) {
			return nil
		}
		return a.requireNoSchedulingBlocker(ctx, tx, task, scheduling, []string{string(protocol.TaskStatusPending)}, false, true, "an earlier immediate Task has not started")
	}
	if task.Status != string(protocol.TaskStatusAcknowledged) {
		return nil
	}
	return a.requireNoSchedulingBlocker(ctx, tx, task, scheduling, []string{string(protocol.TaskStatusPending), string(protocol.TaskStatusAcknowledged)}, true, false, "an earlier queued Task has not become terminal")
}

func (a *TaskActions) requireNoSchedulingBlocker(
	ctx context.Context,
	tx pgx.Tx,
	task *models.Task,
	scheduling protocol.CommandScheduling,
	earlierStatuses []string,
	includeAnyInProgress bool,
	excludeExpired bool,
	message string,
) error {
	rows, err := tx.Query(ctx, `
		SELECT task_id, command FROM tasks
		WHERE asset_id = $1 AND runtime_id = $2
			AND (
				($5 AND status = 'in_progress')
				OR ((created_at, task_id) < ($3, $4) AND status = ANY($6))
			)
			AND (NOT $7 OR created_at > clock_timestamp() - ($8 * interval '1 second'))
		ORDER BY created_at, task_id FOR UPDATE
	`, task.AssetID, task.RuntimeID, task.CreatedAt, task.TaskID, includeAnyInProgress, earlierStatuses, excludeExpired, immediateStartWindow.Seconds())
	if err != nil {
		return fmt.Errorf("lock Tasks that can block lifecycle order: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var taskID, commandName string
		if err := rows.Scan(&taskID, &commandName); err != nil {
			return fmt.Errorf("scan Task that can block lifecycle order: %w", err)
		}
		blockingCommand, err := a.storedCommandDefinition(taskID, commandName)
		if err != nil {
			return err
		}
		if effectiveScheduling(blockingCommand.Scheduling) == scheduling {
			return NewValidationError(message)
		}
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("iterate Tasks that can block lifecycle order: %w", err)
	}
	return nil
}

func (a *TaskActions) lockCurrentRuntimeManifest(ctx context.Context, tx pgx.Tx, assetID, boundRuntimeID, callerRuntimeID string) (protocol.CommandManifest, error) {
	var currentRuntimeID string
	var ready bool
	var manifestJSON []byte
	if err := tx.QueryRow(ctx, `SELECT runtime_id, ready, manifest FROM asset_runtimes WHERE asset_id = $1 FOR UPDATE`, assetID).Scan(&currentRuntimeID, &ready, &manifestJSON); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, NewValidationError("Asset has no registered runtime")
		}
		return nil, fmt.Errorf("lock current Asset runtime: %w", err)
	}
	if !ready || currentRuntimeID != boundRuntimeID {
		return nil, NewValidationError("Task belongs to a stale Asset runtime")
	}
	if callerRuntimeID != "" && strings.TrimSpace(callerRuntimeID) != currentRuntimeID {
		return nil, NewValidationError("Atlas-Runtime-ID does not identify the current runtime")
	}
	var manifest protocol.CommandManifest
	if err := json.Unmarshal(manifestJSON, &manifest); err != nil {
		return nil, fmt.Errorf("decode current Command Manifest: %w", err)
	}
	return manifest, nil
}

func encodeTaskOutput(command protocol.CommandDefinition, output *TaskOutput) ([]byte, error) {
	if command.OutputSchema == "" {
		if output != nil {
			return nil, NewValidationError("Command does not define Task output")
		}
		return nil, nil
	}
	if output == nil {
		return nil, NewValidationError("Command requires Task output")
	}
	if validationErrors := protocolvalidator.ValidateDefinition(commandDefinitionName(command.OutputSchema), output.Value); len(validationErrors) > 0 {
		return nil, NewValidationErrorWithDetails("Invalid Command output", validationErrors)
	}
	encoded, err := json.Marshal(output.Value)
	if err != nil {
		return nil, NewValidationError("output must be JSON encodable")
	}
	return encoded, nil
}

func nullableJSON(value []byte) any {
	if len(value) == 0 {
		return nil
	}
	return value
}

func taskTerminal(status string) bool {
	return status == string(protocol.TaskStatusCompleted) || status == string(protocol.TaskStatusFailed) || status == string(protocol.TaskStatusCancelled)
}

func invalidTaskTransition(task *models.Task, operation string) error {
	return NewValidationError(fmt.Sprintf("cannot %s Task in %s state", operation, task.Status))
}

func requireRuntimeID(runtimeID string) error {
	if strings.TrimSpace(runtimeID) == "" {
		return NewValidationError("Atlas-Runtime-ID is required")
	}
	return nil
}
