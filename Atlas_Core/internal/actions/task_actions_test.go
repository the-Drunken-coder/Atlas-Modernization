package actions

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
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

func TestTaskDeleteRecordsTombstoneContext(t *testing.T) {
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
	assertTaskTombstone(ctx, t, pool, taskWithEntityID, map[string]any{"entity_id": entityID})

	if err := taskActions.Delete(ctx, taskWithoutEntityID); err != nil {
		t.Fatalf("delete unlinked task: %v", err)
	}
	assertTaskTombstone(ctx, t, pool, taskWithoutEntityID, map[string]any{})

	err := taskActions.Delete(ctx, fmt.Sprintf("missing-task-%d", suffix))
	var notFound *NotFoundError
	if !errors.As(err, &notFound) {
		t.Fatalf("delete missing task error = %T %v, want NotFoundError", err, err)
	}
}

func assertTaskTombstone(ctx context.Context, t *testing.T, pool *pgxpool.Pool, taskID string, wantContext map[string]any) {
	t.Helper()
	var resourceType, resourceID string
	var contextJSON []byte
	var tombstoneVersion int64
	if err := pool.QueryRow(ctx, `
		SELECT resource_type, resource_id, context, version
		FROM deletions
		WHERE resource_type = 'task' AND resource_id = $1
	`, taskID).Scan(&resourceType, &resourceID, &contextJSON, &tombstoneVersion); err != nil {
		t.Fatalf("query task tombstone %q: %v", taskID, err)
	}
	if resourceType != "task" || resourceID != taskID {
		t.Fatalf("tombstone identity = %s/%s, want task/%s", resourceType, resourceID, taskID)
	}
	var gotContext map[string]any
	if err := json.Unmarshal(contextJSON, &gotContext); err != nil {
		t.Fatalf("decode task tombstone context %q: %v", taskID, err)
	}
	if !reflect.DeepEqual(gotContext, wantContext) {
		t.Fatalf("task tombstone context = %#v, want %#v", gotContext, wantContext)
	}
	if tombstoneVersion <= 0 {
		t.Fatalf("task tombstone version = %d, want positive", tombstoneVersion)
	}
	currentVersion, err := CurrentChangeVersion(ctx, pool)
	if err != nil {
		t.Fatalf("CurrentChangeVersion: %v", err)
	}
	if currentVersion < tombstoneVersion {
		t.Fatalf("CurrentChangeVersion = %d, want at least tombstone version %d", currentVersion, tombstoneVersion)
	}
}

func TestNormalizeTaskProgressPercent(t *testing.T) {
	tests := []struct {
		name string
		in   float64
		want float64
	}{
		{name: "one percent", in: 1, want: 1},
		{name: "full percent", in: 100, want: 100},
		{name: "mid range", in: 65.5, want: 65.5},
		{name: "clamp low", in: -5, want: 0},
		{name: "clamp high", in: 150, want: 100},
		{name: "nan", in: math.NaN(), want: 0},
		{name: "positive infinity", in: math.Inf(1), want: 0},
		{name: "negative infinity", in: math.Inf(-1), want: 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := normalizeTaskProgressPercent(tt.in); got != tt.want {
				t.Fatalf("normalizeTaskProgressPercent(%v) = %v, want %v", tt.in, got, tt.want)
			}
		})
	}
}

func TestTaskStatusTransitionUpdateRemovesLegacyExtra(t *testing.T) {
	progress := 62.5
	message := "survey running"

	params := taskStatusTransitionUpdate("acknowledged", &progress, &message)
	if params.Status == nil || *params.Status != "acknowledged" {
		t.Fatalf("Status = %v, want acknowledged", params.Status)
	}
	gotRemoveKeys := append([]string(nil), params.RemoveExtraKeys...)
	wantRemoveKeys := append([]string(nil), legacyTaskTransitionExtraKeys...)
	sort.Strings(gotRemoveKeys)
	sort.Strings(wantRemoveKeys)
	if !reflect.DeepEqual(gotRemoveKeys, wantRemoveKeys) {
		t.Fatalf("RemoveExtraKeys (sorted) = %v, want %v", gotRemoveKeys, wantRemoveKeys)
	}
	aliasParams := taskStatusTransitionUpdate("acknowledged", &progress, &message)
	aliasParams.RemoveExtraKeys[0] = "mutated"
	if legacyTaskTransitionExtraKeys[0] == "mutated" {
		t.Fatal("RemoveExtraKeys aliases legacyTaskTransitionExtraKeys")
	}

	components := params.Components
	progressComponent, ok := components["progress"].(map[string]interface{})
	if !ok {
		t.Fatalf("progress component = %T, want map[string]interface{}", components["progress"])
	}
	if got := progressComponent["percent"]; got != 62.5 {
		t.Fatalf("progress percent = %v, want 62.5", got)
	}
	if got := components["status_message"]; got != "survey running" {
		t.Fatalf("status_message = %v, want survey running", got)
	}

	existing := map[string]interface{}{
		"components":     map[string]interface{}{},
		"status":         "pending",
		"progress":       0.5,
		"status_message": "legacy",
		"message":        "legacy message",
		"result":         map[string]interface{}{"ok": true},
	}
	removeTaskExtraKeys(existing, params.RemoveExtraKeys...)
	for _, key := range legacyTaskTransitionExtraKeys {
		if _, ok := existing[key]; ok {
			t.Fatalf("legacy extra key %q was not removed: %#v", key, existing)
		}
	}
	if _, ok := existing["components"]; !ok {
		t.Fatal("components should not be removed")
	}
	if _, ok := existing["status"]; !ok {
		t.Fatal("status should not be removed")
	}
	if _, ok := existing["result"]; !ok {
		t.Fatal("unrelated extra should not be removed")
	}

	nilParams := taskStatusTransitionUpdate("acknowledged", nil, nil)
	if nilParams.Components != nil {
		t.Fatalf("Components = %#v, want nil for nil progress/message", nilParams.Components)
	}
	gotNilRemoveKeys := append([]string(nil), nilParams.RemoveExtraKeys...)
	sort.Strings(gotNilRemoveKeys)
	if !reflect.DeepEqual(gotNilRemoveKeys, wantRemoveKeys) {
		t.Fatalf("nil RemoveExtraKeys (sorted) = %v, want %v", gotNilRemoveKeys, wantRemoveKeys)
	}
	nilExisting := map[string]interface{}{
		"components":     map[string]interface{}{},
		"status":         "pending",
		"progress":       0.5,
		"status_message": "legacy",
		"message":        "legacy message",
		"result":         map[string]interface{}{"ok": true},
	}
	removeTaskExtraKeys(nilExisting, nilParams.RemoveExtraKeys...)
	for _, key := range legacyTaskTransitionExtraKeys {
		if _, ok := nilExisting[key]; ok {
			t.Fatalf("legacy extra key %q was not removed for nil progress/message: %#v", key, nilExisting)
		}
	}
	for _, key := range []string{"components", "status", "result"} {
		if _, ok := nilExisting[key]; !ok {
			t.Fatalf("%s should not be removed for nil progress/message", key)
		}
	}
	nilAliasParams := taskStatusTransitionUpdate("acknowledged", nil, nil)
	nilAliasParams.RemoveExtraKeys[0] = "mutated"
	if legacyTaskTransitionExtraKeys[0] == "mutated" {
		t.Fatal("nil RemoveExtraKeys aliases legacyTaskTransitionExtraKeys")
	}
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
