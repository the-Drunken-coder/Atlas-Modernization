package actions

import "testing"

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
