package actions

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"testing"
	"time"

	protocol "github.com/the-drunken-coder/atlas/atlas_protocol/generated/go/atlasprotocol"
)

func fixtureTaskCatalog(t *testing.T) protocol.CommandCatalog {
	t.Helper()
	return loadTaskingFixture[protocol.CommandCatalog](t, "catalog.json")
}

func fixtureTaskManifest(t *testing.T) protocol.CommandManifest {
	t.Helper()
	return loadTaskingFixture[protocol.CommandManifest](t, "manifest.json")
}

func loadTaskingFixture[T any](t *testing.T, name string) T {
	t.Helper()
	var encoded []byte
	var err error
	switch name {
	case "catalog.json":
		encoded, err = os.ReadFile("../../../atlas_protocol/conformance/tasking/fixtures/catalog.json")
	case "manifest.json":
		encoded, err = os.ReadFile("../../../atlas_protocol/conformance/tasking/fixtures/manifest.json")
	default:
		t.Fatalf("unknown tasking fixture %q", name)
	}
	if err != nil {
		t.Fatalf("read tasking fixture %s: %v", name, err)
	}
	var value T
	if err := json.Unmarshal(encoded, &value); err != nil {
		t.Fatalf("decode tasking fixture %s: %v", name, err)
	}
	return value
}

func TestTaskLifecycleIdempotencyOrderingAndRuntimeFencing(t *testing.T) {
	pool := openActionsTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	assetID := fmt.Sprintf("tasking-asset-%d", time.Now().UnixNano())
	defer cleanupFinalBlobValidationRowsWithTimeout(t, pool, assetID, "")

	entities := NewEntityActions(pool)
	createdEntity, err := entities.Create(ctx, CreateEntityParams{EntityID: assetID, EntityType: "asset"})
	if err != nil {
		t.Fatalf("create Asset: %v", err)
	}
	tasks := NewTaskActionsWithCatalog(pool, fixtureTaskCatalog(t))
	if err := tasks.BeginRuntimeRegistration(ctx, assetID, "runtime-1"); err != nil {
		t.Fatalf("begin runtime: %v", err)
	}
	registeringEntity, err := entities.Get(ctx, assetID)
	if err != nil {
		t.Fatalf("read registering Entity: %v", err)
	}
	if registeringEntity.Version <= createdEntity.Version {
		t.Fatalf("runtime registration Entity version = %d after %d", registeringEntity.Version, createdEntity.Version)
	}
	if err := tasks.CompleteRuntimeRegistration(ctx, assetID, "runtime-1", fixtureTaskManifest(t)); err != nil {
		t.Fatalf("ready runtime: %v", err)
	}
	readyEntity, err := entities.Get(ctx, assetID)
	if err != nil {
		t.Fatalf("read ready Entity: %v", err)
	}
	if readyEntity.Version <= registeringEntity.Version {
		t.Fatalf("runtime readiness Entity version = %d after %d", readyEntity.Version, registeringEntity.Version)
	}
	manifest, err := tasks.RuntimeManifest(ctx, assetID)
	if err != nil || len(manifest) != 2 {
		t.Fatalf("ready runtime manifest = %#v, %v", manifest, err)
	}

	first, created, err := tasks.Create(ctx, CreateTaskParams{AssetID: assetID, Command: "fixture.queued", Input: map[string]any{"value": "first"}}, "attempt-1")
	if err != nil || !created {
		t.Fatalf("create first Task = %#v, %t, %v", first, created, err)
	}
	repeated, created, err := tasks.Create(ctx, CreateTaskParams{AssetID: assetID, Command: "fixture.queued", Input: map[string]any{"value": "first"}}, "attempt-1")
	if err != nil || created || repeated.TaskID != first.TaskID {
		t.Fatalf("idempotent create = %#v, %t, %v", repeated, created, err)
	}
	if _, _, err := tasks.Create(ctx, CreateTaskParams{AssetID: assetID, Command: "fixture.queued", Input: map[string]any{"value": "changed"}}, "attempt-1"); err == nil {
		t.Fatal("reused idempotency key accepted different input")
	}
	second, _, err := tasks.Create(ctx, CreateTaskParams{AssetID: assetID, Command: "fixture.queued", Input: map[string]any{"value": "second"}}, "attempt-2")
	if err != nil {
		t.Fatalf("create second Task: %v", err)
	}
	deliverable, err := tasks.Deliverable(ctx, assetID, "runtime-1")
	if err != nil || len(deliverable) != 1 || deliverable[0].TaskID != first.TaskID {
		t.Fatalf("initial delivery = %#v, %v", deliverable, err)
	}
	if _, err := tasks.Acknowledge(ctx, first.TaskID, "stale-runtime"); err == nil {
		t.Fatal("stale runtime acknowledged a Task")
	}
	if _, err := tasks.Acknowledge(ctx, first.TaskID, "runtime-1"); err != nil {
		t.Fatalf("acknowledge first Task: %v", err)
	}
	deliverable, err = tasks.Deliverable(ctx, assetID, "runtime-1")
	if err != nil || len(deliverable) != 1 || deliverable[0].TaskID != second.TaskID {
		t.Fatalf("delivery after acknowledgement = %#v, %v", deliverable, err)
	}
	if _, err := tasks.Acknowledge(ctx, second.TaskID, "runtime-1"); err != nil {
		t.Fatalf("acknowledge second Task: %v", err)
	}
	if _, err := tasks.Start(ctx, first.TaskID, "runtime-1"); err != nil {
		t.Fatalf("start Task: %v", err)
	}
	if _, err := tasks.Start(ctx, second.TaskID, "runtime-1"); err == nil {
		t.Fatal("second queued Task started while the first was in progress")
	}
	if _, err := tasks.Progress(ctx, first.TaskID, "runtime-1", 0.5); err != nil {
		t.Fatalf("progress Task: %v", err)
	}
	if _, err := tasks.Progress(ctx, first.TaskID, "runtime-1", 0.4); err == nil {
		t.Fatal("decreasing progress was accepted")
	}
	completed, err := tasks.Complete(ctx, first.TaskID, "runtime-1", &TaskOutput{Value: map[string]any{"result": "done"}})
	if err != nil || completed.Status != string(protocol.TaskStatusCompleted) {
		t.Fatalf("complete Task = %#v, %v", completed, err)
	}
	if _, err := tasks.Cancel(ctx, first.TaskID, protocol.TaskCancellation{Code: protocol.TaskCancellationCodeRequested, Message: "too late"}); err == nil {
		t.Fatal("terminal Task accepted cancellation")
	}
	if _, err := tasks.Start(ctx, second.TaskID, "runtime-1"); err != nil {
		t.Fatalf("start second queued Task after first completed: %v", err)
	}

	immediateOne, _, err := tasks.Create(ctx, CreateTaskParams{AssetID: assetID, Command: "fixture.immediate", Input: map[string]any{}}, "attempt-immediate-1")
	if err != nil {
		t.Fatalf("create first immediate Task: %v", err)
	}
	immediateTwo, _, err := tasks.Create(ctx, CreateTaskParams{AssetID: assetID, Command: "fixture.immediate", Input: map[string]any{}}, "attempt-immediate-2")
	if err != nil {
		t.Fatalf("create second immediate Task: %v", err)
	}
	deliverable, err = tasks.Deliverable(ctx, assetID, "runtime-1")
	if err != nil || len(deliverable) != 1 || deliverable[0].TaskID != immediateOne.TaskID {
		t.Fatalf("initial immediate delivery = %#v, %v", deliverable, err)
	}
	if _, err := tasks.Start(ctx, immediateOne.TaskID, "runtime-1"); err != nil {
		t.Fatalf("start first immediate Task: %v", err)
	}
	deliverable, err = tasks.Deliverable(ctx, assetID, "runtime-1")
	if err != nil || len(deliverable) != 1 || deliverable[0].TaskID != immediateTwo.TaskID {
		t.Fatalf("immediate delivery after first start = %#v, %v", deliverable, err)
	}
	if _, err := tasks.Start(ctx, immediateTwo.TaskID, "runtime-1"); err != nil {
		t.Fatalf("start second immediate Task: %v", err)
	}
	expiredImmediate, _, err := tasks.Create(ctx, CreateTaskParams{AssetID: assetID, Command: "fixture.immediate", Input: map[string]any{}}, "attempt-immediate-expired")
	if err != nil {
		t.Fatalf("create expired immediate Task: %v", err)
	}
	freshImmediate, _, err := tasks.Create(ctx, CreateTaskParams{AssetID: assetID, Command: "fixture.immediate", Input: map[string]any{}}, "attempt-immediate-fresh")
	if err != nil {
		t.Fatalf("create fresh immediate Task: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE tasks SET created_at = clock_timestamp() - interval '61 seconds' WHERE task_id = $1`, expiredImmediate.TaskID); err != nil {
		t.Fatalf("age immediate Task: %v", err)
	}
	if count, err := tasks.ReconcileImmediateTimeouts(ctx); err != nil || count != 1 {
		t.Fatalf("reconcile immediate Task deadlines = %d, %v", count, err)
	}
	expiredImmediate, err = tasks.Get(ctx, expiredImmediate.TaskID)
	if err != nil || expiredImmediate.Status != string(protocol.TaskStatusFailed) {
		t.Fatalf("expired immediate Task = %#v, %v", expiredImmediate, err)
	}
	freshImmediate, err = tasks.Get(ctx, freshImmediate.TaskID)
	if err != nil || freshImmediate.Status != string(protocol.TaskStatusPending) {
		t.Fatalf("fresh immediate Task = %#v, %v", freshImmediate, err)
	}

	if err := tasks.BeginRuntimeRegistration(ctx, assetID, "runtime-2"); err != nil {
		t.Fatalf("restart runtime: %v", err)
	}
	fenced, err := tasks.Get(ctx, second.TaskID)
	if err != nil || fenced.Status != string(protocol.TaskStatusFailed) {
		t.Fatalf("fenced Task = %#v, %v", fenced, err)
	}
	var failure protocol.TaskFailure
	if err := json.Unmarshal(fenced.Failure, &failure); err != nil || failure.Code != protocol.TaskFailureCodeAssetRestarted {
		t.Fatalf("restart failure = %#v, %v", failure, err)
	}
	if _, err := tasks.Deliverable(ctx, assetID, "runtime-1"); err == nil {
		t.Fatal("old runtime remained eligible for delivery")
	}
}

func TestProductionCatalogRejectsEveryCommand(t *testing.T) {
	var catalog protocol.CommandCatalog
	if err := json.Unmarshal([]byte(protocol.CommandCatalogJSON), &catalog); err != nil {
		t.Fatal(err)
	}
	if len(catalog) != 0 {
		t.Fatalf("production Command Catalog has %d entries, want zero", len(catalog))
	}
	if _, ok := NewTaskActionsWithCatalog(nil, catalog).catalog["fixture.immediate"]; ok {
		t.Fatal("production Task module accepted fixture Command")
	}
}

func TestEntityMutationAndDeletionRespectTaskingBoundary(t *testing.T) {
	pool := openActionsTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	assetID := fmt.Sprintf("tasking-entity-boundary-%d", time.Now().UnixNano())
	defer cleanupFinalBlobValidationRowsWithTimeout(t, pool, assetID, "")

	entities := NewEntityActions(pool)
	if _, err := entities.Create(ctx, CreateEntityParams{EntityID: assetID, EntityType: "asset"}); err != nil {
		t.Fatalf("create Asset: %v", err)
	}
	tasks := NewTaskActionsWithCatalog(pool, fixtureTaskCatalog(t))
	if err := tasks.BeginRuntimeRegistration(ctx, assetID, "runtime-boundary"); err != nil {
		t.Fatalf("begin runtime: %v", err)
	}
	if err := tasks.CompleteRuntimeRegistration(ctx, assetID, "runtime-boundary", fixtureTaskManifest(t)); err != nil {
		t.Fatalf("ready runtime: %v", err)
	}

	trackType := "track"
	if _, err := entities.Update(ctx, assetID, UpdateEntityParams{EntityType: &trackType}); err != nil {
		t.Fatalf("change Asset type: %v", err)
	}
	if _, _, err := tasks.Create(ctx, CreateTaskParams{
		AssetID: assetID,
		Command: "fixture.queued",
		Input:   map[string]any{"value": "wrong-type"},
	}, "wrong-type-attempt"); err == nil {
		t.Fatal("Task creation accepted a non-Asset Entity with a stale runtime")
	}

	assetType := "asset"
	if _, err := entities.Update(ctx, assetID, UpdateEntityParams{EntityType: &assetType}); err != nil {
		t.Fatalf("restore Asset type: %v", err)
	}
	task, _, err := tasks.Create(ctx, CreateTaskParams{
		AssetID: assetID,
		Command: "fixture.queued",
		Input:   map[string]any{"value": "pending"},
	}, "pending-delete-attempt")
	if err != nil {
		t.Fatalf("create pending Task: %v", err)
	}
	if err := entities.Delete(ctx, assetID); err == nil {
		t.Fatal("Entity deletion accepted a nonterminal Task")
	}
	if _, err := tasks.Cancel(ctx, task.TaskID, protocol.TaskCancellation{
		Code:    protocol.TaskCancellationCodeRequested,
		Message: "Delete Asset",
	}); err != nil {
		t.Fatalf("cancel Task before deletion: %v", err)
	}
	if err := entities.Delete(ctx, assetID); err != nil {
		t.Fatalf("delete Entity after Task became terminal: %v", err)
	}
	retained, err := tasks.Get(ctx, task.TaskID)
	if err != nil || retained.Status != string(protocol.TaskStatusCancelled) {
		t.Fatalf("retained terminal Task = %#v, %v", retained, err)
	}
}

func TestTaskCompletionPreservesExplicitNullOutput(t *testing.T) {
	pool := openActionsTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	assetID := fmt.Sprintf("tasking-null-output-%d", time.Now().UnixNano())
	defer cleanupFinalBlobValidationRowsWithTimeout(t, pool, assetID, "")

	if _, err := NewEntityActions(pool).Create(ctx, CreateEntityParams{EntityID: assetID, EntityType: "asset"}); err != nil {
		t.Fatalf("create Asset: %v", err)
	}
	command := protocol.CommandDefinition{
		Command:      "fixture.null",
		Name:         "Fixture null",
		Description:  "Completes with explicit null.",
		InputSchema:  "atlas.protocol.JSONValue",
		OutputSchema: "atlas.protocol.JSONValue",
		Scheduling:   protocol.CommandSchedulingQueued,
	}
	tasks := NewTaskActionsWithCatalog(pool, protocol.CommandCatalog{command})
	manifest := protocol.CommandManifest{{
		Command:     command.Command,
		Description: command.Description,
		Scheduling:  protocol.CommandSchedulingQueued,
	}}
	if err := tasks.BeginRuntimeRegistration(ctx, assetID, "runtime-null"); err != nil {
		t.Fatalf("begin runtime: %v", err)
	}
	if err := tasks.CompleteRuntimeRegistration(ctx, assetID, "runtime-null", manifest); err != nil {
		t.Fatalf("ready runtime: %v", err)
	}
	task, _, err := tasks.Create(ctx, CreateTaskParams{AssetID: assetID, Command: command.Command, Input: map[string]any{}}, "null-output-attempt")
	if err != nil {
		t.Fatalf("create Task: %v", err)
	}
	if _, err := tasks.Acknowledge(ctx, task.TaskID, "runtime-null"); err != nil {
		t.Fatalf("acknowledge Task: %v", err)
	}
	if _, err := tasks.Start(ctx, task.TaskID, "runtime-null"); err != nil {
		t.Fatalf("start Task: %v", err)
	}
	completed, err := tasks.Complete(ctx, task.TaskID, "runtime-null", &TaskOutput{})
	if err != nil || string(completed.Output) != "null" {
		t.Fatalf("complete with explicit null = %#v, %v", completed, err)
	}
	reloaded, err := tasks.Get(ctx, task.TaskID)
	if err != nil || string(reloaded.Output) != "null" {
		t.Fatalf("reloaded explicit null = %#v, %v", reloaded, err)
	}
}

func TestImmediateTimeoutReconciliationCommitsBoundedBatches(t *testing.T) {
	pool := openActionsTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	assetID := fmt.Sprintf("timeout-batch-asset-%d", time.Now().UnixNano())
	taskPrefix := fmt.Sprintf("timeout-batch-task-%d", time.Now().UnixNano())
	defer cleanupFinalBlobValidationRowsWithTimeout(t, pool, assetID, "")

	if _, err := pool.Exec(ctx, `
		INSERT INTO tasks (
			task_id, asset_id, command, input, status, idempotency_key,
			runtime_id, created_at, updated_at, version
		)
		SELECT
			$1 || '-' || sequence,
			$2,
			'fixture.immediate',
			'{}'::jsonb,
			'pending',
			$1 || '-attempt-' || sequence,
			'runtime-1',
			clock_timestamp() - interval '61 seconds',
			clock_timestamp(),
			1
		FROM generate_series(1, $3) AS sequence
	`, taskPrefix, assetID, immediateTimeoutBatchSize+1); err != nil {
		t.Fatalf("insert expired immediate Task backlog: %v", err)
	}

	tasks := NewTaskActionsWithCatalog(pool, fixtureTaskCatalog(t))
	if count, err := tasks.ReconcileImmediateTimeouts(ctx); err != nil || count != immediateTimeoutBatchSize {
		t.Fatalf("first immediate timeout batch = %d, %v", count, err)
	}
	var failed, pending int
	if err := pool.QueryRow(ctx, `
		SELECT
			COUNT(*) FILTER (WHERE status = 'failed'),
			COUNT(*) FILTER (WHERE status = 'pending')
		FROM tasks
		WHERE asset_id = $1
	`, assetID).Scan(&failed, &pending); err != nil {
		t.Fatalf("count first immediate timeout batch: %v", err)
	}
	if failed != immediateTimeoutBatchSize || pending != 1 {
		t.Fatalf("first immediate timeout batch left failed:%d pending:%d", failed, pending)
	}

	if count, err := tasks.ReconcileImmediateTimeouts(ctx); err != nil || count != 1 {
		t.Fatalf("second immediate timeout batch = %d, %v", count, err)
	}
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM tasks WHERE asset_id = $1 AND status = 'failed'`, assetID).Scan(&failed); err != nil {
		t.Fatalf("count completed immediate timeout backlog: %v", err)
	}
	if failed != immediateTimeoutBatchSize+1 {
		t.Fatalf("completed immediate timeout backlog = %d, want %d", failed, immediateTimeoutBatchSize+1)
	}
}
