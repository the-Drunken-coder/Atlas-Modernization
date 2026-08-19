package actions

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/the-drunken-coder/atlas/atlas_core/internal/models"
	protocol "github.com/the-drunken-coder/atlas/atlas_protocol/generated/go/atlasprotocol"
)

var taskStateTestTime = time.Date(2026, 8, 19, 12, 0, 0, 0, time.UTC)

func TestTaskLifecycleStateMachine(t *testing.T) {
	catalog := fixtureTaskCatalog(t)
	commands := NewTaskActionsWithCatalog(nil, catalog).catalog
	queued := commands["fixture.queued"]
	immediate := commands["fixture.immediate"]
	progressManifest := protocol.CommandManifestEntry{SupportsProgress: true}
	cancellableManifest := protocol.CommandManifestEntry{SupportsCancel: true}

	t.Run("acknowledge", func(t *testing.T) {
		task := taskStateFixture(protocol.TaskStatusPending)
		changed, err := acknowledgeTask(task, queued, protocol.CommandManifestEntry{}, taskStateTestTime)
		if err != nil || !changed || task.Status != string(protocol.TaskStatusAcknowledged) || task.AcknowledgedAt == nil {
			t.Fatalf("acknowledgeTask = %#v, %t, %v", task, changed, err)
		}
		if changed, err = acknowledgeTask(task, queued, protocol.CommandManifestEntry{}, taskStateTestTime); err != nil || changed {
			t.Fatalf("repeated acknowledge = %t, %v", changed, err)
		}
		if _, err := acknowledgeTask(taskStateFixture(protocol.TaskStatusPending), immediate, protocol.CommandManifestEntry{}, taskStateTestTime); err == nil {
			t.Fatal("immediate Task accepted acknowledgement")
		}
		if _, err := acknowledgeTask(taskStateFixture(protocol.TaskStatusInProgress), queued, protocol.CommandManifestEntry{}, taskStateTestTime); err == nil {
			t.Fatal("in-progress Task accepted acknowledgement")
		}
	})

	t.Run("start", func(t *testing.T) {
		queuedTask := taskStateFixture(protocol.TaskStatusAcknowledged)
		changed, err := startTask(queuedTask, queued, protocol.CommandManifestEntry{}, taskStateTestTime)
		if err != nil || !changed || queuedTask.Status != string(protocol.TaskStatusInProgress) || queuedTask.StartedAt == nil {
			t.Fatalf("start queued Task = %#v, %t, %v", queuedTask, changed, err)
		}
		if changed, err = startTask(queuedTask, queued, protocol.CommandManifestEntry{}, taskStateTestTime); err != nil || changed {
			t.Fatalf("repeated start = %t, %v", changed, err)
		}
		immediateTask := taskStateFixture(protocol.TaskStatusPending)
		if changed, err = startTask(immediateTask, immediate, protocol.CommandManifestEntry{}, taskStateTestTime); err != nil || !changed || immediateTask.AcknowledgedAt == nil {
			t.Fatalf("start immediate Task = %#v, %t, %v", immediateTask, changed, err)
		}
		if _, err := startTask(taskStateFixture(protocol.TaskStatusPending), queued, protocol.CommandManifestEntry{}, taskStateTestTime); err == nil {
			t.Fatal("pending queued Task started before acknowledgement")
		}
	})

	t.Run("progress", func(t *testing.T) {
		if _, err := progressTask(taskStateFixture(protocol.TaskStatusPending), queued, progressManifest, taskStateTestTime, 0.5); err == nil {
			t.Fatal("pending Task accepted progress")
		}
		if _, err := progressTask(taskStateFixture(protocol.TaskStatusInProgress), queued, protocol.CommandManifestEntry{}, taskStateTestTime, 0.5); err == nil {
			t.Fatal("Task without manifest support accepted progress")
		}
		if _, err := progressTask(taskStateFixture(protocol.TaskStatusInProgress), queued, progressManifest, taskStateTestTime, -0.1); err == nil {
			t.Fatal("Task accepted out-of-range progress")
		}
		task := taskStateFixture(protocol.TaskStatusInProgress)
		changed, err := progressTask(task, queued, progressManifest, taskStateTestTime, 0.5)
		if err != nil || !changed || task.Progress == nil || *task.Progress != 0.5 {
			t.Fatalf("progress Task = %#v, %t, %v", task, changed, err)
		}
		if changed, err = progressTask(task, queued, progressManifest, taskStateTestTime, 0.5); err != nil || changed {
			t.Fatalf("repeated progress = %t, %v", changed, err)
		}
		if _, err := progressTask(task, queued, progressManifest, taskStateTestTime, 0.4); err == nil {
			t.Fatal("Task accepted decreasing progress")
		}
		if changed, err = progressTask(task, queued, progressManifest, taskStateTestTime, 0.75); err != nil || !changed || *task.Progress != 0.75 {
			t.Fatalf("increased progress = %#v, %t, %v", task, changed, err)
		}
	})

	t.Run("complete", func(t *testing.T) {
		if _, err := completeTask(taskStateFixture(protocol.TaskStatusInProgress), immediate, protocol.CommandManifestEntry{}, taskStateTestTime, map[string]any{"unexpected": true}); err == nil {
			t.Fatal("Command without output schema accepted output")
		}
		if _, err := completeTask(taskStateFixture(protocol.TaskStatusInProgress), queued, protocol.CommandManifestEntry{}, taskStateTestTime, nil); err == nil {
			t.Fatal("Command requiring output accepted nil")
		}
		if _, err := completeTask(taskStateFixture(protocol.TaskStatusInProgress), queued, protocol.CommandManifestEntry{}, taskStateTestTime, map[string]any{"result": ""}); err == nil {
			t.Fatal("Command accepted invalid output")
		}
		task := taskStateFixture(protocol.TaskStatusInProgress)
		output := map[string]any{"result": "done"}
		changed, err := completeTask(task, queued, protocol.CommandManifestEntry{}, taskStateTestTime, output)
		if err != nil || !changed || task.Status != string(protocol.TaskStatusCompleted) || task.FinishedAt == nil {
			t.Fatalf("complete Task = %#v, %t, %v", task, changed, err)
		}
		if changed, err = completeTask(task, queued, protocol.CommandManifestEntry{}, taskStateTestTime, output); err != nil || changed {
			t.Fatalf("repeated completion = %t, %v", changed, err)
		}
		if _, err := completeTask(task, queued, protocol.CommandManifestEntry{}, taskStateTestTime, map[string]any{"result": "changed"}); err == nil {
			t.Fatal("completed Task accepted different output")
		}
		if _, err := completeTask(taskStateFixture(protocol.TaskStatusPending), queued, protocol.CommandManifestEntry{}, taskStateTestTime, output); err == nil {
			t.Fatal("pending Task completed")
		}
		withoutOutput := taskStateFixture(protocol.TaskStatusInProgress)
		if changed, err = completeTask(withoutOutput, immediate, protocol.CommandManifestEntry{}, taskStateTestTime, nil); err != nil || !changed || withoutOutput.Output != nil {
			t.Fatalf("complete output-less Task = %#v, %t, %v", withoutOutput, changed, err)
		}
	})

	t.Run("fail", func(t *testing.T) {
		failure := protocol.TaskFailure{Code: protocol.TaskFailureCodeExecutionFailed, Message: "boom"}
		task := taskStateFixture(protocol.TaskStatusInProgress)
		changed, err := failTask(task, queued, protocol.CommandManifestEntry{}, taskStateTestTime, failure)
		if err != nil || !changed || task.Status != string(protocol.TaskStatusFailed) || task.FinishedAt == nil {
			t.Fatalf("fail Task = %#v, %t, %v", task, changed, err)
		}
		if changed, err = failTask(task, queued, protocol.CommandManifestEntry{}, taskStateTestTime, failure); err != nil || changed {
			t.Fatalf("repeated failure = %t, %v", changed, err)
		}
		if _, err := failTask(task, queued, protocol.CommandManifestEntry{}, taskStateTestTime, protocol.TaskFailure{Code: protocol.TaskFailureCodeInvalidOutput, Message: "changed"}); err == nil {
			t.Fatal("failed Task accepted a different failure")
		}
		if _, err := failTask(taskStateFixture(protocol.TaskStatusCompleted), queued, protocol.CommandManifestEntry{}, taskStateTestTime, failure); err == nil {
			t.Fatal("completed Task accepted failure")
		}
	})

	t.Run("cancel", func(t *testing.T) {
		cancellation := protocol.TaskCancellation{Code: protocol.TaskCancellationCodeRequested, Message: "stop"}
		task := taskStateFixture(protocol.TaskStatusPending)
		changed, err := cancelTask(task, queued, cancellableManifest, taskStateTestTime, cancellation)
		if err != nil || !changed || task.Status != string(protocol.TaskStatusCancelled) || task.FinishedAt == nil {
			t.Fatalf("cancel Task = %#v, %t, %v", task, changed, err)
		}
		if changed, err = cancelTask(task, queued, cancellableManifest, taskStateTestTime, cancellation); err != nil || changed {
			t.Fatalf("repeated cancellation = %t, %v", changed, err)
		}
		if _, err := cancelTask(task, queued, cancellableManifest, taskStateTestTime, protocol.TaskCancellation{Code: protocol.TaskCancellationCodeSuperseded, Message: "changed"}); err == nil {
			t.Fatal("cancelled Task accepted a different cancellation")
		}
		if _, err := cancelTask(taskStateFixture(protocol.TaskStatusCompleted), queued, cancellableManifest, taskStateTestTime, cancellation); err == nil {
			t.Fatal("completed Task accepted cancellation")
		}
		if _, err := cancelTask(taskStateFixture(protocol.TaskStatusInProgress), queued, protocol.CommandManifestEntry{}, taskStateTestTime, cancellation); err == nil {
			t.Fatal("in-progress Task without manifest support accepted cancellation")
		}
		if changed, err = cancelTask(taskStateFixture(protocol.TaskStatusInProgress), queued, cancellableManifest, taskStateTestTime, cancellation); err != nil || !changed {
			t.Fatalf("cancel supported in-progress Task = %t, %v", changed, err)
		}
	})
}

func TestTaskActionValidationBeforePersistence(t *testing.T) {
	ctx := context.Background()
	tasks := NewTaskActionsWithCatalog(nil, fixtureTaskCatalog(t))
	if len(tasks.catalog) != 2 || NewTaskActions(nil) == nil {
		t.Fatal("Task action constructors did not retain their catalogs")
	}
	if _, _, err := tasks.Create(ctx, CreateTaskParams{}, ""); err == nil {
		t.Fatal("Task create accepted an empty idempotency key")
	}
	if _, _, err := tasks.Create(ctx, CreateTaskParams{AssetID: "", Command: "fixture.queued", Input: map[string]any{"value": "x"}}, "attempt"); err == nil {
		t.Fatal("Task create accepted an invalid Asset ID")
	}
	for name, call := range map[string]func() error{
		"acknowledge": func() error { _, err := tasks.Acknowledge(ctx, "task-1", " "); return err },
		"start":       func() error { _, err := tasks.Start(ctx, "task-1", " "); return err },
		"progress":    func() error { _, err := tasks.Progress(ctx, "task-1", " ", 0.5); return err },
		"complete":    func() error { _, err := tasks.Complete(ctx, "task-1", " ", nil); return err },
		"fail": func() error {
			_, err := tasks.Fail(ctx, "task-1", " ", protocol.TaskFailure{Code: protocol.TaskFailureCodeExecutionFailed, Message: "boom"})
			return err
		},
	} {
		if err := call(); err == nil {
			t.Fatalf("%s accepted an empty runtime ID", name)
		}
	}
	if _, err := tasks.Cancel(ctx, "", protocol.TaskCancellation{Code: protocol.TaskCancellationCodeRequested, Message: "stop"}); err == nil {
		t.Fatal("cancel accepted an invalid Task ID")
	}
	if err := tasks.BeginRuntimeRegistration(ctx, "", "runtime-1"); err == nil {
		t.Fatal("runtime registration accepted an invalid Asset ID")
	}
	if err := tasks.BeginRuntimeRegistration(ctx, "asset-1", ""); err == nil {
		t.Fatal("runtime registration accepted an invalid runtime ID")
	}
	if err := tasks.CompleteRuntimeRegistration(ctx, "asset-1", "runtime-1", protocol.CommandManifest{{Command: "unknown", Description: "Unknown"}}); err == nil {
		t.Fatal("runtime accepted a Command outside the catalog")
	}
	if err := tasks.CompleteRuntimeRegistration(ctx, "asset-1", "runtime-1", protocol.CommandManifest{{Command: "fixture.immediate", Description: "Immediate", Scheduling: protocol.CommandSchedulingQueued}}); err == nil {
		t.Fatal("runtime accepted mismatched scheduling")
	}
	manifest := fixtureTaskManifest(t)
	if err := tasks.CompleteRuntimeRegistration(ctx, "asset-1", "runtime-1", append(manifest, manifest[0])); err == nil {
		t.Fatal("runtime accepted a duplicate Command Manifest entry")
	}
	if count, err := NewTaskActionsWithCatalog(nil, nil).ReconcileImmediateTimeouts(ctx, taskStateTestTime); err != nil || count != 0 {
		t.Fatalf("empty-catalog reconciliation = %d, %v", count, err)
	}
}

func TestTaskStateHelpers(t *testing.T) {
	if commandDefinitionName("atlas.tasking.FixtureOutput") != "FixtureOutput" || commandDefinitionName("FixtureOutput") != "FixtureOutput" {
		t.Fatal("Command definition reference was not normalized")
	}
	manifest := protocol.CommandManifest{{Command: "fixture.queued", Description: "Queued"}}
	if entry, ok := manifestEntry(manifest, "fixture.queued"); !ok || entry.Command != "fixture.queued" {
		t.Fatalf("manifestEntry = %#v, %t", entry, ok)
	}
	if _, ok := manifestEntry(manifest, "missing"); ok {
		t.Fatal("manifestEntry found an absent Command")
	}
	if effectiveScheduling("") != protocol.CommandSchedulingQueued || effectiveScheduling(protocol.CommandSchedulingImmediate) != protocol.CommandSchedulingImmediate {
		t.Fatal("effectiveScheduling did not apply the queued default")
	}
	if !jsonEqual([]byte(`{"a":1,"b":2}`), []byte(`{"b":2,"a":1}`)) || jsonEqual([]byte(`{`), []byte(`[`)) {
		t.Fatal("jsonEqual did not compare canonical and malformed JSON correctly")
	}
	if nullableJSON(nil) != nil || nullableJSON([]byte(`{}`)) == nil {
		t.Fatal("nullableJSON did not preserve SQL null semantics")
	}
	for _, status := range []protocol.TaskStatus{protocol.TaskStatusCompleted, protocol.TaskStatusFailed, protocol.TaskStatusCancelled} {
		if !taskTerminal(string(status)) {
			t.Fatalf("%s was not terminal", status)
		}
	}
	if taskTerminal(string(protocol.TaskStatusInProgress)) {
		t.Fatal("in-progress Task was terminal")
	}
	if requireRuntimeID("runtime-1") != nil || requireRuntimeID(" ") == nil {
		t.Fatal("runtime ID validation did not distinguish empty values")
	}
	if invalidTaskTransition(taskStateFixture(protocol.TaskStatusPending), "complete") == nil {
		t.Fatal("invalid Task transition did not return an error")
	}
	encoded, err := encodeTaskOutput(protocol.CommandDefinition{OutputSchema: "atlas.tasking.FixtureOutput"}, map[string]any{"result": "done"})
	if err != nil {
		t.Fatalf("encode valid output: %v", err)
	}
	var output map[string]any
	if err := json.Unmarshal(encoded, &output); err != nil || output["result"] != "done" {
		t.Fatalf("encoded output = %#v, %v", output, err)
	}
}

func taskStateFixture(status protocol.TaskStatus) *models.Task {
	return &models.Task{TaskID: "task-1", AssetID: "asset-1", Command: "fixture.queued", Status: string(status)}
}
