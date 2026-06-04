package integration

import (
	"context"
	"fmt"
	"net/http"
	"testing"
)

// TestTaskLifecycle tests creating, reading, updating, and keeping a task artifact
func TestTaskLifecycle(t *testing.T) {
	SkipIfSystemNotAvailable(t)

	client := NewAPIClient()
	ctx := context.Background()
	prefix := TestArtifactPrefix()

	// First create an entity to assign tasks to
	entityID := fmt.Sprintf("%s-task-entity", prefix)
	entityPayload := map[string]interface{}{
		"entity_id":   entityID,
		"entity_type": "asset",
		"subtype":     "drone",
	}

	resp, err := client.Post(ctx, "/entities", entityPayload)
	if err != nil {
		t.Fatalf("Failed to create entity: %v", err)
	}
	requireHTTPStatus(t, resp, http.StatusCreated, "POST /entities (task lifecycle)")
	drainClose(resp)

	// Create task
	taskID := fmt.Sprintf("%s-task-lifecycle", prefix)
	createPayload := map[string]interface{}{
		"task_id":   taskID,
		"entity_id": entityID,
		"status":    "pending",
		"components": map[string]interface{}{
			"command": map[string]interface{}{
				"type": "move_to",
				"target": map[string]interface{}{
					"latitude":  40.7589,
					"longitude": -73.9851,
				},
			},
		},
	}

	resp, err = client.Post(ctx, "/tasks", createPayload)
	if err != nil {
		t.Fatalf("Failed to create task: %v", err)
	}
	requireHTTPStatus(t, resp, http.StatusCreated, "POST /tasks (task lifecycle)")

	var created map[string]interface{}
	if err := ParseResponse(resp, &created); err != nil {
		t.Fatalf("Failed to parse created task: %v", err)
	}

	t.Logf("Created task artifact: %s", taskID)

	// Read task
	resp, err = client.Get(ctx, "/tasks/"+taskID)
	if err != nil {
		t.Fatalf("Failed to get task: %v", err)
	}
	requireHTTPStatus(t, resp, http.StatusOK, "GET /tasks/{id} (task lifecycle)")

	var fetched map[string]interface{}
	if err := ParseResponse(resp, &fetched); err != nil {
		t.Fatalf("Failed to parse fetched task: %v", err)
	}

	if fetched["task_id"] != taskID {
		t.Errorf("Expected task_id %s, got %v", taskID, fetched["task_id"])
	}
	if fetched["status"] != "pending" {
		t.Errorf("Expected status 'pending', got %v", fetched["status"])
	}

	// Update task
	updatePayload := map[string]interface{}{
		"extra": map[string]interface{}{
			"notes": "Test task updated by integration test",
		},
	}

	resp, err = client.Patch(ctx, "/tasks/"+taskID, updatePayload)
	if err != nil {
		t.Fatalf("Failed to update task: %v", err)
	}
	requireHTTPStatus(t, resp, http.StatusOK, "PATCH /tasks/{id} (task lifecycle)")

	var patched map[string]interface{}
	if err := ParseResponse(resp, &patched); err != nil {
		t.Fatalf("Failed to parse PATCH task response: %v", err)
	}
	extra, ok := patched["extra"].(map[string]interface{})
	if !ok {
		t.Fatalf("expected extra on task, got %T", patched["extra"])
	}
	if notes, _ := extra["notes"].(string); notes != "Test task updated by integration test" {
		t.Fatalf("expected updated extra.notes, got %v", extra["notes"])
	}

	t.Logf("Task %s updated and left as artifact in system", taskID)
}

// TestTaskStatusTransitions tests task status changes
func TestTaskStatusTransitions(t *testing.T) {
	SkipIfSystemNotAvailable(t)

	client := NewAPIClient()
	ctx := context.Background()
	prefix := TestArtifactPrefix()

	// Create entity
	entityID := fmt.Sprintf("%s-status-entity", prefix)
	entityPayload := map[string]interface{}{
		"entity_id":   entityID,
		"entity_type": "asset",
		"subtype":     "robot",
	}

	resp, err := client.Post(ctx, "/entities", entityPayload)
	if err != nil {
		t.Fatalf("Failed to create entity: %v", err)
	}
	if resp.StatusCode != http.StatusCreated {
		drainClose(resp)
		t.Fatalf("Expected 201, got %d", resp.StatusCode)
	}
	drainClose(resp)

	// Create task
	taskID := fmt.Sprintf("%s-status-transitions", prefix)
	createPayload := map[string]interface{}{
		"task_id":   taskID,
		"entity_id": entityID,
		"status":    "pending",
	}

	resp, err = client.Post(ctx, "/tasks", createPayload)
	if err != nil {
		t.Fatalf("Failed to create task: %v", err)
	}
	requireHTTPStatus(t, resp, http.StatusCreated, "POST /tasks (status transitions)")
	drainClose(resp)

	// Acknowledge task
	resp, err = client.Post(ctx, "/tasks/"+taskID+"/acknowledge", nil)
	if err != nil {
		t.Fatalf("Failed to acknowledge task: %v", err)
	}
	requireHTTPStatus(t, resp, http.StatusOK, "POST /tasks/{id}/acknowledge")

	var startResult map[string]interface{}
	if err := ParseResponse(resp, &startResult); err != nil {
		t.Fatalf("Failed to parse start response: %v", err)
	}

	if startResult["status"] != "acknowledged" {
		t.Errorf("Expected status 'acknowledged', got %v", startResult["status"])
	}

	t.Logf("Task %s acknowledged (status: acknowledged), left as artifact", taskID)
}

// TestTaskComplete tests completing a task
func TestTaskComplete(t *testing.T) {
	SkipIfSystemNotAvailable(t)

	client := NewAPIClient()
	ctx := context.Background()
	prefix := TestArtifactPrefix()

	// Create task
	taskID := fmt.Sprintf("%s-task-complete", prefix)
	createPayload := map[string]interface{}{
		"task_id": taskID,
		"status":  "acknowledged",
	}

	resp, err := client.Post(ctx, "/tasks", createPayload)
	if err != nil {
		t.Fatalf("Failed to create task: %v", err)
	}
	if resp.StatusCode != http.StatusCreated {
		drainClose(resp)
		t.Fatalf("Expected 201, got %d", resp.StatusCode)
	}
	drainClose(resp)

	// Complete task with result
	completePayload := map[string]interface{}{
		"result": map[string]interface{}{
			"success":     true,
			"description": "Task completed by integration test",
		},
	}

	resp, err = client.Post(ctx, "/tasks/"+taskID+"/complete", completePayload)
	if err != nil {
		t.Fatalf("Failed to complete task: %v", err)
	}
	requireHTTPStatus(t, resp, http.StatusOK, "POST /tasks/{id}/complete")

	var result map[string]interface{}
	if err := ParseResponse(resp, &result); err != nil {
		t.Fatalf("Failed to parse complete response: %v", err)
	}

	if result["status"] != "completed" {
		t.Errorf("Expected status 'completed', got %v", result["status"])
	}

	t.Logf("Task %s completed and left as artifact", taskID)
}

// TestTaskFail tests failing a task
func TestTaskFail(t *testing.T) {
	SkipIfSystemNotAvailable(t)

	client := NewAPIClient()
	ctx := context.Background()
	prefix := TestArtifactPrefix()

	// Create task
	taskID := fmt.Sprintf("%s-task-fail", prefix)
	createPayload := map[string]interface{}{
		"task_id": taskID,
		"status":  "acknowledged",
	}

	resp, err := client.Post(ctx, "/tasks", createPayload)
	if err != nil {
		t.Fatalf("Failed to create task: %v", err)
	}
	if resp.StatusCode != http.StatusCreated {
		drainClose(resp)
		t.Fatalf("Expected 201, got %d", resp.StatusCode)
	}
	drainClose(resp)

	// Fail task with error
	failPayload := map[string]interface{}{
		"error": map[string]interface{}{
			"code":    "TEST_ERROR",
			"message": "Task failed by integration test",
		},
	}

	resp, err = client.Post(ctx, "/tasks/"+taskID+"/fail", failPayload)
	if err != nil {
		t.Fatalf("Failed to fail task: %v", err)
	}
	requireHTTPStatus(t, resp, http.StatusOK, "POST /tasks/{id}/fail")

	var result map[string]interface{}
	if err := ParseResponse(resp, &result); err != nil {
		t.Fatalf("Failed to parse fail response: %v", err)
	}

	if result["status"] != "failed" {
		t.Errorf("Expected status 'failed', got %v", result["status"])
	}

	t.Logf("Task %s failed and left as artifact", taskID)
}

// TestTasksByEntity tests getting tasks for a specific entity
func TestTasksByEntity(t *testing.T) {
	SkipIfSystemNotAvailable(t)

	client := NewAPIClient()
	ctx := context.Background()
	prefix := TestArtifactPrefix()

	// Create entity
	entityID := fmt.Sprintf("%s-tasks-by-entity", prefix)
	entityPayload := map[string]interface{}{
		"entity_id":   entityID,
		"entity_type": "asset",
		"subtype":     "drone",
	}

	resp, err := client.Post(ctx, "/entities", entityPayload)
	if err != nil {
		t.Fatalf("Failed to create entity: %v", err)
	}
	requireHTTPStatus(t, resp, http.StatusCreated, "POST /entities (tasks by entity)")
	drainClose(resp)

	// Create multiple tasks for entity
	var createdIDs []string
	for i := 1; i <= 3; i++ {
		taskID := fmt.Sprintf("%s-entity-task-%d", prefix, i)
		createdIDs = append(createdIDs, taskID)
		createPayload := map[string]interface{}{
			"task_id":   taskID,
			"entity_id": entityID,
			"status":    "pending",
		}

		resp, err = client.Post(ctx, "/tasks", createPayload)
		if err != nil {
			t.Fatalf("Failed to create task %d: %v", i, err)
		}
		requireHTTPStatus(t, resp, http.StatusCreated, fmt.Sprintf("POST /tasks task %d", i))
		drainClose(resp)
	}

	// Get tasks by entity
	resp, err = client.Get(ctx, "/entities/"+entityID+"/tasks")
	if err != nil {
		t.Fatalf("Failed to get tasks by entity: %v", err)
	}

	if resp.StatusCode != http.StatusOK {
		drainClose(resp)
		t.Fatalf("Expected 200, got %d", resp.StatusCode)
	}

	var tasks []map[string]interface{}
	if err := ParseResponse(resp, &tasks); err != nil {
		t.Fatalf("Failed to parse tasks: %v", err)
	}

	if len(tasks) < len(createdIDs) {
		t.Fatalf("Expected at least %d tasks, got %d", len(createdIDs), len(tasks))
	}

	returnedByID := make(map[string]map[string]interface{}, len(tasks))
	for _, task := range tasks {
		id, _ := task["task_id"].(string)
		if id == "" {
			t.Fatalf("task missing task_id: %#v", task)
		}
		returnedByID[id] = task
		eid, _ := task["entity_id"].(string)
		if eid != entityID {
			t.Errorf("task %s has entity_id %q, want %q", id, eid, entityID)
		}
	}
	for _, id := range createdIDs {
		if _, ok := returnedByID[id]; !ok {
			t.Errorf("expected created task %s in GET /entities/{id}/tasks response", id)
		}
	}

	t.Logf("Entity %s with %d tasks left as artifacts", entityID, len(tasks))
}

// TestTaskListPagination tests task listing with pagination
func TestTaskListPagination(t *testing.T) {
	SkipIfSystemNotAvailable(t)

	client := NewAPIClient()
	ctx := context.Background()

	resp, err := client.Get(ctx, "/tasks?limit=10")
	if err != nil {
		t.Fatalf("Failed to list tasks: %v", err)
	}
	defer drainClose(resp)

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("Expected 200, got %d", resp.StatusCode)
	}

	if resp.Header.Get("X-Limit") != "10" {
		t.Errorf("Expected X-Limit '10', got '%s'", resp.Header.Get("X-Limit"))
	}
	if resp.Header.Get("X-Returned-Count") == "" {
		t.Error("Expected X-Returned-Count header")
	}
	if hasMore := resp.Header.Get("X-Has-More"); hasMore != "true" && hasMore != "false" {
		t.Errorf("Expected X-Has-More true/false, got '%s'", hasMore)
	}
	if resp.Header.Get("X-Total-Count") != "" || resp.Header.Get("X-Offset") != "" {
		t.Errorf("Old offset pagination headers should not be present: %#v", resp.Header)
	}

	t.Logf("Task list pagination: limit=%s, returned=%s, has_more=%s, next_cursor=%s", resp.Header.Get("X-Limit"), resp.Header.Get("X-Returned-Count"), resp.Header.Get("X-Has-More"), resp.Header.Get("X-Next-Cursor"))
}

// TestTaskNotFound tests 404 response for non-existent task
func TestTaskNotFound(t *testing.T) {
	SkipIfSystemNotAvailable(t)

	client := NewAPIClient()
	ctx := context.Background()

	resp, err := client.Get(ctx, "/tasks/non-existent-task-"+TestArtifactPrefix())
	if err != nil {
		t.Fatalf("Failed to call API: %v", err)
	}
	if resp.StatusCode != http.StatusNotFound {
		drainClose(resp)
		t.Fatalf("Expected 404, got %d", resp.StatusCode)
	}

	var result map[string]interface{}
	if err := ParseResponse(resp, &result); err != nil {
		t.Fatalf("Failed to parse error response: %v", err)
	}

	if result["error_code"] != "TASK_NOT_FOUND" {
		t.Errorf("Expected error_code 'TASK_NOT_FOUND', got %v", result["error_code"])
	}
}
