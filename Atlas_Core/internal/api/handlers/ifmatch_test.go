package handlers

import "testing"

func TestParseIfMatchExpectedVersion(t *testing.T) {
	tests := []struct {
		name    string
		header  string
		want    *int64
		wantErr bool
	}{
		{name: "empty", header: ""},
		{name: "wildcard", header: "*"},
		{name: "strong token", header: `"v42"`, want: int64Ptr(42)},
		{name: "same version repeated", header: `"v42", "v42"`, want: int64Ptr(42)},
		{name: "weak token rejected", header: `W/"v42"`, wantErr: true},
		{name: "unquoted token rejected", header: `v42`, wantErr: true},
		{name: "zero version rejected", header: `"v0"`, wantErr: true},
		{name: "negative version rejected", header: `"v-1"`, wantErr: true},
		{name: "malformed version rejected", header: `"vnope"`, wantErr: true},
		{name: "different versions rejected", header: `"v42", "v43"`, wantErr: true},
		{name: "mixed wildcard rejected", header: `*, "v42"`, wantErr: true},
		{name: "empty list element rejected", header: `"v42",`, wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := ParseIfMatchExpectedVersion(tt.header)
			if tt.wantErr {
				if err == nil {
					t.Fatal("expected error")
				}
				return
			}
			if err != nil {
				t.Fatalf("ParseIfMatchExpectedVersion() error = %v", err)
			}
			if tt.want == nil {
				if got != nil {
					t.Fatalf("got %d, want nil", *got)
				}
				return
			}
			if got == nil || *got != *tt.want {
				t.Fatalf("got %v, want %d", got, *tt.want)
			}
		})
	}
}

func int64Ptr(value int64) *int64 {
	return &value
}
