package actions

import "testing"

func TestClampListLimit(t *testing.T) {
	tests := []struct {
		name  string
		limit int
		want  int
	}{
		{"zero becomes default", 0, DefaultListLimit},
		{"negative becomes default", -1, DefaultListLimit},
		{"valid passthrough", 50, 50},
		{"max passthrough", MaxListLimit, MaxListLimit},
		{"above max clamped", MaxListLimit + 1, MaxListLimit},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := ClampListLimit(tt.limit); got != tt.want {
				t.Fatalf("ClampListLimit(%d) = %d, want %d", tt.limit, got, tt.want)
			}
		})
	}
}

func TestClampLimitCheckinDefault(t *testing.T) {
	tests := []struct {
		name  string
		limit int
		want  int
	}{
		{"zero becomes checkin default", 0, 10},
		{"negative becomes checkin default", -5, 10},
		{"valid passthrough", 15, 15},
		{"above max clamped", 600, MaxListLimit},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := ClampLimit(tt.limit, 10, MaxListLimit); got != tt.want {
				t.Fatalf("ClampLimit(%d, 10, %d) = %d, want %d", tt.limit, MaxListLimit, got, tt.want)
			}
		})
	}
}
