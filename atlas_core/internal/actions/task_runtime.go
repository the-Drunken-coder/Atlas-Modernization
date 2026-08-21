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

const (
	immediateTimeoutBatchSize = 100
	runtimeTaskBatchSize      = 100
)

var assetStoppedFailure = protocol.TaskFailure{
	Code:    protocol.TaskFailureCodeAssetStopped,
	Message: "The Asset runtime stopped before the Task became terminal.",
}

func taskRuntimeIDs(tasks []*models.Task) []string {
	runtimeIDs := make([]string, 0, len(tasks))
	for _, task := range tasks {
		runtimeIDs = append(runtimeIDs, task.RuntimeID)
	}
	return runtimeIDs
}

func runtimeDrainFailure(task *models.Task, fallback protocol.TaskFailure, stoppedRuntimeIDs map[string]struct{}) protocol.TaskFailure {
	if _, stopped := stoppedRuntimeIDs[task.RuntimeID]; stopped {
		return assetStoppedFailure
	}
	return fallback
}

// BeginRuntimeRegistration first installs the new process as not ready, then
// drains stale work in committed batches. An interrupted exact retry continues
// the same drain without restoring readiness or replacing the runtime.
func (a *TaskActions) BeginRuntimeRegistration(ctx context.Context, assetID, runtimeID string) error {
	assetID = strings.TrimSpace(assetID)
	runtimeID = strings.TrimSpace(runtimeID)
	if err := ValidateEntityID(assetID); err != nil {
		return err
	}
	if errors := protocol.ValidateRuntimeRegistrationRequest(protocol.RuntimeRegistrationRequest{RuntimeID: runtimeID}); len(errors) > 0 {
		return NewValidationErrorWithDetails("Invalid runtime registration", errors)
	}
	current, err := a.installRuntimeRegistration(ctx, assetID, runtimeID)
	if err != nil {
		return err
	}
	if !current {
		return nil
	}
	for {
		count, stillCurrent, err := a.failRuntimeTaskBatch(ctx, assetID, runtimeID, true, protocol.TaskFailure{
			Code:    protocol.TaskFailureCodeAssetRestarted,
			Message: "The Asset runtime restarted before the Task became terminal.",
		})
		if err != nil {
			return err
		}
		if !stillCurrent || count == 0 {
			return nil
		}
	}
}

func (a *TaskActions) installRuntimeRegistration(ctx context.Context, assetID, runtimeID string) (bool, error) {
	tx, err := beginChangeTx(ctx, a.pool, "install Asset runtime registration")
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	entity, err := scanEntity(tx.QueryRow(ctx, entitySelectSQL+` WHERE entity_id = $1 FOR UPDATE`, assetID))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return false, NewEntityNotFoundError(assetID)
		}
		return false, fmt.Errorf("lock Asset Entity: %w", err)
	}
	if entity.Type != "asset" {
		return false, NewValidationError("only asset Entities can register a runtime")
	}
	var previousRuntimeID string
	var stopped bool
	err = tx.QueryRow(ctx, `SELECT runtime_id, stopped FROM asset_runtimes WHERE asset_id = $1 FOR UPDATE`, assetID).Scan(&previousRuntimeID, &stopped)
	if err == nil && previousRuntimeID == runtimeID {
		if stopped {
			return false, NewValidationError("stopped runtime cannot register again")
		}
		if err := tx.Commit(ctx); err != nil {
			return false, fmt.Errorf("commit repeated Asset runtime registration: %w", err)
		}
		return true, nil
	}
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return false, fmt.Errorf("lock previous Asset runtime: %w", err)
	}
	inserted, err := tx.Exec(ctx, `INSERT INTO asset_runtime_generations (asset_id, runtime_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, assetID, runtimeID)
	if err != nil {
		return false, fmt.Errorf("record Asset runtime generation: %w", err)
	}
	if inserted.RowsAffected() != 1 {
		return false, NewValidationError("runtime ID was already used")
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO asset_runtimes (asset_id, runtime_id, ready, stopped, manifest, registered_at, ready_at)
		VALUES ($1, $2, FALSE, FALSE, '[]', clock_timestamp(), NULL)
		ON CONFLICT (asset_id) DO UPDATE SET runtime_id = EXCLUDED.runtime_id,
			ready = FALSE, stopped = FALSE, manifest = '[]', registered_at = clock_timestamp(), ready_at = NULL
	`, assetID, runtimeID); err != nil {
		return false, fmt.Errorf("record Asset runtime: %w", err)
	}
	if err := recordRuntimeManifestEntityChange(ctx, tx, entity); err != nil {
		return false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return false, fmt.Errorf("commit Asset runtime registration: %w", err)
	}
	return true, nil
}

// StopRuntime deactivates only the named current runtime. Missing and stale
// runtime IDs are successful no-ops so a delayed shutdown cannot fence a newer
// process.
func (a *TaskActions) StopRuntime(ctx context.Context, assetID, runtimeID string) error {
	assetID = strings.TrimSpace(assetID)
	runtimeID = strings.TrimSpace(runtimeID)
	if err := ValidateEntityID(assetID); err != nil {
		return err
	}
	if errors := protocol.ValidateRuntimeStopRequest(protocol.RuntimeStopRequest{RuntimeID: runtimeID}); len(errors) > 0 {
		return NewValidationErrorWithDetails("Invalid runtime stop", errors)
	}
	tx, err := beginChangeTx(ctx, a.pool, "stop Asset runtime")
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	entity, err := scanEntity(tx.QueryRow(ctx, entitySelectSQL+` WHERE entity_id = $1 FOR UPDATE`, assetID))
	if errors.Is(err, pgx.ErrNoRows) {
		return tx.Commit(ctx)
	} else if err != nil {
		return fmt.Errorf("lock stopping Asset Entity: %w", err)
	}

	var currentRuntimeID string
	var ready, stopped bool
	var manifestJSON []byte
	if err := tx.QueryRow(ctx, `SELECT runtime_id, ready, stopped, manifest FROM asset_runtimes WHERE asset_id = $1 FOR UPDATE`, assetID).Scan(
		&currentRuntimeID, &ready, &stopped, &manifestJSON,
	); errors.Is(err, pgx.ErrNoRows) {
		return tx.Commit(ctx)
	} else if err != nil {
		return fmt.Errorf("lock stopping Asset runtime: %w", err)
	}
	if currentRuntimeID != runtimeID {
		return tx.Commit(ctx)
	}

	stateChanged := !stopped || ready || !jsonEqual(manifestJSON, []byte("[]"))
	if _, err := tx.Exec(ctx, `
		UPDATE asset_runtimes SET ready = FALSE, stopped = TRUE, manifest = '[]', ready_at = NULL
		WHERE asset_id = $1 AND runtime_id = $2
	`, assetID, runtimeID); err != nil {
		return fmt.Errorf("deactivate Asset runtime: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		UPDATE asset_runtime_generations SET stopped = TRUE
		WHERE asset_id = $1 AND runtime_id = $2
	`, assetID, runtimeID); err != nil {
		return fmt.Errorf("retire Asset runtime generation: %w", err)
	}
	if stateChanged {
		if err := recordRuntimeManifestEntityChange(ctx, tx, entity); err != nil {
			return err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit Asset runtime stop: %w", err)
	}
	for {
		count, stillCurrent, err := a.failRuntimeTaskBatch(ctx, assetID, runtimeID, true, protocol.TaskFailure{
			Code: protocol.TaskFailureCodeAssetRestarted, Message: "The Asset runtime restarted before the Task became terminal.",
		})
		if err != nil {
			return err
		}
		if !stillCurrent || count == 0 {
			break
		}
	}
	for {
		count, _, err := a.failRuntimeTaskBatch(ctx, assetID, runtimeID, false, assetStoppedFailure)
		if err != nil {
			return err
		}
		if count == 0 {
			break
		}
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
	entity, err := scanEntity(tx.QueryRow(ctx, entitySelectSQL+` WHERE entity_id = $1 FOR UPDATE`, assetID))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return NewEntityNotFoundError(assetID)
		}
		return fmt.Errorf("lock Asset Entity: %w", err)
	}
	if entity.Type != "asset" {
		return NewValidationError("only asset Entities can complete runtime registration")
	}
	var currentRuntimeID string
	var ready, stopped bool
	var currentManifest []byte
	if err := tx.QueryRow(ctx, `SELECT runtime_id, ready, stopped, manifest FROM asset_runtimes WHERE asset_id = $1 FOR UPDATE`, assetID).Scan(&currentRuntimeID, &ready, &stopped, &currentManifest); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return NewValidationError("Asset runtime registration has not begun")
		}
		return fmt.Errorf("lock Asset runtime: %w", err)
	}
	if currentRuntimeID != runtimeID {
		return NewValidationError("stale runtime cannot become ready")
	}
	if stopped {
		return NewValidationError("stopped runtime cannot become ready")
	}
	var staleTasksRemain bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM tasks
			WHERE asset_id = $1 AND runtime_id <> $2
				AND status IN ('pending', 'acknowledged', 'in_progress')
		)
	`, assetID, runtimeID).Scan(&staleTasksRemain); err != nil {
		return fmt.Errorf("check stale runtime Tasks before readiness: %w", err)
	}
	if staleTasksRemain {
		return NewValidationError("Asset runtime cannot become ready until stale Tasks are drained")
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
	if err := recordRuntimeManifestEntityChange(ctx, tx, entity); err != nil {
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
	updated, err := scanEntity(tx.QueryRow(ctx, `
		UPDATE entities SET updated_at = clock_timestamp(), version = $2
		WHERE entity_id = $1
		RETURNING entity_id, type, subtype, alias, json, created_at, updated_at, version
	`, before.EntityID, version))
	if err != nil {
		return fmt.Errorf("advance Asset detail after runtime change: %w", err)
	}
	if err := RecordResourceChange(ctx, tx, ResourceChange{
		Event:        ChangeEventUpdate,
		ResourceType: ChangeResourceEntity,
		ID:           updated.EntityID,
		Version:      updated.Version,
		AfterEntity:  cloneEntityModel(updated),
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
	deliverable, err := collectRows(rows, taskResourceQuery)
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

func (a *TaskActions) failRuntimeTaskBatch(ctx context.Context, assetID, runtimeID string, stale bool, failure protocol.TaskFailure) (int, bool, error) {
	tx, err := beginChangeTx(ctx, a.pool, "drain runtime Tasks")
	if err != nil {
		return 0, false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var lockedAssetID string
	if err := tx.QueryRow(ctx, `SELECT entity_id FROM entities WHERE entity_id = $1 FOR UPDATE`, assetID).Scan(&lockedAssetID); errors.Is(err, pgx.ErrNoRows) {
		if err := tx.Commit(ctx); err != nil {
			return 0, false, fmt.Errorf("commit missing Asset runtime drain: %w", err)
		}
		return 0, false, nil
	} else if err != nil {
		return 0, false, fmt.Errorf("lock Asset for runtime Task drain: %w", err)
	}
	var currentRuntimeID string
	if err := tx.QueryRow(ctx, `SELECT runtime_id FROM asset_runtimes WHERE asset_id = $1 FOR UPDATE`, assetID).Scan(&currentRuntimeID); errors.Is(err, pgx.ErrNoRows) {
		if err := tx.Commit(ctx); err != nil {
			return 0, false, fmt.Errorf("commit missing runtime Task drain: %w", err)
		}
		return 0, false, nil
	} else if err != nil {
		return 0, false, fmt.Errorf("lock Asset runtime for Task drain: %w", err)
	}
	stillCurrent := currentRuntimeID == runtimeID
	if stale && !stillCurrent {
		if err := tx.Commit(ctx); err != nil {
			return 0, false, fmt.Errorf("commit superseded runtime Task drain: %w", err)
		}
		return 0, false, nil
	}

	runtimePredicate := "runtime_id = $2"
	if stale {
		runtimePredicate = "runtime_id <> $2"
	}
	rows, err := tx.Query(ctx, taskSelectSQL+` WHERE asset_id = $1 AND `+runtimePredicate+` AND status IN ('pending', 'acknowledged', 'in_progress') ORDER BY created_at, task_id LIMIT $3 FOR UPDATE`, assetID, runtimeID, runtimeTaskBatchSize)
	if err != nil {
		return 0, true, fmt.Errorf("lock nonterminal runtime Task batch: %w", err)
	}
	tasks, err := collectRows(rows, taskResourceQuery)
	if err != nil {
		return 0, true, err
	}
	stoppedRuntimeIDs := make(map[string]struct{})
	if stale && len(tasks) > 0 {
		rows, err := tx.Query(ctx, `
			SELECT runtime_id FROM asset_runtime_generations
			WHERE asset_id = $1 AND runtime_id = ANY($2) AND stopped
		`, assetID, taskRuntimeIDs(tasks))
		if err != nil {
			return 0, true, fmt.Errorf("read stopped Asset runtime generations: %w", err)
		}
		defer rows.Close()
		for rows.Next() {
			var stoppedRuntimeID string
			if err := rows.Scan(&stoppedRuntimeID); err != nil {
				return 0, true, fmt.Errorf("scan stopped Asset runtime generation: %w", err)
			}
			stoppedRuntimeIDs[stoppedRuntimeID] = struct{}{}
		}
		if err := rows.Err(); err != nil {
			return 0, true, fmt.Errorf("iterate stopped Asset runtime generations: %w", err)
		}
	}
	var now time.Time
	if err := tx.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&now); err != nil {
		return 0, true, fmt.Errorf("read database time for runtime Task failure: %w", err)
	}
	now = now.UTC()
	for _, task := range tasks {
		if _, err := failTask(task, protocol.CommandDefinition{}, protocol.CommandManifestEntry{}, now, runtimeDrainFailure(task, failure, stoppedRuntimeIDs)); err != nil {
			return 0, true, err
		}
		_, err := persistTaskState(ctx, tx, task)
		if err != nil {
			return 0, true, fmt.Errorf("fail fenced runtime Task: %w", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, true, fmt.Errorf("commit runtime Task drain: %w", err)
	}
	return len(tasks), stillCurrent, nil
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
	tasks, err := collectRows(rows, taskResourceQuery)
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
