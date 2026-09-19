package actions

import (
	"errors"
	"testing"

	protocol "github.com/the-drunken-coder/atlas/packages/protocol/generated/go/atlasprotocol"
)

func TestProtocolValidationAdapters(t *testing.T) {
	for _, tc := range []struct {
		name     string
		validate func(map[string]interface{}) error
		valid    map[string]interface{}
		invalid  map[string]interface{}
		detail   string
	}{
		{
			name: "entity components", validate: ValidateEntityComponents,
			valid: map[string]interface{}{
				"status":       map[string]interface{}{"value": "idle"},
				"custom_notes": "some notes",
			},
			invalid: map[string]interface{}{"status": map[string]interface{}{"value": ""}},
			detail:  "status.value",
		},
		{
			name: "entity blob", validate: ValidateEntityBlob,
			valid:   map[string]interface{}{"published_at": "2026-06-10T00:00:00Z", "callsign": "atlas-one"},
			invalid: map[string]interface{}{"published_at": "2026-13-10T00:00:00Z"},
			detail:  "published_at",
		},
		{
			name: "object blob", validate: ValidateObjectBlob,
			valid:   map[string]interface{}{"size_bytes": int64(2048), "usage_hints": []interface{}{"camera_feed"}},
			invalid: map[string]interface{}{"usage_hints": []interface{}{"thumbnail", 123}},
			detail:  "usage_hints.1",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := tc.validate(tc.valid); err != nil {
				t.Fatalf("valid input rejected: %v", err)
			}
			err := tc.validate(tc.invalid)
			var validationErr *ValidationError
			if !errors.As(err, &validationErr) || validationErr.Code != protocol.ErrorCodeValidationError {
				t.Fatalf("invalid input error = %#v, want ValidationError", err)
			}
			assertValidationDetailsContain(t, err, tc.detail)
		})
	}
}

func TestEntityValidationAcceptsAbsentComponents(t *testing.T) {
	for _, components := range []map[string]interface{}{nil, {}} {
		if err := ValidateEntityComponents(components); err != nil {
			t.Fatalf("components %#v rejected: %v", components, err)
		}
	}
}
