package actions

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/the-drunken-coder/atlas/services/core/internal/models"
	protocol "github.com/the-drunken-coder/atlas/packages/protocol/generated/go/atlasprotocol"
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
		expiredTask := taskStateFixture(protocol.TaskStatusPending)
		expiredTask.CreatedAt = taskStateTestTime.Add(-immediateStartWindow)
		if changed, err = startTask(expiredTask, immediate, protocol.CommandManifestEntry{}, taskStateTestTime); err != nil || !changed || expiredTask.Status != string(protocol.TaskStatusFailed) {
			t.Fatalf("start expired immediate Task = %#v, %t, %v", expiredTask, changed, err)
		}
		var timeoutFailure protocol.TaskFailure
		if err := json.Unmarshal(expiredTask.Failure, &timeoutFailure); err != nil || timeoutFailure.Code != protocol.TaskFailureCodeImmediateStartTimeout {
			t.Fatalf("expired immediate Task failure = %#v, %v", timeoutFailure, err)
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
		for name, testCase := range map[string]struct {
			command protocol.CommandDefinition
			output  *TaskOutput
		}{
			"unexpected output": {command: immediate, output: &TaskOutput{Value: map[string]any{"unexpected": true}}},
			"unexpected null":   {command: immediate, output: &TaskOutput{}},
			"missing output":    {command: queued},
			"invalid output":    {command: queued, output: &TaskOutput{Value: map[string]any{"result": ""}}},
		} {
			t.Run(name, func(t *testing.T) {
				task := taskStateFixture(protocol.TaskStatusInProgress)
				changed, err := completeTask(task, testCase.command, protocol.CommandManifestEntry{}, taskStateTestTime, testCase.output)
				if err != nil || !changed || task.Status != string(protocol.TaskStatusFailed) {
					t.Fatalf("invalid completion = %#v, %t, %v", task, changed, err)
				}
				var failure protocol.TaskFailure
				if err := json.Unmarshal(task.Failure, &failure); err != nil || failure.Code != protocol.TaskFailureCodeInvalidOutput {
					t.Fatalf("invalid completion failure = %#v, %v", failure, err)
				}
				encoded, err := encodeTaskOutputAttempt(testCase.output)
				attempt, storedErr := encodeStoredCompletionAttempt(testCase.output, encoded)
				if err != nil || storedErr != nil || !jsonEqual(task.CompletionAttempt, attempt) {
					t.Fatalf("stored completion attempt = %s, want %s, %v, %v", task.CompletionAttempt, attempt, err, storedErr)
				}
				if changed, err = completeTask(task, testCase.command, protocol.CommandManifestEntry{}, taskStateTestTime, testCase.output); err != nil || changed {
					t.Fatalf("repeated invalid completion = %t, %v", changed, err)
				}
			})
		}
		rejected := taskStateFixture(protocol.TaskStatusInProgress)
		if changed, err := completeTask(rejected, queued, protocol.CommandManifestEntry{}, taskStateTestTime, &TaskOutput{Value: map[string]any{"result": ""}}); err != nil || !changed {
			t.Fatalf("reject first invalid output = %t, %v", changed, err)
		}
		if _, err := completeTask(rejected, protocol.CommandDefinition{}, protocol.CommandManifestEntry{}, taskStateTestTime, &TaskOutput{Value: map[string]any{"result": 17}}); err == nil {
			t.Fatal("invalid-output Task accepted a different rejected payload as an exact retry")
		}
		legacyRejected := taskStateFixture(protocol.TaskStatusFailed)
		legacyRejected.Failure = mustMarshalTaskFailure(protocol.TaskFailure{Code: protocol.TaskFailureCodeInvalidOutput, Message: "Invalid Command output"})
		if _, err := completeTask(legacyRejected, protocol.CommandDefinition{}, protocol.CommandManifestEntry{}, taskStateTestTime, nil); err == nil {
			t.Fatal("legacy invalid-output Task accepted an unrecorded completion attempt as an exact retry")
		}
		task := taskStateFixture(protocol.TaskStatusInProgress)
		output := &TaskOutput{Value: map[string]any{"result": "done"}}
		changed, err := completeTask(task, queued, protocol.CommandManifestEntry{}, taskStateTestTime, output)
		if err != nil || !changed || task.Status != string(protocol.TaskStatusCompleted) || task.FinishedAt == nil {
			t.Fatalf("complete Task = %#v, %t, %v", task, changed, err)
		}
		if changed, err = completeTask(task, queued, protocol.CommandManifestEntry{}, taskStateTestTime, output); err != nil || changed {
			t.Fatalf("repeated completion = %t, %v", changed, err)
		}
		if _, err := completeTask(task, queued, protocol.CommandManifestEntry{}, taskStateTestTime, &TaskOutput{Value: map[string]any{"result": "changed"}}); err == nil {
			t.Fatal("completed Task accepted different output")
		}
		if _, err := completeTask(task, protocol.CommandDefinition{}, protocol.CommandManifestEntry{}, taskStateTestTime, &TaskOutput{Value: func() {}}); err == nil {
			t.Fatal("completed Task accepted output that cannot be encoded as JSON")
		}
		if _, err := completeTask(taskStateFixture(protocol.TaskStatusPending), queued, protocol.CommandManifestEntry{}, taskStateTestTime, output); err == nil {
			t.Fatal("pending Task completed")
		}
		withoutOutput := taskStateFixture(protocol.TaskStatusInProgress)
		if changed, err = completeTask(withoutOutput, immediate, protocol.CommandManifestEntry{}, taskStateTestTime, nil); err != nil || !changed || withoutOutput.Output != nil {
			t.Fatalf("complete output-less Task = %#v, %t, %v", withoutOutput, changed, err)
		}
		nullable := protocol.CommandDefinition{OutputSchema: "atlas.protocol.JSONValue"}
		withNull := taskStateFixture(protocol.TaskStatusInProgress)
		if changed, err = completeTask(withNull, nullable, protocol.CommandManifestEntry{}, taskStateTestTime, &TaskOutput{}); err != nil || !changed || string(withNull.Output) != "null" {
			t.Fatalf("complete Task with explicit null = %#v, %t, %v", withNull, changed, err)
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
	if _, err := tasks.Fail(ctx, "task-1", "runtime-1", protocol.TaskFailure{Code: protocol.TaskFailureCodeAssetRestarted, Message: "restart"}); err == nil {
		t.Fatal("Asset failure accepted a Core-owned code")
	}
	if _, err := tasks.Cancel(ctx, "task-1", protocol.TaskCancellation{Code: protocol.TaskCancellationCodeSuperseded, Message: "superseded"}); err == nil {
		t.Fatal("tasking cancellation accepted a Core-owned code")
	}
	if err := tasks.BeginRuntimeRegistration(ctx, "", "runtime-1"); err == nil {
		t.Fatal("runtime registration accepted an invalid Asset ID")
	}
	if err := tasks.BeginRuntimeRegistration(ctx, "asset-1", ""); err == nil {
		t.Fatal("runtime registration accepted an invalid runtime ID")
	}
	if err := validateCommandManifestCatalog(tasks.catalog, protocol.CommandManifest{{Command: "unknown", Description: "Unknown"}}); err == nil {
		t.Fatal("runtime accepted a Command outside the catalog")
	}
	if err := validateCommandManifestCatalog(tasks.catalog, protocol.CommandManifest{{Command: "fixture.immediate", Description: "Immediate", Scheduling: protocol.CommandSchedulingQueued}}); err == nil {
		t.Fatal("runtime accepted mismatched scheduling")
	}
	manifest := fixtureTaskManifest(t)
	if err := validateCommandManifestCatalog(tasks.catalog, append(manifest, manifest[0])); err == nil {
		t.Fatal("runtime accepted a duplicate Command Manifest entry")
	}
	if count, err := NewTaskActionsWithCatalog(nil, nil).ReconcileImmediateTimeouts(ctx); err != nil || count != 0 {
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
	if jsonEqual([]byte(`{"a":1} {"b":2}`), []byte(`{"a":1}`)) {
		t.Fatal("jsonEqual ignored trailing JSON")
	}
	if jsonEqual([]byte(`{"value":9007199254740992}`), []byte(`{"value":9007199254740993}`)) {
		t.Fatal("jsonEqual collapsed distinct large integers")
	}
	if !jsonEqual([]byte(`{"value":1}`), []byte(`{"value":1.0}`)) {
		t.Fatal("jsonEqual rejected equivalent numeric forms")
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
	encoded, err := encodeTaskOutput(protocol.CommandDefinition{OutputSchema: "atlas.tasking.FixtureOutput"}, &TaskOutput{Value: map[string]any{"result": "done"}})
	if err != nil {
		t.Fatalf("encode valid output: %v", err)
	}
	var output map[string]any
	if err := json.Unmarshal(encoded, &output); err != nil || output["result"] != "done" {
		t.Fatalf("encoded output = %#v, %v", output, err)
	}
	drainTasks := []*models.Task{{RuntimeID: "runtime-running"}, {RuntimeID: "runtime-stopped"}}
	if runtimeIDs := taskRuntimeIDs(drainTasks); len(runtimeIDs) != 2 || runtimeIDs[0] != "runtime-running" || runtimeIDs[1] != "runtime-stopped" {
		t.Fatalf("taskRuntimeIDs = %#v", runtimeIDs)
	}
	restarted := protocol.TaskFailure{Code: protocol.TaskFailureCodeAssetRestarted, Message: "restarted"}
	stoppedRuntimeIDs := map[string]struct{}{"runtime-stopped": {}}
	if got := runtimeDrainFailure(drainTasks[0], restarted, stoppedRuntimeIDs); got != restarted {
		t.Fatalf("running runtime drain failure = %#v", got)
	}
	if got := runtimeDrainFailure(drainTasks[1], restarted, stoppedRuntimeIDs); got != assetStoppedFailure {
		t.Fatalf("stopped runtime drain failure = %#v", got)
	}
}

func taskStateFixture(status protocol.TaskStatus) *models.Task {
	return &models.Task{
		TaskID:    "task-1",
		AssetID:   "asset-1",
		Command:   "fixture.queued",
		Status:    string(status),
		CreatedAt: taskStateTestTime.Add(-time.Second),
	}
}
