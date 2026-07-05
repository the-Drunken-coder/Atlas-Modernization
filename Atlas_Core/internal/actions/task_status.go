package actions

import (
	"fmt"
	"strings"
)

func normalizeTaskStatus(raw string) (string, error) {
	status := strings.ToLower(strings.TrimSpace(raw))
	switch status {
	case "pending", "acknowledged", "completed", "failed", "cancelled":
		return status, nil
	case "":
		return "", NewValidationError("status must not be empty")
	default:
		return "", NewValidationError("invalid status")
	}
}

func normalizeInitialTaskStatus(raw string) (string, error) {
	if strings.TrimSpace(raw) == "" {
		return "pending", nil
	}
	status, err := normalizeTaskStatus(raw)
	if err != nil {
		return "", err
	}
	if status != "pending" {
		return "", NewValidationError("new tasks must start as pending")
	}
	return status, nil
}

var allowedTaskStatusTransitions = map[string]map[string]struct{}{
	"pending": {
		"acknowledged": {},
		"completed":    {},
		"failed":       {},
		"cancelled":    {},
	},
	"acknowledged": {
		"completed": {},
		"failed":    {},
		"cancelled": {},
	},
	"completed": {},
	"failed":    {},
	"cancelled": {},
}

func validateTaskStatusTransition(current, next string) error {
	if current == next {
		return nil
	}
	allowed, ok := allowedTaskStatusTransitions[current]
	if !ok {
		return NewValidationError(fmt.Sprintf("unknown current task status %q", current))
	}
	if _, ok := allowed[next]; ok {
		return nil
	}
	return NewValidationError(fmt.Sprintf("invalid task status transition from %q to %q", current, next))
}
