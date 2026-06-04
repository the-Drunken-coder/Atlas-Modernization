package actions

import "testing"

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
