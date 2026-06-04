package actions

import "testing"

func TestNormalizeOptionalObjectString(t *testing.T) {
	tests := []struct {
		name  string
		value *string
		want  *string
	}{
		{name: "nil remains nil"},
		{name: "empty becomes nil", value: ptrString("")},
		{name: "whitespace becomes nil", value: ptrString(" \t\n ")},
		{name: "trimmed value", value: ptrString("  photo  "), want: ptrString("photo")},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := normalizeOptionalObjectString(tt.value)
			if tt.want == nil {
				if got != nil {
					t.Fatalf("normalizeOptionalObjectString() = %q, want nil", *got)
				}
				return
			}
			if got == nil || *got != *tt.want {
				t.Fatalf("normalizeOptionalObjectString() = %v, want %q", got, *tt.want)
			}
		})
	}
}

func ptrString(value string) *string {
	return &value
}
