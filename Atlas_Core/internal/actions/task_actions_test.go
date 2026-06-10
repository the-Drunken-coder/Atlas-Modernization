package actions

import (
	"reflect"
	"sort"
	"testing"
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
