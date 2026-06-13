package actions_test

import (
	"testing"

	"github.com/the-drunken-coder/atlas/atlas_core/internal/actions"
	protocol "github.com/the-drunken-coder/atlas/atlas_protocol/generated/go/atlasprotocol"
)

func TestNewValidationError(t *testing.T) {
	err := actions.NewValidationError("test validation error")
	if err.Message != "test validation error" {
		t.Errorf("Expected message 'test validation error', got '%s'", err.Message)
	}
	if err.Code != protocol.ErrorCodeValidationError {
		t.Errorf("Expected code %q, got %q", protocol.ErrorCodeValidationError, err.Code)
	}
	if err.Error() != "test validation error" {
		t.Errorf("Expected Error() to return message, got '%s'", err.Error())
	}
}

func TestNewNotFoundErrors(t *testing.T) {
	cases := []struct {
		name        string
		makeErr     func() *actions.NotFoundError
		wantMessage string
		wantType    actions.ChangeResource
		wantID      string
		wantCode    protocol.ErrorCode
	}{
		{
			name: "entity",
			makeErr: func() *actions.NotFoundError {
				return actions.NewEntityNotFoundError("entity-123")
			},
			wantMessage: "Entity 'entity-123' was not found",
			wantType:    actions.ChangeResourceEntity,
			wantID:      "entity-123",
			wantCode:    protocol.ErrorCodeEntityNotFound,
		},
		{
			name: "task",
			makeErr: func() *actions.NotFoundError {
				return actions.NewTaskNotFoundError("task-456")
			},
			wantMessage: "Task 'task-456' was not found",
			wantType:    actions.ChangeResourceTask,
			wantID:      "task-456",
			wantCode:    protocol.ErrorCodeTaskNotFound,
		},
		{
			name: "object",
			makeErr: func() *actions.NotFoundError {
				return actions.NewObjectNotFoundError("object-789")
			},
			wantMessage: "Object 'object-789' was not found",
			wantType:    actions.ChangeResourceObject,
			wantID:      "object-789",
			wantCode:    protocol.ErrorCodeObjectNotFound,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.makeErr()
			if err.Message != tc.wantMessage {
				t.Errorf("Expected message %q, got %q", tc.wantMessage, err.Message)
			}
			if err.ResourceType != tc.wantType {
				t.Errorf("Expected ResourceType %q, got %q", tc.wantType, err.ResourceType)
			}
			if err.ResourceID != tc.wantID {
				t.Errorf("Expected ResourceID %q, got %q", tc.wantID, err.ResourceID)
			}
			if err.Code != tc.wantCode {
				t.Errorf("Expected code %q, got %q", tc.wantCode, err.Code)
			}
		})
	}
}
