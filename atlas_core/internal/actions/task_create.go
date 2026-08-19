package actions

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/models"
	protocol "github.com/the-drunken-coder/atlas/atlas_protocol/generated/go/atlasprotocol"
	protocolvalidator "github.com/the-drunken-coder/atlas/atlas_protocol/validator"
)

// CreateTaskParams is the complete immutable Task creation input.
type CreateTaskParams struct {
	AssetID string
	Command string
	Input   protocol.JSONValue
}

// Create validates and persists one tasking attempt. The opaque key is stored
// only for retry identity and is never included in TaskResource.
func (a *TaskActions) Create(ctx context.Context, params CreateTaskParams, idempotencyKey string) (*models.Task, bool, error) {
	params.AssetID = strings.TrimSpace(params.AssetID)
	params.Command = strings.TrimSpace(params.Command)
	idempotencyKey = strings.TrimSpace(idempotencyKey)
	if idempotencyKey == "" {
		return nil, false, NewValidationError("Idempotency-Key is required")
	}
	if err := ValidateEntityID(params.AssetID); err != nil {
		return nil, false, err
	}
	if errors := protocol.ValidateTaskCreateRequest(protocol.TaskCreateRequest{AssetID: params.AssetID, Command: params.Command, Input: params.Input}); len(errors) > 0 {
		return nil, false, NewValidationErrorWithDetails("Invalid Task creation", errors)
	}
	input, err := json.Marshal(params.Input)
	if err != nil {
		return nil, false, NewValidationError("input must be JSON encodable")
	}

	tx, err := beginChangeTx(ctx, a.pool, "task create")
	if err != nil {
		return nil, false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	existing, err := scanTask(tx.QueryRow(ctx, taskSelectSQL+` WHERE idempotency_key = $1 FOR UPDATE`, idempotencyKey))
	if err == nil {
		if existing.AssetID != params.AssetID || existing.Command != params.Command || !jsonEqual(existing.Input, input) {
			return nil, false, &ConflictError{ActionError: ActionError{Message: "Idempotency-Key was already used for different tasking data", Code: protocol.ErrorCodeTaskAlreadyExists}}
		}
		if err := tx.Commit(ctx); err != nil {
			return nil, false, fmt.Errorf("commit idempotent Task create: %w", err)
		}
		return existing, false, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return nil, false, fmt.Errorf("look up Task idempotency key: %w", err)
	}

	command, ok := a.catalog[params.Command]
	if !ok {
		return nil, false, NewValidationError("unsupported Command")
	}
	var runtimeID string
	var ready bool
	var manifestJSON []byte
	if err := tx.QueryRow(ctx, `SELECT runtime_id, ready, manifest FROM asset_runtimes WHERE asset_id = $1 FOR UPDATE`, params.AssetID).Scan(&runtimeID, &ready, &manifestJSON); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, false, NewValidationError("Asset has no registered runtime")
		}
		return nil, false, fmt.Errorf("lock Asset runtime: %w", err)
	}
	if !ready {
		return nil, false, NewValidationError("Asset runtime is not ready")
	}
	var manifest protocol.CommandManifest
	if err := json.Unmarshal(manifestJSON, &manifest); err != nil {
		return nil, false, fmt.Errorf("decode stored Command Manifest: %w", err)
	}
	entry, ok := manifestEntry(manifest, params.Command)
	if !ok {
		return nil, false, NewValidationError("Asset runtime does not advertise Command support")
	}
	if effectiveScheduling(entry.Scheduling) != effectiveScheduling(command.Scheduling) {
		return nil, false, NewValidationError("Asset runtime scheduling does not match the Command Catalog")
	}
	if validationErrors := protocolvalidator.ValidateDefinition(commandDefinitionName(command.InputSchema), params.Input); len(validationErrors) > 0 {
		return nil, false, NewValidationErrorWithDetails("Invalid Command input", validationErrors)
	}

	version, err := nextChangeVersion(ctx, tx)
	if err != nil {
		return nil, false, err
	}
	taskID := "task-" + uuid.NewString()
	task, err := scanTask(tx.QueryRow(ctx, `
		INSERT INTO tasks (task_id, asset_id, command, input, idempotency_key, runtime_id, version)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		RETURNING `+taskColumns,
		taskID, params.AssetID, params.Command, input, idempotencyKey, runtimeID, version))
	if err != nil {
		return nil, false, fmt.Errorf("create Task: %w", err)
	}
	if err := RecordResourceChange(ctx, tx, ResourceChange{Event: ChangeEventCreate, ResourceType: ChangeResourceTask, ID: task.TaskID, Version: task.Version, AfterTask: cloneTaskModel(task)}); err != nil {
		return nil, false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, false, fmt.Errorf("commit Task create: %w", err)
	}
	return task, true, nil
}

func jsonEqual(left, right []byte) bool {
	var leftValue, rightValue any
	if json.Unmarshal(left, &leftValue) != nil || json.Unmarshal(right, &rightValue) != nil {
		return bytes.Equal(left, right)
	}
	leftCanonical, _ := json.Marshal(leftValue)
	rightCanonical, _ := json.Marshal(rightValue)
	return bytes.Equal(leftCanonical, rightCanonical)
}
