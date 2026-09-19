package actions

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	protocol "github.com/the-drunken-coder/atlas/packages/protocol/generated/go/atlasprotocol"
)

// flightTestManifest advertises the four production flight Commands the way the
// ArduPilot host does: only go-to supports ordinary in-progress cancellation,
// and every entry uses the immediate scheduling the catalog requires.
func flightTestManifest() protocol.CommandManifest {
	return protocol.CommandManifest{
		{Command: "flight.goto", Description: "Fly to a destination and hold.", Scheduling: protocol.CommandSchedulingImmediate, SupportsCancel: true, SupportsProgress: false},
		{Command: "flight.land", Description: "Land and disarm.", Scheduling: protocol.CommandSchedulingImmediate, SupportsCancel: false, SupportsProgress: false},
		{Command: "flight.return_to_launch", Description: "Return, land, and disarm.", Scheduling: protocol.CommandSchedulingImmediate, SupportsCancel: false, SupportsProgress: false},
		{Command: "flight.takeoff", Description: "Climb and hold.", Scheduling: protocol.CommandSchedulingImmediate, SupportsCancel: false, SupportsProgress: false},
	}
}

func setupFlightAsset(t *testing.T, ctx context.Context, assetID string) *TaskActions {
	t.Helper()
	pool := openActionsTestPool(t)
	t.Cleanup(func() { cleanupFinalBlobValidationRowsWithTimeout(t, pool, assetID, "") })
	entities := NewEntityActions(pool)
	if _, err := entities.Create(ctx, CreateEntityParams{EntityID: assetID, EntityType: "asset"}); err != nil {
		t.Fatalf("create Asset: %v", err)
	}
	tasks := NewTaskActions(pool)
	if err := tasks.BeginRuntimeRegistration(ctx, assetID, "runtime-flight-1"); err != nil {
		t.Fatalf("begin runtime: %v", err)
	}
	if err := tasks.CompleteRuntimeRegistration(ctx, assetID, "runtime-flight-1", flightTestManifest()); err != nil {
		t.Fatalf("ready runtime: %v", err)
	}
	return tasks
}

func flightTestContext(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	t.Cleanup(cancel)
	return ctx
}

func flightGotoInput() map[string]any {
	return map[string]any{"latitude": 37.7749, "longitude": -122.4194, "altitude_m": 590.0}
}

func flightTakeoffInput() map[string]any {
	return map[string]any{"altitude_m": 585.5}
}

func flightEmptyInput() map[string]any {
	return map[string]any{}
}

func flightTaskCancellation(t *testing.T, tasks *TaskActions, ctx context.Context, taskID string) (string, protocol.TaskCancellation) {
	t.Helper()
	task, err := tasks.Get(ctx, taskID)
	if err != nil {
		t.Fatalf("read Task %s: %v", taskID, err)
	}
	var cancellation protocol.TaskCancellation
	if len(task.Cancellation) > 0 {
		if err := json.Unmarshal(task.Cancellation, &cancellation); err != nil {
			t.Fatalf("decode cancellation for Task %s: %v", taskID, err)
		}
	}
	return task.Status, cancellation
}

func TestFlightGotoSupersedesActiveGoto(t *testing.T) {
	ctx := flightTestContext(t)
	assetID := fmt.Sprintf("flight-goto-%d", time.Now().UnixNano())
	tasks := setupFlightAsset(t, ctx, assetID)

	first, _, err := tasks.Create(ctx, CreateTaskParams{AssetID: assetID, Command: "flight.goto", Input: flightGotoInput()}, "goto-first")
	if err != nil {
		t.Fatalf("create first go-to: %v", err)
	}
	if _, err := tasks.Start(ctx, first.TaskID, "runtime-flight-1"); err != nil {
		t.Fatalf("start first go-to: %v", err)
	}
	second, created, err := tasks.Create(ctx, CreateTaskParams{AssetID: assetID, Command: "flight.goto", Input: flightGotoInput()}, "goto-second")
	if err != nil || !created {
		t.Fatalf("create second go-to = %t, %v", created, err)
	}
	if status, cancellation := flightTaskCancellation(t, tasks, ctx, first.TaskID); status != string(protocol.TaskStatusCancelled) {
		t.Fatalf("first go-to status = %q, want cancelled", status)
	} else if cancellation.Code != protocol.TaskCancellationCodeSuperseded {
		t.Fatalf("first go-to cancellation code = %q, want superseded", cancellation.Code)
	} else if !strings.Contains(cancellation.Message, second.TaskID) {
		t.Fatalf("first go-to cancellation message %q does not reference %s", cancellation.Message, second.TaskID)
	}
	if status, _ := flightTaskCancellation(t, tasks, ctx, second.TaskID); status != string(protocol.TaskStatusPending) {
		t.Fatalf("second go-to status = %q, want pending", status)
	}
	// Repeated delivery of the same attempt must not supersede again.
	repeated, created, err := tasks.Create(ctx, CreateTaskParams{AssetID: assetID, Command: "flight.goto", Input: flightGotoInput()}, "goto-second")
	if err != nil || created || repeated.TaskID != second.TaskID {
		t.Fatalf("idempotent create = %v, %t, %v", repeated.TaskID, created, err)
	}
	if status, _ := flightTaskCancellation(t, tasks, ctx, second.TaskID); status != string(protocol.TaskStatusPending) {
		t.Fatalf("second go-to status after retry = %q, want pending", status)
	}
}

func TestFlightRecoverySupersedesTakeoffAndGoto(t *testing.T) {
	ctx := flightTestContext(t)
	assetID := fmt.Sprintf("flight-recovery-%d", time.Now().UnixNano())
	tasks := setupFlightAsset(t, ctx, assetID)

	takeoff, _, err := tasks.Create(ctx, CreateTaskParams{AssetID: assetID, Command: "flight.takeoff", Input: flightTakeoffInput()}, "takeoff-active")
	if err != nil {
		t.Fatalf("create takeoff: %v", err)
	}
	// Takeoff advertises no in-progress cancellation, yet recovery must still
	// replace it: supersession is Core policy, not operator cancellation.
	if _, err := tasks.Start(ctx, takeoff.TaskID, "runtime-flight-1"); err != nil {
		t.Fatalf("start takeoff: %v", err)
	}
	rtl, _, err := tasks.Create(ctx, CreateTaskParams{AssetID: assetID, Command: "flight.return_to_launch", Input: flightEmptyInput()}, "rtl-recovery")
	if err != nil {
		t.Fatalf("create RTL: %v", err)
	}
	if status, cancellation := flightTaskCancellation(t, tasks, ctx, takeoff.TaskID); status != string(protocol.TaskStatusCancelled) {
		t.Fatalf("takeoff status = %q, want cancelled", status)
	} else if cancellation.Code != protocol.TaskCancellationCodeSuperseded {
		t.Fatalf("takeoff cancellation code = %q, want superseded", cancellation.Code)
	}

	gotoTask, _, err := tasks.Create(ctx, CreateTaskParams{AssetID: assetID, Command: "flight.goto", Input: flightGotoInput()}, "goto-active")
	if err != nil {
		t.Fatalf("create go-to: %v", err)
	}
	// Immediate Tasks start in creation order, so start the pending recovery
	// Task before starting the newer go-to.
	if _, err := tasks.Start(ctx, rtl.TaskID, "runtime-flight-1"); err != nil {
		t.Fatalf("start RTL: %v", err)
	}
	if _, err := tasks.Start(ctx, gotoTask.TaskID, "runtime-flight-1"); err != nil {
		t.Fatalf("start go-to: %v", err)
	}
	land, _, err := tasks.Create(ctx, CreateTaskParams{AssetID: assetID, Command: "flight.land", Input: flightEmptyInput()}, "land-recovery")
	if err != nil {
		t.Fatalf("create land: %v", err)
	}
	if status, cancellation := flightTaskCancellation(t, tasks, ctx, gotoTask.TaskID); status != string(protocol.TaskStatusCancelled) {
		t.Fatalf("go-to status = %q, want cancelled", status)
	} else if cancellation.Code != protocol.TaskCancellationCodeSuperseded {
		t.Fatalf("go-to cancellation code = %q, want superseded", cancellation.Code)
	}
	// The recovery commands themselves stay actionable; land replaces only the
	// go-to, leaving the already-running RTL untouched.
	if status, _ := flightTaskCancellation(t, tasks, ctx, rtl.TaskID); status != string(protocol.TaskStatusInProgress) {
		t.Fatalf("RTL status = %q, want in_progress", status)
	}
	if status, _ := flightTaskCancellation(t, tasks, ctx, land.TaskID); status != string(protocol.TaskStatusPending) {
		t.Fatalf("land status = %q, want pending", status)
	}
}

func TestFlightTakeoffDoesNotSupersedeGoto(t *testing.T) {
	ctx := flightTestContext(t)
	assetID := fmt.Sprintf("flight-nosup-%d", time.Now().UnixNano())
	tasks := setupFlightAsset(t, ctx, assetID)

	gotoTask, _, err := tasks.Create(ctx, CreateTaskParams{AssetID: assetID, Command: "flight.goto", Input: flightGotoInput()}, "goto-kept")
	if err != nil {
		t.Fatalf("create go-to: %v", err)
	}
	if _, err := tasks.Start(ctx, gotoTask.TaskID, "runtime-flight-1"); err != nil {
		t.Fatalf("start go-to: %v", err)
	}
	takeoff, _, err := tasks.Create(ctx, CreateTaskParams{AssetID: assetID, Command: "flight.takeoff", Input: flightTakeoffInput()}, "takeoff-new")
	if err != nil {
		t.Fatalf("create takeoff: %v", err)
	}
	if status, _ := flightTaskCancellation(t, tasks, ctx, gotoTask.TaskID); status != string(protocol.TaskStatusInProgress) {
		t.Fatalf("go-to status = %q, want in_progress", status)
	}
	if status, _ := flightTaskCancellation(t, tasks, ctx, takeoff.TaskID); status != string(protocol.TaskStatusPending) {
		t.Fatalf("takeoff status = %q, want pending", status)
	}
}

func TestFlightCommandInputValidation(t *testing.T) {
	ctx := flightTestContext(t)
	assetID := fmt.Sprintf("flight-input-%d", time.Now().UnixNano())
	tasks := setupFlightAsset(t, ctx, assetID)

	cases := []struct {
		name        string
		command     string
		input       map[string]any
		idempotency string
	}{
		{"takeoff requires altitude", "flight.takeoff", flightEmptyInput(), "invalid-1"},
		{"goto requires destination", "flight.goto", map[string]any{"latitude": 1.0}, "invalid-2"},
		{"goto rejects out-of-range latitude", "flight.goto", map[string]any{"latitude": 91.0, "longitude": 0.0, "altitude_m": 590.0}, "invalid-3"},
		{"land takes no input", "flight.land", map[string]any{"latitude": 1.0}, "invalid-4"},
	}
	for _, testCase := range cases {
		if _, _, err := tasks.Create(ctx, CreateTaskParams{AssetID: assetID, Command: testCase.command, Input: testCase.input}, testCase.idempotency); err == nil {
			t.Fatalf("%s: invalid input accepted", testCase.name)
		}
	}
	if _, _, err := tasks.Create(ctx, CreateTaskParams{AssetID: assetID, Command: "flight.takeoff", Input: flightTakeoffInput()}, "valid-takeoff"); err != nil {
		t.Fatalf("valid takeoff rejected: %v", err)
	}
}
