package actions

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func TestEntityCheckinValidatesTaskPageBeforeEntityUpdate(t *testing.T) {
	expectedVersion := int64(1)
	tests := []struct {
		name   string
		params EntityCheckinParams
		want   string
	}{
		{
			name: "malformed cursor",
			params: EntityCheckinParams{
				EntityID:        "entity-1",
				ExpectedVersion: &expectedVersion,
				TaskLimit:       10,
				TaskCursor:      "not-base64",
			},
			want: "task_cursor",
		},
		{
			name: "invalid limit",
			params: EntityCheckinParams{
				EntityID:        "entity-1",
				ExpectedVersion: &expectedVersion,
				TaskLimit:       21,
			},
			want: "limit must be between 1 and 20",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			actions := NewEntityCheckinActions(NewEntityActions(nil), NewTaskActions(nil))

			_, err := actions.CheckIn(context.Background(), tt.params)

			var validationErr *ValidationError
			if !errors.As(err, &validationErr) {
				t.Fatalf("CheckIn error = %v, want ValidationError", err)
			}
			validationText := validationErr.Message + " " + strings.Join(validationErr.Details, " ")
			if !strings.Contains(validationText, tt.want) {
				t.Fatalf("CheckIn validation = %q, want substring %q", validationText, tt.want)
			}
		})
	}
}
