package taskactions

import (
	"testing"

	"github.com/the-drunken-coder/atlas/atlas_core/internal/actions"
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
				if validationErr, ok := err.(*actions.ValidationError); !ok || validationErr.Code != "VALIDATION_ERROR" {
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
				if validationErr, ok := err.(*actions.ValidationError); !ok || validationErr.Code != "VALIDATION_ERROR" {
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
				if validationErr, ok := err.(*actions.ValidationError); !ok || validationErr.Code != "VALIDATION_ERROR" {
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
				if validationErr, ok := err.(*actions.ValidationError); !ok || validationErr.Code != "VALIDATION_ERROR" {
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
