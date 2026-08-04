package actions

import (
	"context"
	"fmt"
	"math"
	"strings"

	"github.com/the-drunken-coder/atlas/atlas_core/internal/models"
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

// Acknowledge marks a task as acknowledged.
func (a *TaskActions) Acknowledge(ctx context.Context, taskID string, expectedVersion *int64) (*models.Task, error) {
	status := "acknowledged"
	return a.Update(ctx, taskID, UpdateTaskParams{Status: &status, ExpectedVersion: expectedVersion, idempotentStatus: true})
}

// Complete marks a task as completed with optional result.
func (a *TaskActions) Complete(ctx context.Context, taskID string, result map[string]interface{}, expectedVersion *int64) (*models.Task, error) {
	status := "completed"
	var extra map[string]interface{}
	if result != nil {
		extra = map[string]interface{}{"result": result}
	}
	return a.Update(ctx, taskID, UpdateTaskParams{Status: &status, Extra: extra, ExpectedVersion: expectedVersion})
}

// Fail marks a task as failed with optional error details.
func (a *TaskActions) Fail(ctx context.Context, taskID string, errorDetails map[string]interface{}, expectedVersion *int64) (*models.Task, error) {
	status := "failed"
	var extra map[string]interface{}
	if errorDetails != nil {
		extra = map[string]interface{}{"error": errorDetails}
	}
	return a.Update(ctx, taskID, UpdateTaskParams{Status: &status, Extra: extra, ExpectedVersion: expectedVersion})
}

func taskStatusTransitionUpdate(status string, progress *float64, message *string) UpdateTaskParams {
	var components map[string]interface{}
	if progress != nil || message != nil {
		components = make(map[string]interface{})
		if progress != nil {
			p := normalizeTaskProgressPercent(*progress)
			components["progress"] = map[string]interface{}{"percent": p}
		}
		if message != nil {
			components["status_message"] = *message
		}
	}

	return UpdateTaskParams{
		Status:     &status,
		Components: components,
	}
}

// normalizeTaskProgressPercent clamps progress to the canonical 0–100 percent scale.
// NaN and infinite values are coerced to 0.
// Values are not auto-scaled from 0–1; e.g. 1 means 1%, not 100%.
func normalizeTaskProgressPercent(p float64) float64 {
	if math.IsNaN(p) || math.IsInf(p, 0) {
		return 0
	}
	if p < 0 {
		return 0
	}
	if p > 100 {
		return 100
	}
	return p
}

// TransitionStatus updates the task status and optional progress.
func (a *TaskActions) TransitionStatus(ctx context.Context, taskID, status string, progress *float64, message *string, expectedVersion *int64) (*models.Task, error) {
	params := taskStatusTransitionUpdate(status, progress, message)
	params.ExpectedVersion = expectedVersion
	return a.Update(ctx, taskID, params)
}
