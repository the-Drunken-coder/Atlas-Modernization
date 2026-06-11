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
		{name: "minimum version", header: `"v1"`, want: int64Ptr(1)},
		{name: "strong token", header: `"v42"`, want: int64Ptr(42)},
		{name: "large version", header: `"v9223372036854775807"`, want: int64Ptr(9223372036854775807)},
		{name: "version overflow rejected", header: `"v9223372036854775808"`, wantErr: true},
		{name: "leading zero version rejected", header: `"v01"`, wantErr: true},
		{name: "multiple leading zero version rejected", header: `"v001"`, wantErr: true},
		{name: "signed positive version rejected", header: `"v+1"`, wantErr: true},
		{name: "signed leading zero version rejected", header: `"v+01"`, wantErr: true},
		{name: "token with surrounding whitespace", header: `  "v42"  `, want: int64Ptr(42)},
		{name: "same version repeated", header: `"v42", "v42"`, want: int64Ptr(42)},
		{name: "same version repeated with extra spaces", header: ` "v42" ,   "v42" `, want: int64Ptr(42)},
		{name: "weak token rejected", header: `W/"v42"`, wantErr: true},
		{name: "uppercase version prefix rejected", header: `"V42"`, wantErr: true},
		{name: "unquoted token rejected", header: `v42`, wantErr: true},
		{name: "zero version rejected", header: `"v0"`, wantErr: true},
		{name: "negative version rejected", header: `"v-1"`, wantErr: true},
		{name: "malformed version rejected", header: `"vnope"`, wantErr: true},
		{name: "different versions rejected", header: `"v42", "v43"`, wantErr: true},
		{name: "mixed wildcard rejected", header: `*, "v42"`, wantErr: true},
		{name: "leading empty list element rejected", header: `,"v1"`, wantErr: true},
		{name: "empty list element rejected", header: `"v42",`, wantErr: true},
		{name: "middle empty list element rejected", header: `"v1",,"v1"`, wantErr: true},
		{name: "commas only rejected", header: `, ,`, wantErr: true},
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

func TestParseIfMatchExpectedVersionValues(t *testing.T) {
	tests := []struct {
		name    string
		values  []string
		want    *int64
		wantErr bool
	}{
		{name: "absent", values: nil},
		{name: "empty slice", values: []string{}},
		{name: "empty line", values: []string{""}},
		{name: "single wildcard success", values: []string{"*"}},
		{name: "same version across header lines", values: []string{`"v42"`, `"v42"`}, want: int64Ptr(42)},
		{name: "same version in comma lists across header lines", values: []string{`"v42", "v42"`, `"v42"`}, want: int64Ptr(42)},
		{name: "double wildcard rejected", values: []string{"*", "*"}, wantErr: true},
		{name: "leading empty line before tag rejected", values: []string{"", `"v42"`}, wantErr: true},
		{name: "trailing empty line after tag rejected", values: []string{`"v42"`, ""}, wantErr: true},
		{name: "multiple empty lines rejected", values: []string{"", ""}, wantErr: true},
		{name: "conflicting versions across header lines", values: []string{`"v42"`, `"v43"`}, wantErr: true},
		{name: "conflicting comma lists across header lines", values: []string{`"v42", "v42"`, `"v43"`}, wantErr: true},
		{name: "malformed later header rejected", values: []string{`"v42"`, `"vnope"`}, wantErr: true},
		{name: "uppercase later header rejected", values: []string{`"v42"`, `"V42"`}, wantErr: true},
		{name: "weak token in later header rejected", values: []string{`"v42"`, `W/"v42"`}, wantErr: true},
		{name: "wildcard mixed with tag across header lines rejected", values: []string{`*`, `"v42"`}, wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := parseIfMatchExpectedVersionValues(tt.values)
			if tt.wantErr {
				if err == nil {
					t.Fatal("expected error")
				}
				return
			}
			if err != nil {
				t.Fatalf("parseIfMatchExpectedVersionValues() error = %v", err)
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
