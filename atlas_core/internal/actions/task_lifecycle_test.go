package actions

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	protocol "github.com/the-drunken-coder/atlas/atlas_protocol/generated/go/atlasprotocol"
)

func fixtureTaskCatalog(t testing.TB) protocol.CommandCatalog {
	t.Helper()
	return loadTaskingFixture[protocol.CommandCatalog](t, "catalog.json")
}

func fixtureTaskManifest(t testing.TB) protocol.CommandManifest {
	t.Helper()
	return loadTaskingFixture[protocol.CommandManifest](t, "manifest.json")
}

func loadTaskingFixture[T any](t testing.TB, name string) T {
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
	detail, err := entities.GetDetail(ctx, assetID)
	if err != nil || detail.Entity.Version != readyEntity.Version || detail.CommandManifest == nil || len(*detail.CommandManifest) != 2 {
		t.Fatalf("atomic Entity detail = %#v, %v", detail, err)
	}
	if err := NewTaskActionsWithCatalog(pool, nil).CompleteRuntimeRegistration(ctx, assetID, "runtime-1", manifest); err != nil {
		t.Fatalf("idempotent ready after catalog change: %v", err)
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
	deliverable, err = tasks.Deliverable(ctx, assetID, " runtime-1 ")
	if err != nil || len(deliverable) != 1 || deliverable[0].TaskID != first.TaskID {
		t.Fatalf("normalized runtime delivery = %#v, %v", deliverable, err)
	}
	if _, err := tasks.Acknowledge(ctx, first.TaskID, "stale-runtime"); err == nil {
		t.Fatal("stale runtime acknowledged a Task")
	}
	if _, err := tasks.Acknowledge(ctx, second.TaskID, "runtime-1"); err == nil {
		t.Fatal("later queued Task was acknowledged before its pending predecessor")
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
	if _, err := tasks.Start(ctx, second.TaskID, "runtime-1"); err == nil {
		t.Fatal("later queued Task started before its acknowledged predecessor")
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
	if _, err := tasks.Start(ctx, immediateTwo.TaskID, "runtime-1"); err == nil {
		t.Fatal("later immediate Task started before its pending predecessor")
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
	deliverable, err = tasks.Deliverable(ctx, assetID, "runtime-1")
	if err != nil || len(deliverable) != 1 || deliverable[0].TaskID != freshImmediate.TaskID {
		t.Fatalf("delivery with an expired immediate predecessor = %#v, %v", deliverable, err)
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
	cancelledBeforeRestart, _, err := tasks.Create(ctx, CreateTaskParams{
		AssetID: assetID,
		Command: "fixture.queued",
		Input:   map[string]any{"value": "cancelled before restart"},
	}, "attempt-cancelled-before-restart")
	if err != nil {
		t.Fatalf("create Task to cancel before restart: %v", err)
	}
	cancellation := protocol.TaskCancellation{Code: protocol.TaskCancellationCodeRequested, Message: "stop"}
	cancelledBeforeRestart, err = tasks.Cancel(ctx, cancelledBeforeRestart.TaskID, cancellation)
	if err != nil {
		t.Fatalf("cancel Task before restart: %v", err)
	}
	cancelledVersion := cancelledBeforeRestart.Version

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
	if err := tasks.CompleteRuntimeRegistration(ctx, assetID, "runtime-2", protocol.CommandManifest{}); err != nil {
		t.Fatalf("ready replacement runtime: %v", err)
	}
	repeatedCancellation, err := tasks.Cancel(ctx, cancelledBeforeRestart.TaskID, cancellation)
	if err != nil || repeatedCancellation.Version != cancelledVersion {
		t.Fatalf("repeat cancellation after runtime replacement = %#v, %v", repeatedCancellation, err)
	}
	if _, err := tasks.Cancel(ctx, cancelledBeforeRestart.TaskID, protocol.TaskCancellation{
		Code: protocol.TaskCancellationCodeRequested, Message: "different",
	}); err == nil {
		t.Fatal("cancelled Task accepted a different cancellation after runtime replacement")
	}
}

func TestRuntimeStopFailsEveryNonterminalStateAndIsIdempotent(t *testing.T) {
	pool := openActionsTestPool(t)
	for _, status := range []protocol.TaskStatus{
		protocol.TaskStatusPending,
		protocol.TaskStatusAcknowledged,
		protocol.TaskStatusInProgress,
	} {
		t.Run(string(status), func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			statusName := strings.ReplaceAll(string(status), "_", "-")
			assetID := fmt.Sprintf("stop-%s-%d", statusName, time.Now().UnixNano())
			defer cleanupFinalBlobValidationRowsWithTimeout(t, pool, assetID, "")

			entities := NewEntityActions(pool)
			if _, err := entities.Create(ctx, CreateEntityParams{EntityID: assetID, EntityType: "asset"}); err != nil {
				t.Fatalf("create Asset: %v", err)
			}
			tasks := NewTaskActionsWithCatalog(pool, fixtureTaskCatalog(t))
			if err := tasks.BeginRuntimeRegistration(ctx, assetID, "runtime-stop"); err != nil {
				t.Fatalf("begin runtime: %v", err)
			}
			if err := tasks.CompleteRuntimeRegistration(ctx, assetID, "runtime-stop", fixtureTaskManifest(t)); err != nil {
				t.Fatalf("ready runtime: %v", err)
			}
			readyEntity, err := entities.Get(ctx, assetID)
			if err != nil {
				t.Fatalf("read ready Entity: %v", err)
			}
			task, _, err := tasks.Create(ctx, CreateTaskParams{
				AssetID: assetID,
				Command: "fixture.queued",
				Input:   map[string]any{"value": string(status)},
			}, "stop-"+string(status))
			if err != nil {
				t.Fatalf("create Task: %v", err)
			}
			if status == protocol.TaskStatusAcknowledged || status == protocol.TaskStatusInProgress {
				task, err = tasks.Acknowledge(ctx, task.TaskID, "runtime-stop")
				if err != nil {
					t.Fatalf("acknowledge Task: %v", err)
				}
			}
			if status == protocol.TaskStatusInProgress {
				task, err = tasks.Start(ctx, task.TaskID, "runtime-stop")
				if err != nil {
					t.Fatalf("start Task: %v", err)
				}
			}
			beforeTaskEvents := taskChangeEventCount(ctx, t, pool, task.TaskID)
			beforeEntityEvents := entityChangeEventCount(ctx, t, pool, assetID)

			if err := tasks.StopRuntime(ctx, assetID, "runtime-stop"); err != nil {
				t.Fatalf("stop runtime: %v", err)
			}
			stopped, err := tasks.Get(ctx, task.TaskID)
			if err != nil {
				t.Fatalf("read stopped Task: %v", err)
			}
			if stopped.Status != string(protocol.TaskStatusFailed) || stopped.Version <= task.Version {
				t.Fatalf("stopped Task = %#v, previous version %d", stopped, task.Version)
			}
			var failure protocol.TaskFailure
			if err := json.Unmarshal(stopped.Failure, &failure); err != nil || failure.Code != protocol.TaskFailureCodeAssetStopped {
				t.Fatalf("stopped Task failure = %#v, %v", failure, err)
			}
			manifest, err := tasks.RuntimeManifest(ctx, assetID)
			if err != nil || manifest != nil {
				t.Fatalf("stopped runtime manifest = %#v, %v", manifest, err)
			}
			var ready bool
			var manifestJSON []byte
			if err := pool.QueryRow(ctx, `SELECT ready, manifest FROM asset_runtimes WHERE asset_id = $1`, assetID).Scan(&ready, &manifestJSON); err != nil {
				t.Fatalf("read stopped runtime: %v", err)
			}
			if ready || !jsonEqual(manifestJSON, []byte("[]")) {
				t.Fatalf("stopped runtime ready=%t manifest=%s", ready, manifestJSON)
			}
			stoppedEntity, err := entities.Get(ctx, assetID)
			if err != nil || stoppedEntity.Version <= readyEntity.Version {
				t.Fatalf("stopped Entity = %#v after version %d, %v", stoppedEntity, readyEntity.Version, err)
			}
			if got := taskChangeEventCount(ctx, t, pool, task.TaskID); got != beforeTaskEvents+1 {
				t.Fatalf("Task feed events after stop = %d, want %d", got, beforeTaskEvents+1)
			}
			if got := entityChangeEventCount(ctx, t, pool, assetID); got != beforeEntityEvents+1 {
				t.Fatalf("Entity feed events after stop = %d, want %d", got, beforeEntityEvents+1)
			}

			if err := tasks.StopRuntime(ctx, assetID, "runtime-stop"); err != nil {
				t.Fatalf("replay runtime stop: %v", err)
			}
			replayed, err := tasks.Get(ctx, task.TaskID)
			if err != nil || replayed.Version != stopped.Version {
				t.Fatalf("replayed stop Task = %#v, want version %d, %v", replayed, stopped.Version, err)
			}
			replayedEntity, err := entities.Get(ctx, assetID)
			if err != nil || replayedEntity.Version != stoppedEntity.Version {
				t.Fatalf("replayed stop Entity = %#v, want version %d, %v", replayedEntity, stoppedEntity.Version, err)
			}
		})
	}
}

func TestRuntimeStopIgnoresMissingAndStaleRuntimeIDs(t *testing.T) {
	pool := openActionsTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	assetID := fmt.Sprintf("stop-stale-%d", time.Now().UnixNano())
	defer cleanupFinalBlobValidationRowsWithTimeout(t, pool, assetID, "")

	tasks := NewTaskActionsWithCatalog(pool, fixtureTaskCatalog(t))
	if err := tasks.StopRuntime(ctx, "missing-stop-asset", "missing-runtime"); err != nil {
		t.Fatalf("stop missing runtime: %v", err)
	}
	entities := NewEntityActions(pool)
	if _, err := entities.Create(ctx, CreateEntityParams{EntityID: assetID, EntityType: "asset"}); err != nil {
		t.Fatalf("create Asset: %v", err)
	}
	if err := tasks.BeginRuntimeRegistration(ctx, assetID, "runtime-1"); err != nil {
		t.Fatalf("begin runtime 1: %v", err)
	}
	if err := tasks.CompleteRuntimeRegistration(ctx, assetID, "runtime-1", fixtureTaskManifest(t)); err != nil {
		t.Fatalf("ready runtime 1: %v", err)
	}
	if err := tasks.BeginRuntimeRegistration(ctx, assetID, "runtime-2"); err != nil {
		t.Fatalf("begin runtime 2: %v", err)
	}
	if err := tasks.CompleteRuntimeRegistration(ctx, assetID, "runtime-2", fixtureTaskManifest(t)); err != nil {
		t.Fatalf("ready runtime 2: %v", err)
	}
	task, _, err := tasks.Create(ctx, CreateTaskParams{
		AssetID: assetID,
		Command: "fixture.queued",
		Input:   map[string]any{"value": "new runtime"},
	}, "stale-stop-new-runtime")
	if err != nil {
		t.Fatalf("create runtime 2 Task: %v", err)
	}
	beforeEntity, err := entities.Get(ctx, assetID)
	if err != nil {
		t.Fatalf("read runtime 2 Entity: %v", err)
	}

	if err := tasks.StopRuntime(ctx, assetID, "runtime-1"); err != nil {
		t.Fatalf("stop stale runtime 1: %v", err)
	}
	retained, err := tasks.Get(ctx, task.TaskID)
	if err != nil || retained.Status != string(protocol.TaskStatusPending) || retained.Version != task.Version {
		t.Fatalf("runtime 2 Task after stale stop = %#v, %v", retained, err)
	}
	afterEntity, err := entities.Get(ctx, assetID)
	if err != nil || afterEntity.Version != beforeEntity.Version {
		t.Fatalf("runtime 2 Entity after stale stop = %#v, want version %d, %v", afterEntity, beforeEntity.Version, err)
	}
	manifest, err := tasks.RuntimeManifest(ctx, assetID)
	if err != nil || len(manifest) != len(fixtureTaskManifest(t)) {
		t.Fatalf("runtime 2 manifest after stale stop = %#v, %v", manifest, err)
	}
	if deliverable, err := tasks.Deliverable(ctx, assetID, "runtime-2"); err != nil || len(deliverable) != 1 || deliverable[0].TaskID != task.TaskID {
		t.Fatalf("runtime 2 delivery after stale stop = %#v, %v", deliverable, err)
	}
}

func TestRuntimeRegistrationCannotReactivateRetiredRuntimeIDs(t *testing.T) {
	pool := openActionsTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	assetID := fmt.Sprintf("runtime-generation-%d", time.Now().UnixNano())
	defer cleanupFinalBlobValidationRowsWithTimeout(t, pool, assetID, "")

	if _, err := NewEntityActions(pool).Create(ctx, CreateEntityParams{EntityID: assetID, EntityType: "asset"}); err != nil {
		t.Fatalf("create Asset: %v", err)
	}
	tasks := NewTaskActionsWithCatalog(pool, fixtureTaskCatalog(t))
	if err := tasks.BeginRuntimeRegistration(ctx, assetID, "runtime-1"); err != nil {
		t.Fatalf("begin runtime 1: %v", err)
	}
	if err := tasks.StopRuntime(ctx, assetID, "runtime-1"); err != nil {
		t.Fatalf("stop runtime 1: %v", err)
	}
	if err := tasks.CompleteRuntimeRegistration(ctx, assetID, "runtime-1", fixtureTaskManifest(t)); err == nil {
		t.Fatal("stopped runtime became ready again")
	}
	if err := tasks.BeginRuntimeRegistration(ctx, assetID, "runtime-2"); err != nil {
		t.Fatalf("begin runtime 2: %v", err)
	}
	if err := tasks.BeginRuntimeRegistration(ctx, assetID, "runtime-1"); err == nil {
		t.Fatal("retired runtime replaced the current registration")
	}
	var currentRuntimeID string
	if err := pool.QueryRow(ctx, `SELECT runtime_id FROM asset_runtimes WHERE asset_id = $1`, assetID).Scan(&currentRuntimeID); err != nil {
		t.Fatalf("read current runtime: %v", err)
	}
	if currentRuntimeID != "runtime-2" {
		t.Fatalf("current runtime = %q, want runtime-2", currentRuntimeID)
	}
	if err := tasks.StopRuntime(ctx, assetID, "runtime-2"); err != nil {
		t.Fatalf("stop runtime 2: %v", err)
	}
	entities := NewEntityActions(pool)
	if err := entities.Delete(ctx, assetID); err != nil {
		t.Fatalf("delete Asset with retired runtimes: %v", err)
	}
	if _, err := entities.Create(ctx, CreateEntityParams{EntityID: assetID, EntityType: "asset"}); err != nil {
		t.Fatalf("recreate Asset: %v", err)
	}
	if err := tasks.BeginRuntimeRegistration(ctx, assetID, "runtime-1"); err == nil {
		t.Fatal("recreated Asset reused a retired runtime ID")
	}
	if err := tasks.BeginRuntimeRegistration(ctx, assetID, "runtime-3"); err != nil {
		t.Fatalf("recreated Asset rejected a new runtime ID: %v", err)
	}
}

func TestRuntimeTaskDrainsUseCommittedBatches(t *testing.T) {
	pool := openActionsTestPool(t)
	t.Run("restart continues an interrupted drain", func(t *testing.T) {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		assetID := fmt.Sprintf("restart-batch-%d", time.Now().UnixNano())
		defer cleanupFinalBlobValidationRowsWithTimeout(t, pool, assetID, "")
		if _, err := NewEntityActions(pool).Create(ctx, CreateEntityParams{EntityID: assetID, EntityType: "asset"}); err != nil {
			t.Fatalf("create restart batch Asset: %v", err)
		}
		tasks := NewTaskActionsWithCatalog(pool, fixtureTaskCatalog(t))
		if err := tasks.BeginRuntimeRegistration(ctx, assetID, "runtime-old"); err != nil {
			t.Fatalf("begin old runtime: %v", err)
		}
		insertRuntimeTaskBacklog(ctx, t, pool, assetID, "runtime-old", "restart-batch", runtimeTaskBatchSize+1)

		current, err := tasks.installRuntimeRegistration(ctx, assetID, "runtime-new")
		if err != nil || !current {
			t.Fatalf("install new runtime = %t, %v", current, err)
		}
		count, current, err := tasks.failRuntimeTaskBatch(ctx, assetID, "runtime-new", true, protocol.TaskFailure{
			Code:    protocol.TaskFailureCodeAssetRestarted,
			Message: "The Asset runtime restarted before the Task became terminal.",
		})
		if err != nil || !current || count != runtimeTaskBatchSize {
			t.Fatalf("first restart drain = count:%d current:%t error:%v", count, current, err)
		}
		var failed, pending int
		if err := pool.QueryRow(ctx, `
			SELECT COUNT(*) FILTER (WHERE status = 'failed'), COUNT(*) FILTER (WHERE status = 'pending')
			FROM tasks WHERE asset_id = $1
		`, assetID).Scan(&failed, &pending); err != nil {
			t.Fatalf("count first restart batch: %v", err)
		}
		if failed != runtimeTaskBatchSize || pending != 1 {
			t.Fatalf("first restart batch left failed:%d pending:%d", failed, pending)
		}
		if err := tasks.CompleteRuntimeRegistration(ctx, assetID, "runtime-new", fixtureTaskManifest(t)); err == nil {
			t.Fatal("runtime became ready before stale Task drain completed")
		}

		if err := tasks.BeginRuntimeRegistration(ctx, assetID, "runtime-new"); err != nil {
			t.Fatalf("continue exact runtime registration: %v", err)
		}
		if err := tasks.CompleteRuntimeRegistration(ctx, assetID, "runtime-new", fixtureTaskManifest(t)); err != nil {
			t.Fatalf("ready runtime after completed drain: %v", err)
		}
		if err := pool.QueryRow(ctx, `
			SELECT COUNT(*) FROM tasks
			WHERE asset_id = $1 AND status = 'failed' AND failure->>'code' = 'asset_restarted'
		`, assetID).Scan(&failed); err != nil {
			t.Fatalf("count completed restart drain: %v", err)
		}
		if failed != runtimeTaskBatchSize+1 {
			t.Fatalf("completed restart drain = %d, want %d", failed, runtimeTaskBatchSize+1)
		}
	})

	t.Run("stop drains every committed batch", func(t *testing.T) {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		assetID := fmt.Sprintf("stop-batch-%d", time.Now().UnixNano())
		defer cleanupFinalBlobValidationRowsWithTimeout(t, pool, assetID, "")
		if _, err := NewEntityActions(pool).Create(ctx, CreateEntityParams{EntityID: assetID, EntityType: "asset"}); err != nil {
			t.Fatalf("create stop batch Asset: %v", err)
		}
		tasks := NewTaskActionsWithCatalog(pool, fixtureTaskCatalog(t))
		if err := tasks.BeginRuntimeRegistration(ctx, assetID, "runtime-stop-batch"); err != nil {
			t.Fatalf("begin stop batch runtime: %v", err)
		}
		if err := tasks.CompleteRuntimeRegistration(ctx, assetID, "runtime-stop-batch", fixtureTaskManifest(t)); err != nil {
			t.Fatalf("ready stop batch runtime: %v", err)
		}
		insertRuntimeTaskBacklog(ctx, t, pool, assetID, "runtime-stop-batch", "stop-batch", runtimeTaskBatchSize+1)

		if err := tasks.StopRuntime(ctx, assetID, "runtime-stop-batch"); err != nil {
			t.Fatalf("stop runtime with Task backlog: %v", err)
		}
		var failed int
		if err := pool.QueryRow(ctx, `
			SELECT COUNT(*) FROM tasks
			WHERE asset_id = $1 AND status = 'failed' AND failure->>'code' = 'asset_stopped'
		`, assetID).Scan(&failed); err != nil {
			t.Fatalf("count stopped Task drain: %v", err)
		}
		if failed != runtimeTaskBatchSize+1 {
			t.Fatalf("stopped Task drain = %d, want %d", failed, runtimeTaskBatchSize+1)
		}
	})

	t.Run("stop finishes an interrupted replacement drain", func(t *testing.T) {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		assetID := fmt.Sprintf("stop-replacement-batch-%d", time.Now().UnixNano())
		defer cleanupFinalBlobValidationRowsWithTimeout(t, pool, assetID, "")
		if _, err := NewEntityActions(pool).Create(ctx, CreateEntityParams{EntityID: assetID, EntityType: "asset"}); err != nil {
			t.Fatalf("create replacement Asset: %v", err)
		}
		tasks := NewTaskActionsWithCatalog(pool, fixtureTaskCatalog(t))
		if err := tasks.BeginRuntimeRegistration(ctx, assetID, "runtime-old"); err != nil {
			t.Fatalf("begin old runtime: %v", err)
		}
		insertRuntimeTaskBacklog(ctx, t, pool, assetID, "runtime-old", "stop-replacement", runtimeTaskBatchSize+1)
		current, err := tasks.installRuntimeRegistration(ctx, assetID, "runtime-new")
		if err != nil || !current {
			t.Fatalf("install replacement runtime = %t, %v", current, err)
		}
		count, current, err := tasks.failRuntimeTaskBatch(ctx, assetID, "runtime-new", true, protocol.TaskFailure{
			Code: protocol.TaskFailureCodeAssetRestarted, Message: "The Asset runtime restarted before the Task became terminal.",
		})
		if err != nil || !current || count != runtimeTaskBatchSize {
			t.Fatalf("first replacement drain = count:%d current:%t error:%v", count, current, err)
		}

		if err := tasks.StopRuntime(ctx, assetID, "runtime-new"); err != nil {
			t.Fatalf("stop replacement runtime: %v", err)
		}
		var nonterminal, restarted int
		if err := pool.QueryRow(ctx, `
			SELECT COUNT(*) FILTER (WHERE status IN ('pending', 'acknowledged', 'in_progress')),
				COUNT(*) FILTER (WHERE failure->>'code' = 'asset_restarted')
			FROM tasks WHERE asset_id = $1
		`, assetID).Scan(&nonterminal, &restarted); err != nil {
			t.Fatalf("count replacement stop outcomes: %v", err)
		}
		if nonterminal != 0 || restarted != runtimeTaskBatchSize+1 {
			t.Fatalf("replacement stop left nonterminal:%d restarted:%d", nonterminal, restarted)
		}
	})

	t.Run("explicit stop wins a replacement drain race", func(t *testing.T) {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		assetID := fmt.Sprintf("stop-race-batch-%d", time.Now().UnixNano())
		defer cleanupFinalBlobValidationRowsWithTimeout(t, pool, assetID, "")
		if _, err := NewEntityActions(pool).Create(ctx, CreateEntityParams{EntityID: assetID, EntityType: "asset"}); err != nil {
			t.Fatalf("create stop race Asset: %v", err)
		}
		tasks := NewTaskActionsWithCatalog(pool, fixtureTaskCatalog(t))
		if err := tasks.BeginRuntimeRegistration(ctx, assetID, "runtime-stop-race"); err != nil {
			t.Fatalf("begin stopped runtime: %v", err)
		}
		if err := tasks.CompleteRuntimeRegistration(ctx, assetID, "runtime-stop-race", fixtureTaskManifest(t)); err != nil {
			t.Fatalf("ready stopped runtime: %v", err)
		}
		insertRuntimeTaskBacklog(ctx, t, pool, assetID, "runtime-stop-race", "stop-race", runtimeTaskBatchSize+1)
		if _, err := pool.Exec(ctx, `
			UPDATE asset_runtimes SET ready = FALSE, stopped = TRUE, manifest = '[]', ready_at = NULL
			WHERE asset_id = $1 AND runtime_id = 'runtime-stop-race'
		`, assetID); err != nil {
			t.Fatalf("commit stopped runtime state before replacement: %v", err)
		}
		if _, err := pool.Exec(ctx, `
			UPDATE asset_runtime_generations SET stopped = TRUE
			WHERE asset_id = $1 AND runtime_id = 'runtime-stop-race'
		`, assetID); err != nil {
			t.Fatalf("commit stopped runtime generation before replacement: %v", err)
		}
		current, err := tasks.installRuntimeRegistration(ctx, assetID, "runtime-replacement")
		if err != nil || !current {
			t.Fatalf("install replacement runtime = %t, %v", current, err)
		}
		count, current, err := tasks.failRuntimeTaskBatch(ctx, assetID, "runtime-replacement", true, protocol.TaskFailure{
			Code: protocol.TaskFailureCodeAssetRestarted, Message: "The Asset runtime restarted before the Task became terminal.",
		})
		if err != nil || !current || count != runtimeTaskBatchSize {
			t.Fatalf("replacement drain = count:%d current:%t error:%v", count, current, err)
		}
		count, current, err = tasks.failRuntimeTaskBatch(ctx, assetID, "runtime-stop-race", false, assetStoppedFailure)
		if err != nil || current || count != 1 {
			t.Fatalf("superseded stop drain = count:%d current:%t error:%v", count, current, err)
		}
		var stopped, restarted int
		if err := pool.QueryRow(ctx, `
			SELECT COUNT(*) FILTER (WHERE failure->>'code' = 'asset_stopped'),
				COUNT(*) FILTER (WHERE failure->>'code' = 'asset_restarted')
			FROM tasks WHERE asset_id = $1
		`, assetID).Scan(&stopped, &restarted); err != nil {
			t.Fatalf("count stop race outcomes: %v", err)
		}
		if stopped != runtimeTaskBatchSize+1 || restarted != 0 {
			t.Fatalf("stop race outcomes = stopped:%d restarted:%d", stopped, restarted)
		}
	})
}

func TestTerminalLifecycleOperationsReplayExactlyAfterRuntimeReplacement(t *testing.T) {
	pool := openActionsTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	assetID := fmt.Sprintf("terminal-replay-%d", time.Now().UnixNano())
	defer cleanupFinalBlobValidationRowsWithTimeout(t, pool, assetID, "")

	if _, err := NewEntityActions(pool).Create(ctx, CreateEntityParams{EntityID: assetID, EntityType: "asset"}); err != nil {
		t.Fatalf("create Asset: %v", err)
	}
	tasks := NewTaskActionsWithCatalog(pool, fixtureTaskCatalog(t))
	if err := tasks.BeginRuntimeRegistration(ctx, assetID, "runtime-1"); err != nil {
		t.Fatalf("begin runtime: %v", err)
	}
	if err := tasks.CompleteRuntimeRegistration(ctx, assetID, "runtime-1", fixtureTaskManifest(t)); err != nil {
		t.Fatalf("ready runtime: %v", err)
	}

	expired, _, err := tasks.Create(ctx, CreateTaskParams{AssetID: assetID, Command: "fixture.immediate", Input: map[string]any{}}, "expired-replay")
	if err != nil {
		t.Fatalf("create expired Task: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE tasks SET created_at = clock_timestamp() - interval '61 seconds' WHERE task_id = $1`, expired.TaskID); err != nil {
		t.Fatalf("age expired Task: %v", err)
	}
	expired, err = tasks.Start(ctx, expired.TaskID, "runtime-1")
	if err != nil || expired.Status != string(protocol.TaskStatusFailed) {
		t.Fatalf("first expired Start = %#v, %v", expired, err)
	}
	expiredVersion := expired.Version
	if expired, err = tasks.Start(ctx, expired.TaskID, "runtime-1"); err != nil || expired.Version != expiredVersion {
		t.Fatalf("repeated expired Start = %#v, want version %d, %v", expired, expiredVersion, err)
	}

	invalid, _, err := tasks.Create(ctx, CreateTaskParams{AssetID: assetID, Command: "fixture.queued", Input: map[string]any{"value": "invalid"}}, "invalid-complete-replay")
	if err != nil {
		t.Fatalf("create invalid-output Task: %v", err)
	}
	if _, err := tasks.Acknowledge(ctx, invalid.TaskID, "runtime-1"); err != nil {
		t.Fatalf("acknowledge invalid-output Task: %v", err)
	}
	if _, err := tasks.Start(ctx, invalid.TaskID, "runtime-1"); err != nil {
		t.Fatalf("start invalid-output Task: %v", err)
	}
	invalid, err = tasks.Complete(ctx, invalid.TaskID, "runtime-1", nil)
	if err != nil || invalid.Status != string(protocol.TaskStatusFailed) {
		t.Fatalf("first invalid completion = %#v, %v", invalid, err)
	}
	invalidVersion := invalid.Version
	if invalid, err = tasks.Complete(ctx, invalid.TaskID, "runtime-1", nil); err != nil || invalid.Version != invalidVersion {
		t.Fatalf("repeated invalid completion = %#v, want version %d, %v", invalid, invalidVersion, err)
	}

	completed, _, err := tasks.Create(ctx, CreateTaskParams{AssetID: assetID, Command: "fixture.queued", Input: map[string]any{"value": "complete"}}, "completed-replay")
	if err != nil {
		t.Fatalf("create completion replay Task: %v", err)
	}
	if _, err := tasks.Acknowledge(ctx, completed.TaskID, "runtime-1"); err != nil {
		t.Fatalf("acknowledge completion replay Task: %v", err)
	}
	if _, err := tasks.Start(ctx, completed.TaskID, "runtime-1"); err != nil {
		t.Fatalf("start completion replay Task: %v", err)
	}
	output := &TaskOutput{Value: map[string]any{"result": "done"}}
	completed, err = tasks.Complete(ctx, completed.TaskID, "runtime-1", output)
	if err != nil {
		t.Fatalf("complete replay Task: %v", err)
	}

	failed, _, err := tasks.Create(ctx, CreateTaskParams{AssetID: assetID, Command: "fixture.queued", Input: map[string]any{"value": "fail"}}, "failed-replay")
	if err != nil {
		t.Fatalf("create failure replay Task: %v", err)
	}
	failure := protocol.TaskFailure{Code: protocol.TaskFailureCodeExecutionFailed, Message: "failed once"}
	failed, err = tasks.Fail(ctx, failed.TaskID, "runtime-1", failure)
	if err != nil {
		t.Fatalf("fail replay Task: %v", err)
	}

	cancelled, _, err := tasks.Create(ctx, CreateTaskParams{AssetID: assetID, Command: "fixture.queued", Input: map[string]any{"value": "cancel"}}, "cancelled-replay")
	if err != nil {
		t.Fatalf("create cancellation replay Task: %v", err)
	}
	cancellation := protocol.TaskCancellation{Code: protocol.TaskCancellationCodeRequested, Message: "cancelled once"}
	cancelled, err = tasks.Cancel(ctx, cancelled.TaskID, cancellation)
	if err != nil {
		t.Fatalf("cancel replay Task: %v", err)
	}

	if err := tasks.BeginRuntimeRegistration(ctx, assetID, "runtime-2"); err != nil {
		t.Fatalf("replace runtime: %v", err)
	}
	if err := tasks.CompleteRuntimeRegistration(ctx, assetID, "runtime-2", fixtureTaskManifest(t)); err != nil {
		t.Fatalf("ready replacement runtime: %v", err)
	}
	cataloglessTasks := NewTaskActionsWithCatalog(pool, nil)
	if replayed, err := cataloglessTasks.Start(ctx, expired.TaskID, "runtime-1"); err != nil || replayed.Version != expired.Version {
		t.Fatalf("expired Start replay after replacement = %#v, want version %d, %v", replayed, expired.Version, err)
	}
	if replayed, err := cataloglessTasks.Complete(ctx, invalid.TaskID, "runtime-1", nil); err != nil || replayed.Version != invalid.Version {
		t.Fatalf("invalid completion replay after replacement = %#v, want version %d, %v", replayed, invalid.Version, err)
	}
	if _, err := cataloglessTasks.Complete(ctx, invalid.TaskID, "runtime-1", &TaskOutput{Value: map[string]any{"result": 17}}); err == nil {
		t.Fatal("invalid completion replay accepted a different rejected payload without the current Command catalog")
	}
	if replayed, err := cataloglessTasks.Complete(ctx, completed.TaskID, "runtime-1", output); err != nil || replayed.Version != completed.Version {
		t.Fatalf("completion replay after replacement = %#v, want version %d, %v", replayed, completed.Version, err)
	}
	if _, err := cataloglessTasks.Complete(ctx, completed.TaskID, "runtime-1", &TaskOutput{Value: map[string]any{"result": "different"}}); err == nil {
		t.Fatal("completion replay accepted different output without the current Command catalog")
	}
	if _, err := cataloglessTasks.Complete(ctx, completed.TaskID, "runtime-2", output); err == nil {
		t.Fatal("replacement runtime replayed a Task bound to the retired runtime")
	}
	if replayed, err := cataloglessTasks.Fail(ctx, failed.TaskID, "runtime-1", failure); err != nil || replayed.Version != failed.Version {
		t.Fatalf("failure replay after replacement = %#v, want version %d, %v", replayed, failed.Version, err)
	}
	if replayed, err := cataloglessTasks.Cancel(ctx, cancelled.TaskID, cancellation); err != nil || replayed.Version != cancelled.Version {
		t.Fatalf("cancellation replay after catalog removal = %#v, want version %d, %v", replayed, cancelled.Version, err)
	}
}

func insertRuntimeTaskBacklog(ctx context.Context, t *testing.T, pool interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
}, assetID, runtimeID, prefix string, count int) {
	t.Helper()
	if _, err := pool.Exec(ctx, `
		INSERT INTO tasks (
			task_id, asset_id, command, input, status, idempotency_key,
			runtime_id, created_at, updated_at, version
		)
		SELECT
			$1 || '-' || sequence,
			$2,
			'fixture.queued',
			'{}'::jsonb,
			'pending',
			$1 || '-attempt-' || sequence,
			$3,
			clock_timestamp(),
			clock_timestamp(),
			1
		FROM generate_series(1, $4) AS sequence
	`, prefix, assetID, runtimeID, count); err != nil {
		t.Fatalf("insert runtime Task backlog: %v", err)
	}
}

func taskChangeEventCount(ctx context.Context, t *testing.T, pool interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}, taskID string) int {
	t.Helper()
	var count int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM atlas_change_events WHERE event->>'resource_type' = 'task' AND event->>'id' = $1`, taskID).Scan(&count); err != nil {
		t.Fatalf("count Task feed events: %v", err)
	}
	return count
}

func entityChangeEventCount(ctx context.Context, t *testing.T, pool interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}, entityID string) int {
	t.Helper()
	var count int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM atlas_change_events WHERE event->>'resource_type' = 'entity' AND event->>'id' = $1`, entityID).Scan(&count); err != nil {
		t.Fatalf("count Entity feed events: %v", err)
	}
	return count
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

func TestConcurrentTaskCreateIdempotency(t *testing.T) {
	pool := openActionsTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	assetID := fmt.Sprintf("tasking-idempotency-%d", time.Now().UnixNano())
	defer cleanupFinalBlobValidationRowsWithTimeout(t, pool, assetID, "")

	entities := NewEntityActions(pool)
	if _, err := entities.Create(ctx, CreateEntityParams{EntityID: assetID, EntityType: "asset"}); err != nil {
		t.Fatalf("create Asset: %v", err)
	}
	tasks := NewTaskActionsWithCatalog(pool, fixtureTaskCatalog(t))
	if err := tasks.BeginRuntimeRegistration(ctx, assetID, "runtime-idempotency"); err != nil {
		t.Fatalf("begin runtime: %v", err)
	}
	if err := tasks.CompleteRuntimeRegistration(ctx, assetID, "runtime-idempotency", fixtureTaskManifest(t)); err != nil {
		t.Fatalf("ready runtime: %v", err)
	}

	type result struct {
		taskID  string
		created bool
		err     error
	}
	const callers = 8
	results := make(chan result, callers)
	start := make(chan struct{})
	var workers sync.WaitGroup
	for range callers {
		workers.Add(1)
		go func() {
			defer workers.Done()
			<-start
			task, created, err := tasks.Create(ctx, CreateTaskParams{
				AssetID: assetID,
				Command: "fixture.queued",
				Input:   map[string]any{"value": "same"},
			}, "concurrent-same")
			var taskID string
			if task != nil {
				taskID = task.TaskID
			}
			results <- result{taskID: taskID, created: created, err: err}
		}()
	}
	close(start)
	workers.Wait()
	close(results)

	createdCount := 0
	var taskID string
	for result := range results {
		if result.err != nil {
			t.Fatalf("concurrent identical create: %v", result.err)
		}
		if result.created {
			createdCount++
		}
		if taskID == "" {
			taskID = result.taskID
		} else if result.taskID != taskID {
			t.Fatalf("concurrent creates returned Task IDs %q and %q", taskID, result.taskID)
		}
	}
	if createdCount != 1 {
		t.Fatalf("concurrent creates reported created %d times, want 1", createdCount)
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
	if _, err := entities.Update(ctx, assetID, UpdateEntityParams{EntityType: &trackType}); err == nil {
		t.Fatal("Entity type changed after an Asset runtime registered")
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

func TestDeliverableRejectsStoredUnknownCommand(t *testing.T) {
	pool := openActionsTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	assetID := fmt.Sprintf("unknown-command-asset-%d", time.Now().UnixNano())
	defer cleanupFinalBlobValidationRowsWithTimeout(t, pool, assetID, "")

	if _, err := NewEntityActions(pool).Create(ctx, CreateEntityParams{EntityID: assetID, EntityType: "asset"}); err != nil {
		t.Fatalf("create Asset: %v", err)
	}
	tasks := NewTaskActionsWithCatalog(pool, fixtureTaskCatalog(t))
	if err := tasks.BeginRuntimeRegistration(ctx, assetID, "runtime-unknown-command"); err != nil {
		t.Fatalf("begin runtime: %v", err)
	}
	if err := tasks.CompleteRuntimeRegistration(ctx, assetID, "runtime-unknown-command", fixtureTaskManifest(t)); err != nil {
		t.Fatalf("ready runtime: %v", err)
	}
	created, _, err := tasks.Create(ctx, CreateTaskParams{
		AssetID: assetID,
		Command: "fixture.queued",
		Input:   map[string]any{"value": "catalog removal"},
	}, "unknown-command-attempt")
	if err != nil {
		t.Fatalf("create Task before catalog removal: %v", err)
	}

	withoutCommand := NewTaskActionsWithCatalog(pool, nil)
	if _, err := withoutCommand.Deliverable(ctx, assetID, "runtime-unknown-command"); err == nil {
		t.Fatal("delivery silently treated a stored unknown Command as queued")
	}
	retained, err := tasks.Get(ctx, created.TaskID)
	if err != nil || retained.Status != string(protocol.TaskStatusPending) {
		t.Fatalf("unknown-command Task was not retained for recovery = %#v, %v", retained, err)
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
