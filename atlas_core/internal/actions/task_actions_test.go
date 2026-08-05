package actions

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/models"
	protocol "github.com/the-drunken-coder/atlas/atlas_protocol/generated/go/atlasprotocol"
)

func TestNormalizeTaskStatus(t *testing.T) {
	tests := []struct {
		name    string
		in      string
		want    string
		wantErr bool
	}{
		{name: "pending", in: "pending", want: "pending"},
		{name: "trim and lowercase", in: " ACKNOWLEDGED ", want: "acknowledged"},
		{name: "completed", in: "completed", want: "completed"},
		{name: "failed", in: "failed", want: "failed"},
		{name: "cancelled", in: "cancelled", want: "cancelled"},
		{name: "empty rejected", in: " \t ", wantErr: true},
		{name: "unknown rejected", in: "running", wantErr: true},
		{name: "american spelling rejected", in: "canceled", wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := normalizeTaskStatus(tt.in)
			if tt.wantErr {
				if err == nil {
					t.Fatal("expected validation error")
				}
				if validationErr, ok := err.(*ValidationError); !ok || validationErr.Code != "VALIDATION_ERROR" {
					t.Fatalf("expected validation error, got %T %v", err, err)
				}
				return
			}
			if err != nil {
				t.Fatalf("normalizeTaskStatus: %v", err)
			}
			if got != tt.want {
				t.Fatalf("normalizeTaskStatus(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}

func TestNormalizeInitialTaskStatus(t *testing.T) {
	tests := []struct {
		name    string
		in      string
		want    string
		wantErr bool
	}{
		{name: "empty defaults pending", in: "", want: "pending"},
		{name: "whitespace defaults pending", in: " \t ", want: "pending"},
		{name: "pending accepted", in: " PENDING ", want: "pending"},
		{name: "acknowledged rejected", in: "acknowledged", wantErr: true},
		{name: "completed rejected", in: "completed", wantErr: true},
		{name: "unknown rejected", in: "running", wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := normalizeInitialTaskStatus(tt.in)
			if tt.wantErr {
				if err == nil {
					t.Fatal("expected validation error")
				}
				if validationErr, ok := err.(*ValidationError); !ok || validationErr.Code != "VALIDATION_ERROR" {
					t.Fatalf("expected validation error, got %T %v", err, err)
				}
				return
			}
			if err != nil {
				t.Fatalf("normalizeInitialTaskStatus: %v", err)
			}
			if got != tt.want {
				t.Fatalf("normalizeInitialTaskStatus(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}

func TestTaskDeleteRecordsDurableRoutingContext(t *testing.T) {
	pool := openActionsTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	entityActions := NewEntityActions(pool)
	taskActions := NewTaskActions(pool)
	suffix := time.Now().UTC().UnixNano()
	entityID := fmt.Sprintf("task-delete-entity-%d", suffix)
	taskWithEntityID := fmt.Sprintf("task-delete-linked-%d", suffix)
	taskWithoutEntityID := fmt.Sprintf("task-delete-unlinked-%d", suffix)
	defer cleanupFinalBlobValidationRowsWithTimeout(t, pool, entityID, taskWithEntityID)
	defer cleanupFinalBlobValidationRowsWithTimeout(t, pool, "", taskWithoutEntityID)

	if _, err := entityActions.Create(ctx, CreateEntityParams{
		EntityID:   entityID,
		EntityType: "asset",
	}); err != nil {
		t.Fatalf("create entity fixture: %v", err)
	}
	if _, err := taskActions.Create(ctx, CreateTaskParams{
		TaskID:   taskWithEntityID,
		Status:   "pending",
		EntityID: &entityID,
	}); err != nil {
		t.Fatalf("create linked task fixture: %v", err)
	}
	if _, err := taskActions.Create(ctx, CreateTaskParams{
		TaskID: taskWithoutEntityID,
		Status: "pending",
	}); err != nil {
		t.Fatalf("create unlinked task fixture: %v", err)
	}

	if err := taskActions.Delete(ctx, taskWithEntityID); err != nil {
		t.Fatalf("delete linked task: %v", err)
	}
	assertTaskDeleteEvent(ctx, t, pool, taskWithEntityID, &entityID)

	if err := taskActions.Delete(ctx, taskWithoutEntityID); err != nil {
		t.Fatalf("delete unlinked task: %v", err)
	}
	assertTaskDeleteEvent(ctx, t, pool, taskWithoutEntityID, nil)

	err := taskActions.Delete(ctx, fmt.Sprintf("missing-task-%d", suffix))
	var notFound *NotFoundError
	if !errors.As(err, &notFound) {
		t.Fatalf("delete missing task error = %T %v, want NotFoundError", err, err)
	}
}

func TestStatusOnlyTaskUpdateIsIdempotent(t *testing.T) {
	pool := openActionsTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	taskID := fmt.Sprintf("task-ack-idempotent-%d", time.Now().UTC().UnixNano())
	defer cleanupFinalBlobValidationRowsWithTimeout(t, pool, "", taskID)

	taskActions := NewTaskActions(pool)
	created, err := taskActions.Create(ctx, CreateTaskParams{TaskID: taskID})
	if err != nil {
		t.Fatalf("create task: %v", err)
	}

	status := "acknowledged"
	acknowledged, err := taskActions.Update(ctx, taskID, UpdateTaskParams{Status: &status, ExpectedVersion: &created.Version})
	if err != nil {
		t.Fatalf("acknowledge pending task: %v", err)
	}
	if acknowledged.Status != "acknowledged" || acknowledged.Version <= created.Version {
		t.Fatalf("acknowledged task = %#v, want acknowledged with version after %d", acknowledged, created.Version)
	}
	change := readChangeEvent(ctx, t, pool, acknowledged.Version)
	if change.Event != ChangeEventUpdate || change.ID != taskID || change.Version != acknowledged.Version {
		t.Fatalf("acknowledgement event = %#v, want task update at version %d", change, acknowledged.Version)
	}
	beforeIdempotentVersion, err := CurrentChangeVersion(ctx, pool)
	if err != nil {
		t.Fatalf("read version before idempotent acknowledgements: %v", err)
	}

	repeated, err := taskActions.Update(ctx, taskID, UpdateTaskParams{Status: &status})
	if err != nil {
		t.Fatalf("repeat acknowledgement: %v", err)
	}
	assertSameTaskVersionAndTimestamp(t, repeated, acknowledged)

	repeated, err = taskActions.Update(ctx, taskID, UpdateTaskParams{Status: &status, ExpectedVersion: &acknowledged.Version})
	if err != nil {
		t.Fatalf("repeat acknowledgement with current version: %v", err)
	}
	assertSameTaskVersionAndTimestamp(t, repeated, acknowledged)

	_, err = taskActions.Update(ctx, taskID, UpdateTaskParams{Status: &status, ExpectedVersion: &created.Version})
	var preconditionErr *PreconditionFailedError
	if !errors.As(err, &preconditionErr) {
		t.Fatalf("repeat acknowledgement with stale version error = %T %v, want PreconditionFailedError", err, err)
	}
	afterIdempotentVersion, err := CurrentChangeVersion(ctx, pool)
	if err != nil {
		t.Fatalf("read version after idempotent acknowledgements: %v", err)
	}
	if afterIdempotentVersion != beforeIdempotentVersion {
		t.Fatalf("idempotent acknowledgements advanced change version from %d to %d", beforeIdempotentVersion, afterIdempotentVersion)
	}

}

func assertSameTaskVersionAndTimestamp(t *testing.T, got, want *models.Task) {
	t.Helper()
	if got.Version != want.Version || !got.UpdatedAt.Equal(want.UpdatedAt) {
		t.Fatalf("task version/updated_at = %d/%s, want %d/%s", got.Version, got.UpdatedAt, want.Version, want.UpdatedAt)
	}
}

func assertTaskDeleteEvent(ctx context.Context, t *testing.T, pool *pgxpool.Pool, taskID string, wantEntityID *string) {
	t.Helper()
	var payload []byte
	var beforeEntityID *string
	if err := pool.QueryRow(ctx, `
		SELECT event, before_task_entity_id
		FROM atlas_change_events
		WHERE event->>'resource_type' = 'task' AND event->>'event' = 'delete' AND event->>'id' = $1
		ORDER BY version DESC LIMIT 1
	`, taskID).Scan(&payload, &beforeEntityID); err != nil {
		t.Fatalf("query task delete event %q: %v", taskID, err)
	}
	var event protocol.FeedEvent
	if err := json.Unmarshal(payload, &event); err != nil {
		t.Fatalf("decode task delete event %q: %v", taskID, err)
	}
	if event.ResourceType != ChangeResourceTask || event.Event != ChangeEventDelete || event.ID != taskID {
		t.Fatalf("delete event identity = %#v, want task/%s", event, taskID)
	}
	if !reflect.DeepEqual(event.EntityID, wantEntityID) || !reflect.DeepEqual(beforeEntityID, wantEntityID) {
		t.Fatalf("task delete routing = event:%#v stored:%#v, want %#v", event.EntityID, beforeEntityID, wantEntityID)
	}
	if event.Version <= 0 {
		t.Fatalf("task delete version = %d, want positive", event.Version)
	}
	currentVersion, err := CurrentChangeVersion(ctx, pool)
	if err != nil {
		t.Fatalf("CurrentChangeVersion: %v", err)
	}
	if currentVersion < event.Version {
		t.Fatalf("CurrentChangeVersion = %d, want at least delete version %d", currentVersion, event.Version)
	}
}

func readChangeEvent(ctx context.Context, t *testing.T, pool *pgxpool.Pool, version int64) protocol.FeedEvent {
	t.Helper()
	var payload []byte
	if err := pool.QueryRow(ctx, `SELECT event FROM atlas_change_events WHERE version = $1`, version).Scan(&payload); err != nil {
		t.Fatalf("read change event %d: %v", version, err)
	}
	var event protocol.FeedEvent
	if err := json.Unmarshal(payload, &event); err != nil {
		t.Fatalf("decode change event %d: %v", version, err)
	}
	return event
}

func TestMergeTaskComponentsRevalidatesMergedShape(t *testing.T) {
	incoming := map[string]interface{}{
		"progress": map[string]interface{}{
			"updated_at": "2026-06-10T00:00:00Z",
		},
	}
	if err := ValidateTaskComponents(incoming); err != nil {
		t.Fatalf("incoming component delta should be valid: %v", err)
	}

	existingJSON := map[string]interface{}{
		"components": map[string]interface{}{
			"progress": map[string]interface{}{
				"percent": 150.0,
			},
		},
	}
	err := mergeTaskComponents(existingJSON, incoming)
	if err == nil {
		t.Fatal("expected merged task components to be revalidated")
	}
	validationErr, ok := err.(*ValidationError)
	if !ok {
		t.Fatalf("expected validation error, got %T %v", err, err)
	}
	if len(validationErr.Details) == 0 || !strings.Contains(validationErr.Details[0], "progress.percent") {
		t.Fatalf("validation details = %v, want progress.percent range error", validationErr.Details)
	}
}

func TestMergeTaskComponentsNilIsNoOp(t *testing.T) {
	components := map[string]interface{}{
		"progress": map[string]interface{}{"percent": 50.0},
	}
	existingJSON := map[string]interface{}{"components": components}

	if err := mergeTaskComponents(existingJSON, nil); err != nil {
		t.Fatalf("mergeTaskComponents nil incoming: %v", err)
	}
	if !reflect.DeepEqual(existingJSON["components"], components) {
		t.Fatalf("components changed for nil incoming: %v", existingJSON["components"])
	}
}

func TestMergeTaskComponentsInitializesMissingOrNullStored(t *testing.T) {
	tests := []struct {
		name         string
		existingJSON map[string]interface{}
	}{
		{name: "missing stored components", existingJSON: map[string]interface{}{}},
		{name: "null stored components", existingJSON: map[string]interface{}{"components": nil}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			incoming := map[string]interface{}{
				"progress": map[string]interface{}{"percent": 25.0},
			}
			if err := mergeTaskComponents(tt.existingJSON, incoming); err != nil {
				t.Fatalf("mergeTaskComponents: %v", err)
			}
			components, ok := tt.existingJSON["components"].(map[string]interface{})
			if !ok {
				t.Fatalf("components = %T, want map[string]interface{}", tt.existingJSON["components"])
			}
			progress, ok := components["progress"].(map[string]interface{})
			if !ok {
				t.Fatalf("progress = %T, want map[string]interface{}", components["progress"])
			}
			if got := progress["percent"]; got != 25.0 {
				t.Fatalf("progress.percent = %v, want 25", got)
			}
		})
	}
}

func TestMergeTaskComponentsEmptyIncomingValidatesExisting(t *testing.T) {
	existingJSON := map[string]interface{}{
		"components": map[string]interface{}{
			"progress": map[string]interface{}{"percent": 50.0},
		},
	}
	if err := mergeTaskComponents(existingJSON, map[string]interface{}{}); err != nil {
		t.Fatalf("mergeTaskComponents empty incoming: %v", err)
	}
	components := existingJSON["components"].(map[string]interface{})
	progress := components["progress"].(map[string]interface{})
	if got := progress["percent"]; got != 50.0 {
		t.Fatalf("progress.percent = %v, want preserved 50", got)
	}
}

func TestMergeTaskComponentsSuccess(t *testing.T) {
	existingJSON := map[string]interface{}{
		"components": map[string]interface{}{
			"progress": map[string]interface{}{"percent": 50.0},
		},
	}
	incoming := map[string]interface{}{
		"progress":       map[string]interface{}{"updated_at": "2026-06-10T00:00:00Z"},
		"status_message": "survey running",
	}
	if err := mergeTaskComponents(existingJSON, incoming); err != nil {
		t.Fatalf("mergeTaskComponents valid merge: %v", err)
	}

	components := existingJSON["components"].(map[string]interface{})
	progress := components["progress"].(map[string]interface{})
	if got := progress["percent"]; got != 50.0 {
		t.Fatalf("progress.percent = %v, want preserved 50", got)
	}
	if got := progress["updated_at"]; got != "2026-06-10T00:00:00Z" {
		t.Fatalf("progress.updated_at = %v, want incoming timestamp", got)
	}
	if got := components["status_message"]; got != "survey running" {
		t.Fatalf("status_message = %v, want survey running", got)
	}
}

func TestMergeTaskComponentsRejectsNonMapStored(t *testing.T) {
	existingJSON := map[string]interface{}{"components": "corrupt"}
	incoming := map[string]interface{}{
		"progress": map[string]interface{}{"percent": 25.0},
	}
	err := mergeTaskComponents(existingJSON, incoming)
	if err == nil {
		t.Fatal("expected stored component type validation error")
	}
	validationErr, ok := err.(*ValidationError)
	if !ok {
		t.Fatalf("expected validation error, got %T %v", err, err)
	}
	if !strings.Contains(validationErr.Message, "stored task components must be an object or null") {
		t.Fatalf("validation message = %q, want stored task components type error", validationErr.Message)
	}
}

func TestValidateTaskStatusTransition(t *testing.T) {
	tests := []struct {
		name    string
		current string
		next    string
		wantErr bool
	}{
		{name: "same status", current: "pending", next: "pending"},
		{name: "pending to acknowledged", current: "pending", next: "acknowledged"},
		{name: "pending may finish immediately", current: "pending", next: "completed"},
		{name: "acknowledged to failed", current: "acknowledged", next: "failed"},
		{name: "acknowledged to cancelled", current: "acknowledged", next: "cancelled"},
		{name: "completed is terminal", current: "completed", next: "pending", wantErr: true},
		{name: "failed is terminal", current: "failed", next: "acknowledged", wantErr: true},
		{name: "cancelled is terminal", current: "cancelled", next: "acknowledged", wantErr: true},
		{name: "cannot unacknowledge", current: "acknowledged", next: "pending", wantErr: true},
		{name: "unknown current status", current: "running", next: "pending", wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validateTaskStatusTransition(tt.current, tt.next)
			if tt.wantErr {
				if err == nil {
					t.Fatal("expected validation error")
				}
				if validationErr, ok := err.(*ValidationError); !ok || validationErr.Code != "VALIDATION_ERROR" {
					t.Fatalf("expected validation error, got %T %v", err, err)
				}
				return
			}
			if err != nil {
				t.Fatalf("validateTaskStatusTransition: %v", err)
			}
		})
	}
}

func TestNormalizeCheckinTaskLimit(t *testing.T) {
	tests := []struct {
		name    string
		limit   int
		want    int
		wantErr bool
	}{
		{name: "zero defaults", limit: 0, want: 10},
		{name: "one accepted", limit: 1, want: 1},
		{name: "twenty accepted", limit: 20, want: 20},
		{name: "negative rejected", limit: -1, wantErr: true},
		{name: "above max rejected", limit: 21, wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := normalizeCheckinTaskLimit(tt.limit)
			if tt.wantErr {
				if err == nil {
					t.Fatal("expected validation error")
				}
				if validationErr, ok := err.(*ValidationError); !ok || validationErr.Code != "VALIDATION_ERROR" {
					t.Fatalf("expected validation error, got %T %v", err, err)
				}
				return
			}
			if err != nil {
				t.Fatalf("normalizeCheckinTaskLimit: %v", err)
			}
			if got != tt.want {
				t.Fatalf("normalizeCheckinTaskLimit(%d) = %d, want %d", tt.limit, got, tt.want)
			}
		})
	}
}
