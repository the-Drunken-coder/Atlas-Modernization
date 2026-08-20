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
)

const immediateTimeoutBatchSize = 100

// BeginRuntimeRegistration fences the previous process and fails all of its
// nonterminal work before recording the new, not-ready runtime.
func (a *TaskActions) BeginRuntimeRegistration(ctx context.Context, assetID, runtimeID string) error {
	assetID = strings.TrimSpace(assetID)
	runtimeID = strings.TrimSpace(runtimeID)
	if err := ValidateEntityID(assetID); err != nil {
		return err
	}
	if errors := protocol.ValidateRuntimeRegistrationRequest(protocol.RuntimeRegistrationRequest{RuntimeID: runtimeID}); len(errors) > 0 {
		return NewValidationErrorWithDetails("Invalid runtime registration", errors)
	}
	tx, err := beginChangeTx(ctx, a.pool, "begin Asset runtime registration")
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var entity models.Entity
	if err := tx.QueryRow(ctx, entitySelectSQL+` WHERE entity_id = $1 FOR UPDATE`, assetID).Scan(
		&entity.EntityID, &entity.Type, &entity.Subtype, &entity.Alias,
		&entity.JSON, &entity.CreatedAt, &entity.UpdatedAt, &entity.Version,
	); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return NewEntityNotFoundError(assetID)
		}
		return fmt.Errorf("lock Asset Entity: %w", err)
	}
	if entity.Type != "asset" {
		return NewValidationError("only asset Entities can register a runtime")
	}
	var previousRuntimeID string
	err = tx.QueryRow(ctx, `SELECT runtime_id FROM asset_runtimes WHERE asset_id = $1 FOR UPDATE`, assetID).Scan(&previousRuntimeID)
	if err == nil && previousRuntimeID == runtimeID {
		return tx.Commit(ctx)
	}
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("lock previous Asset runtime: %w", err)
	}
	if previousRuntimeID != "" {
		if err := a.failRuntimeTasks(ctx, tx, assetID, previousRuntimeID, protocol.TaskFailure{Code: protocol.TaskFailureCodeAssetRestarted, Message: "The Asset runtime restarted before the Task became terminal."}); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO asset_runtimes (asset_id, runtime_id, ready, manifest, registered_at, ready_at)
		VALUES ($1, $2, FALSE, '[]', clock_timestamp(), NULL)
		ON CONFLICT (asset_id) DO UPDATE SET runtime_id = EXCLUDED.runtime_id,
			ready = FALSE, manifest = '[]', registered_at = clock_timestamp(), ready_at = NULL
	`, assetID, runtimeID); err != nil {
		return fmt.Errorf("record Asset runtime: %w", err)
	}
	if err := recordRuntimeManifestEntityChange(ctx, tx, &entity); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit Asset runtime registration: %w", err)
	}
	return nil
}

// CompleteRuntimeRegistration records the fixed manifest only for the current
// runtime. Repeating the same ready request is an idempotent no-op.
func (a *TaskActions) CompleteRuntimeRegistration(ctx context.Context, assetID, runtimeID string, manifest protocol.CommandManifest) error {
	assetID = strings.TrimSpace(assetID)
	runtimeID = strings.TrimSpace(runtimeID)
	if err := ValidateEntityID(assetID); err != nil {
		return err
	}
	if errors := protocol.ValidateRuntimeReadyRequest(protocol.RuntimeReadyRequest{RuntimeID: runtimeID, Manifest: manifest}); len(errors) > 0 {
		return NewValidationErrorWithDetails("Invalid runtime ready request", errors)
	}
	manifestValidationErr := validateCommandManifestCatalog(a.catalog, manifest)
	encoded, _ := json.Marshal(manifest)
	tx, err := beginChangeTx(ctx, a.pool, "complete Asset runtime registration")
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var entity models.Entity
	if err := tx.QueryRow(ctx, entitySelectSQL+` WHERE entity_id = $1 FOR UPDATE`, assetID).Scan(
		&entity.EntityID, &entity.Type, &entity.Subtype, &entity.Alias,
		&entity.JSON, &entity.CreatedAt, &entity.UpdatedAt, &entity.Version,
	); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return NewEntityNotFoundError(assetID)
		}
		return fmt.Errorf("lock Asset Entity: %w", err)
	}
	if entity.Type != "asset" {
		return NewValidationError("only asset Entities can complete runtime registration")
	}
	var currentRuntimeID string
	var ready bool
	var currentManifest []byte
	if err := tx.QueryRow(ctx, `SELECT runtime_id, ready, manifest FROM asset_runtimes WHERE asset_id = $1 FOR UPDATE`, assetID).Scan(&currentRuntimeID, &ready, &currentManifest); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return NewValidationError("Asset runtime registration has not begun")
		}
		return fmt.Errorf("lock Asset runtime: %w", err)
	}
	if currentRuntimeID != runtimeID {
		return NewValidationError("stale runtime cannot become ready")
	}
	if ready {
		if !jsonEqual(currentManifest, encoded) {
			return NewValidationError("ready runtime cannot replace its Command Manifest")
		}
		return tx.Commit(ctx)
	}
	if manifestValidationErr != nil {
		return manifestValidationErr
	}
	if _, err := tx.Exec(ctx, `UPDATE asset_runtimes SET ready = TRUE, manifest = $3, ready_at = clock_timestamp() WHERE asset_id = $1 AND runtime_id = $2`, assetID, runtimeID, encoded); err != nil {
		return fmt.Errorf("mark Asset runtime ready: %w", err)
	}
	if err := recordRuntimeManifestEntityChange(ctx, tx, &entity); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func validateCommandManifestCatalog(catalog map[string]protocol.CommandDefinition, manifest protocol.CommandManifest) error {
	seen := make(map[string]struct{}, len(manifest))
	for _, entry := range manifest {
		if _, duplicate := seen[entry.Command]; duplicate {
			return NewValidationError("Command Manifest contains a duplicate Command")
		}
		seen[entry.Command] = struct{}{}
		command, ok := catalog[entry.Command]
		if !ok {
			return NewValidationError("Command Manifest contains a Command outside the production catalog")
		}
		if effectiveScheduling(entry.Scheduling) != effectiveScheduling(command.Scheduling) {
			return NewValidationError("Command Manifest scheduling does not match the Command Catalog")
		}
	}
	return nil
}

// Runtime readiness changes the read-only Asset detail, so advance the Entity
// feed version. Feed consumers can then refetch the detail without duplicating
// the manifest outside the authoritative runtime record.
func recordRuntimeManifestEntityChange(ctx context.Context, tx pgx.Tx, before *models.Entity) error {
	version, err := nextChangeVersion(ctx, tx)
	if err != nil {
		return err
	}
	var updated models.Entity
	if err := tx.QueryRow(ctx, `
		UPDATE entities SET updated_at = clock_timestamp(), version = $2
		WHERE entity_id = $1
		RETURNING entity_id, type, subtype, alias, json, created_at, updated_at, version
	`, before.EntityID, version).Scan(
		&updated.EntityID, &updated.Type, &updated.Subtype, &updated.Alias,
		&updated.JSON, &updated.CreatedAt, &updated.UpdatedAt, &updated.Version,
	); err != nil {
		return fmt.Errorf("advance Asset detail after runtime change: %w", err)
	}
	if err := RecordResourceChange(ctx, tx, ResourceChange{
		Event:        ChangeEventUpdate,
		ResourceType: ChangeResourceEntity,
		ID:           updated.EntityID,
		Version:      updated.Version,
		AfterEntity:  cloneEntityModel(&updated),
	}); err != nil {
		return err
	}
	return nil
}

// RuntimeManifest returns the ready runtime's read-only manifest for Asset details.
func (a *TaskActions) RuntimeManifest(ctx context.Context, assetID string) (protocol.CommandManifest, error) {
	var encoded []byte
	var ready bool
	if err := a.pool.QueryRow(ctx, `SELECT ready, manifest FROM asset_runtimes WHERE asset_id = $1`, assetID).Scan(&ready, &encoded); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, fmt.Errorf("read Asset runtime manifest: %w", err)
	}
	if !ready {
		return nil, nil
	}
	var manifest protocol.CommandManifest
	if err := json.Unmarshal(encoded, &manifest); err != nil {
		return nil, fmt.Errorf("decode Asset runtime manifest: %w", err)
	}
	return manifest, nil
}

// Deliverable returns the first pending immediate and queued Tasks currently
// eligible for this runtime. Reconcile again after the immediate Task starts or
// the queued Task is acknowledged to release the next Task of that kind.
func (a *TaskActions) Deliverable(ctx context.Context, assetID, runtimeID string) ([]*models.Task, error) {
	runtimeID = strings.TrimSpace(runtimeID)
	var currentRuntimeID string
	var ready bool
	if err := a.pool.QueryRow(ctx, `SELECT runtime_id, ready FROM asset_runtimes WHERE asset_id = $1`, assetID).Scan(&currentRuntimeID, &ready); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, NewValidationError("Asset has no registered runtime")
		}
		return nil, fmt.Errorf("read Asset runtime: %w", err)
	}
	if !ready || runtimeID != currentRuntimeID {
		return nil, NewValidationError("Atlas-Runtime-ID does not identify the current ready runtime")
	}
	immediateCommands := make([]string, 0, len(a.catalog))
	for name, command := range a.catalog {
		if effectiveScheduling(command.Scheduling) == protocol.CommandSchedulingImmediate {
			immediateCommands = append(immediateCommands, name)
		}
	}
	rows, err := a.pool.Query(ctx, `
		(`+taskSelectSQL+` WHERE asset_id = $1 AND runtime_id = $2 AND status = 'pending'
			AND command = ANY($3)
			AND created_at > clock_timestamp() - ($4 * interval '1 second')
			ORDER BY created_at, task_id LIMIT 1)
		UNION ALL
		(`+taskSelectSQL+` WHERE asset_id = $1 AND runtime_id = $2 AND status = 'pending'
			AND NOT (command = ANY($3)) ORDER BY created_at, task_id LIMIT 1)
		ORDER BY created_at, task_id
	`, assetID, runtimeID, immediateCommands, immediateStartWindow.Seconds())
	if err != nil {
		return nil, fmt.Errorf("query deliverable Tasks: %w", err)
	}
	deliverable, err := scanTaskRows(rows)
	if err != nil {
		return nil, err
	}
	for _, task := range deliverable {
		if _, err := a.storedCommandDefinition(task.TaskID, task.Command); err != nil {
			return nil, err
		}
	}
	return deliverable, nil
}

func (a *TaskActions) failRuntimeTasks(ctx context.Context, tx pgx.Tx, assetID, runtimeID string, failure protocol.TaskFailure) error {
	rows, err := tx.Query(ctx, taskSelectSQL+` WHERE asset_id = $1 AND runtime_id = $2 AND status IN ('pending', 'acknowledged', 'in_progress') ORDER BY created_at, task_id FOR UPDATE`, assetID, runtimeID)
	if err != nil {
		return fmt.Errorf("lock nonterminal runtime Tasks: %w", err)
	}
	tasks, err := scanTaskRows(rows)
	if err != nil {
		return err
	}
	var now time.Time
	if err := tx.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&now); err != nil {
		return fmt.Errorf("read database time for runtime Task failure: %w", err)
	}
	now = now.UTC()
	for _, task := range tasks {
		if _, err := failTask(task, protocol.CommandDefinition{}, protocol.CommandManifestEntry{}, now, failure); err != nil {
			return err
		}
		_, err := persistTaskState(ctx, tx, task)
		if err != nil {
			return fmt.Errorf("fail fenced runtime Task: %w", err)
		}
	}
	return nil
}

// ReconcileImmediateTimeouts permanently fails one bounded batch of immediate
// Tasks that did not start within the Protocol deadline. Repeated calls drain a
// backlog without holding one transaction for the entire backlog.
func (a *TaskActions) ReconcileImmediateTimeouts(ctx context.Context) (int, error) {
	var immediate []string
	for name, command := range a.catalog {
		if effectiveScheduling(command.Scheduling) == protocol.CommandSchedulingImmediate {
			immediate = append(immediate, name)
		}
	}
	if len(immediate) == 0 {
		return 0, nil
	}
	tx, err := beginChangeTx(ctx, a.pool, "reconcile immediate Task deadlines")
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var now time.Time
	if err := tx.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&now); err != nil {
		return 0, fmt.Errorf("read database time for immediate Task deadlines: %w", err)
	}
	now = now.UTC()
	rows, err := tx.Query(ctx, taskSelectSQL+` WHERE command = ANY($1) AND status = 'pending' AND created_at <= $2 ORDER BY created_at, task_id LIMIT $3 FOR UPDATE SKIP LOCKED`, immediate, now.Add(-immediateStartWindow), immediateTimeoutBatchSize)
	if err != nil {
		return 0, fmt.Errorf("lock expired immediate Tasks: %w", err)
	}
	tasks, err := scanTaskRows(rows)
	if err != nil {
		return 0, err
	}
	for _, task := range tasks {
		if _, err := failTask(task, protocol.CommandDefinition{}, protocol.CommandManifestEntry{}, now, immediateStartTimeoutFailure()); err != nil {
			return 0, err
		}
		_, err := persistTaskState(ctx, tx, task)
		if err != nil {
			return 0, fmt.Errorf("fail expired immediate Task: %w", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("commit immediate Task reconciliation: %w", err)
	}
	return len(tasks), nil
}
