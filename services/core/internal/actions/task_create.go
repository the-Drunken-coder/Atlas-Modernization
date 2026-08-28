package actions

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"reflect"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	protocol "github.com/the-drunken-coder/atlas/packages/protocol/generated/go/atlasprotocol"
	protocolvalidator "github.com/the-drunken-coder/atlas/packages/protocol/validator"
	"github.com/the-drunken-coder/atlas/services/core/internal/models"
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

	var entityType string
	if err := tx.QueryRow(ctx, `SELECT type FROM entities WHERE entity_id = $1 FOR UPDATE`, params.AssetID).Scan(&entityType); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, false, NewEntityNotFoundError(params.AssetID)
		}
		return nil, false, fmt.Errorf("lock Task target Entity: %w", err)
	}
	if entityType != "asset" {
		return nil, false, NewValidationError("Tasks can target only asset Entities")
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
	leftValue, leftErr := decodeExactJSON(left)
	rightValue, rightErr := decodeExactJSON(right)
	if leftErr != nil || rightErr != nil {
		return bytes.Equal(left, right)
	}
	return reflect.DeepEqual(leftValue, rightValue)
}

type exactJSONNumber string

func decodeExactJSON(encoded []byte) (any, error) {
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return nil, errors.New("JSON contains trailing data")
	}
	return normalizeJSONNumbers(value), nil
}

func normalizeJSONNumbers(value any) any {
	switch value := value.(type) {
	case json.Number:
		if number, ok := new(big.Rat).SetString(value.String()); ok {
			return exactJSONNumber(number.RatString())
		}
		return exactJSONNumber(value.String())
	case []any:
		for index := range value {
			value[index] = normalizeJSONNumbers(value[index])
		}
	case map[string]any:
		for key := range value {
			value[key] = normalizeJSONNumbers(value[key])
		}
	}
	return value
}
