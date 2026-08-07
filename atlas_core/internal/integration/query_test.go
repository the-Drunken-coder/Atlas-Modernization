package integration

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"testing"
)

// TestQueryFullDataset tests the /queries/full endpoint
func TestQueryFullDataset(t *testing.T) {
	SkipIfSystemNotAvailable(t)

	client := NewAPIClient()
	ctx := context.Background()
	prefix := TestArtifactPrefix()

	// Create some test data first
	entityID := fmt.Sprintf("%s-query-full-entity", prefix)
	entityPayload := map[string]interface{}{
		"entity_id":   entityID,
		"entity_type": "asset",
		"subtype":     "query-test",
	}

	resp, err := client.Post(ctx, "/entities", entityPayload)
	if err != nil {
		t.Fatalf("Failed to create entity: %v", err)
	}
	requireHTTPStatus(t, resp, http.StatusCreated, "POST /entities (query full setup)")
	if err := resp.Body.Close(); err != nil {
		t.Fatalf("close body: %v", err)
	}

	taskID := fmt.Sprintf("%s-query-full-task", prefix)
	taskPayload := map[string]interface{}{
		"task_id":   taskID,
		"entity_id": entityID,
	}

	resp, err = client.Post(ctx, "/tasks", taskPayload)
	if err != nil {
		t.Fatalf("Failed to create task: %v", err)
	}
	requireHTTPStatus(t, resp, http.StatusCreated, "POST /tasks (query full setup)")
	if err := resp.Body.Close(); err != nil {
		t.Fatalf("close body: %v", err)
	}

	// Query full dataset
	resp, err = client.Get(ctx, "/queries/full")
	if err != nil {
		t.Fatalf("Failed to query full dataset: %v", err)
	}
	defer drainClose(resp)

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("Expected 200, got %d", resp.StatusCode)
	}

	var result map[string]interface{}
	if err := ParseResponse(resp, &result); err != nil {
		t.Fatalf("Failed to parse query response: %v", err)
	}

	// Verify structure
	if result["entities"] == nil {
		t.Error("Expected 'entities' in response")
	}
	if result["tasks"] == nil {
		t.Error("Expected 'tasks' in response")
	}
	if result["objects"] == nil {
		t.Error("Expected 'objects' in response")
	}

	entities, ok := result["entities"].([]interface{})
	if !ok {
		t.Fatalf("Expected entities array, got %T", result["entities"])
	}
	tasks, ok := result["tasks"].([]interface{})
	if !ok {
		t.Fatalf("Expected tasks array, got %T", result["tasks"])
	}
	objects, ok := result["objects"].([]interface{})
	if !ok {
		t.Fatalf("Expected objects array, got %T", result["objects"])
	}

	if !sliceContainsID(entities, "entity_id", entityID) {
		t.Fatalf("expected entity_id %s in /queries/full entities", entityID)
	}
	if !sliceContainsID(tasks, "task_id", taskID) {
		t.Fatalf("expected task_id %s in /queries/full tasks", taskID)
	}

	t.Logf("Full dataset query returned: %d entities, %d tasks, %d objects",
		len(entities), len(tasks), len(objects))
	t.Logf("Entity %s and task %s left as artifacts", entityID, taskID)
}

// TestQueryChangedSince tests the /queries/changed-since endpoint
func TestQueryChangedSince(t *testing.T) {
	SkipIfSystemNotAvailable(t)

	client := NewAPIClient()
	ctx := context.Background()
	prefix := TestArtifactPrefix()

	// Create some test data
	entityID := fmt.Sprintf("%s-changed-since-entity", prefix)
	entityPayload := map[string]interface{}{
		"entity_id":   entityID,
		"entity_type": "track",
		"subtype":     "changed-since-test",
	}

	resp, err := client.Post(ctx, "/entities", entityPayload)
	if err != nil {
		t.Fatalf("Failed to create entity: %v", err)
	}
	requireHTTPStatus(t, resp, http.StatusCreated, "POST /entities (changed-since setup)")
	var createdEntity map[string]interface{}
	if err := ParseResponse(resp, &createdEntity); err != nil {
		t.Fatalf("Failed to parse created entity: %v", err)
	}
	metadata, ok := createdEntity["metadata"].(map[string]interface{})
	if !ok {
		t.Fatalf("created entity missing metadata: %#v", createdEntity)
	}
	baseline := mustVersionFromMetadata(t, metadata) - 1

	// Query changed since
	resp, err = client.Get(ctx, fmt.Sprintf("/queries/changed-since?since_version=%d", baseline))
	if err != nil {
		t.Fatalf("Failed to query changed-since: %v", err)
	}
	defer drainClose(resp)

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("Expected 200, got %d", resp.StatusCode)
	}

	var result map[string]interface{}
	if err := ParseResponse(resp, &result); err != nil {
		t.Fatalf("Failed to parse query response: %v", err)
	}

	if result["version"] == nil {
		t.Error("Expected 'version' in response")
	}
	if result["has_more"] == nil {
		t.Error("Expected 'has_more' in response")
	}
	events := mustInterfaceSlice(t, result["events"], "events")
	if findChangeEvent(events, "entity", entityID, "") == nil {
		t.Fatalf("expected entity event %s in /queries/changed-since", entityID)
	}

	t.Logf("Changed-since query returned: %d events after version %d", len(events), baseline)
	t.Logf("Entity %s left as artifact", entityID)
}

func TestQueryChangedSinceIncludesTasksAffectedByDeletedEntity(t *testing.T) {
	SkipIfSystemNotAvailable(t)

	client := NewAPIClient()
	ctx := context.Background()
	prefix := TestArtifactPrefix()

	entityID := fmt.Sprintf("%s-delete-entity", prefix)
	taskID := fmt.Sprintf("%s-delete-task", prefix)

	resp, err := client.Post(ctx, "/entities", map[string]interface{}{
		"entity_id":   entityID,
		"entity_type": "asset",
	})
	if err != nil {
		t.Fatalf("Failed to create entity: %v", err)
	}
	requireHTTPStatus(t, resp, http.StatusCreated, "POST /entities (delete changed-since setup)")
	drainClose(resp)

	resp, err = client.Post(ctx, "/tasks", map[string]interface{}{
		"task_id":   taskID,
		"entity_id": entityID,
	})
	if err != nil {
		t.Fatalf("Failed to create task: %v", err)
	}
	requireHTTPStatus(t, resp, http.StatusCreated, "POST /tasks (delete changed-since setup)")
	var createdTask map[string]interface{}
	if err := ParseResponse(resp, &createdTask); err != nil {
		t.Fatalf("Failed to parse created task: %v", err)
	}
	metadata, ok := createdTask["metadata"].(map[string]interface{})
	if !ok {
		t.Fatalf("created task missing metadata: %#v", createdTask)
	}
	sinceVersion := mustVersionFromMetadata(t, metadata)

	resp, err = client.Delete(ctx, "/entities/"+entityID)
	if err != nil {
		t.Fatalf("Failed to delete entity: %v", err)
	}
	requireHTTPStatus(t, resp, http.StatusNoContent, "DELETE /entities/{entity_id}")
	drainClose(resp)

	q := url.Values{}
	q.Set("since_version", fmt.Sprintf("%d", sinceVersion))
	resp, err = client.Get(ctx, "/queries/changed-since?"+q.Encode())
	if err != nil {
		t.Fatalf("Failed to query changed-since after entity delete: %v", err)
	}
	defer drainClose(resp)
	requireHTTPStatus(t, resp, http.StatusOK, "GET /queries/changed-since after entity delete")

	var result map[string]interface{}
	if err := ParseResponse(resp, &result); err != nil {
		t.Fatalf("Failed to parse changed-since response: %v", err)
	}
	events := mustInterfaceSlice(t, result["events"], "events")
	taskEvent := findChangeEvent(events, "task", taskID, "update")
	if taskEvent == nil {
		t.Fatalf("expected changed-since tasks to include task %s after deleting entity %s", taskID, entityID)
	}
	changedTask, ok := taskEvent["resource"].(map[string]interface{})
	if !ok {
		t.Fatalf("changed task event missing resource: %#v", taskEvent)
	}
	if entity, ok := changedTask["entity_id"]; ok && entity != nil {
		t.Fatalf("expected changed task entity_id to be null after entity delete, got %#v", entity)
	}
	if findChangeEvent(events, "entity", entityID, "delete") == nil {
		t.Fatalf("expected entity delete event for %s", entityID)
	}
}

func TestQueryChangedSinceIncludesDeletedTaskEntityID(t *testing.T) {
	SkipIfSystemNotAvailable(t)

	client := NewAPIClient()
	ctx := context.Background()
	prefix := TestArtifactPrefix()

	entityID := fmt.Sprintf("%s-delete-task-entity", prefix)
	taskID := fmt.Sprintf("%s-delete-task-event", prefix)

	resp, err := client.Post(ctx, "/entities", map[string]interface{}{
		"entity_id":   entityID,
		"entity_type": "asset",
	})
	if err != nil {
		t.Fatalf("Failed to create entity: %v", err)
	}
	requireHTTPStatus(t, resp, http.StatusCreated, "POST /entities (task delete-event setup)")
	drainClose(resp)
	t.Cleanup(func() {
		cleanupResp, cleanupErr := client.Delete(context.Background(), "/entities/"+entityID)
		if cleanupErr == nil {
			drainClose(cleanupResp)
		}
	})

	resp, err = client.Post(ctx, "/tasks", map[string]interface{}{
		"task_id":   taskID,
		"entity_id": entityID,
	})
	if err != nil {
		t.Fatalf("Failed to create task: %v", err)
	}
	requireHTTPStatus(t, resp, http.StatusCreated, "POST /tasks (task delete-event setup)")
	var createdTask map[string]interface{}
	if err := ParseResponse(resp, &createdTask); err != nil {
		t.Fatalf("Failed to parse created task: %v", err)
	}
	metadata, ok := createdTask["metadata"].(map[string]interface{})
	if !ok {
		t.Fatalf("created task missing metadata: %#v", createdTask)
	}
	sinceVersion := mustVersionFromMetadata(t, metadata)

	resp, err = client.Delete(ctx, "/tasks/"+taskID)
	if err != nil {
		t.Fatalf("Failed to delete task: %v", err)
	}
	requireHTTPStatus(t, resp, http.StatusNoContent, "DELETE /tasks/{task_id}")
	drainClose(resp)

	q := url.Values{}
	q.Set("since_version", fmt.Sprintf("%d", sinceVersion))
	resp, err = client.Get(ctx, "/queries/changed-since?"+q.Encode())
	if err != nil {
		t.Fatalf("Failed to query changed-since after task delete: %v", err)
	}
	defer drainClose(resp)
	requireHTTPStatus(t, resp, http.StatusOK, "GET /queries/changed-since after task delete")

	var result map[string]interface{}
	if err := ParseResponse(resp, &result); err != nil {
		t.Fatalf("Failed to parse changed-since response: %v", err)
	}
	events := mustInterfaceSlice(t, result["events"], "events")
	deleteEvent := findChangeEvent(events, "task", taskID, "delete")
	if deleteEvent == nil {
		t.Fatalf("expected task delete event for %s", taskID)
	}
	if deleteEvent["entity_id"] != entityID {
		t.Fatalf("expected deleted task entity_id %q, got %#v", entityID, deleteEvent["entity_id"])
	}
}

func TestQueryChangedSinceIncludesDeletedTaskNullEntityID(t *testing.T) {
	SkipIfSystemNotAvailable(t)

	client := NewAPIClient()
	ctx := context.Background()
	taskID := fmt.Sprintf("%s-delete-task-null-entity", TestArtifactPrefix())

	resp, err := client.Post(ctx, "/tasks", map[string]interface{}{
		"task_id": taskID,
	})
	if err != nil {
		t.Fatalf("Failed to create task without entity: %v", err)
	}
	requireHTTPStatus(t, resp, http.StatusCreated, "POST /tasks (null entity task delete-event setup)")
	var createdTask map[string]interface{}
	if err := ParseResponse(resp, &createdTask); err != nil {
		t.Fatalf("Failed to parse created task: %v", err)
	}
	metadata, ok := createdTask["metadata"].(map[string]interface{})
	if !ok {
		t.Fatalf("created task missing metadata: %#v", createdTask)
	}
	sinceVersion := mustVersionFromMetadata(t, metadata)

	resp, err = client.Delete(ctx, "/tasks/"+taskID)
	if err != nil {
		t.Fatalf("Failed to delete task without entity: %v", err)
	}
	requireHTTPStatus(t, resp, http.StatusNoContent, "DELETE /tasks/{task_id} (null entity)")
	drainClose(resp)

	q := url.Values{}
	q.Set("since_version", fmt.Sprintf("%d", sinceVersion))
	resp, err = client.Get(ctx, "/queries/changed-since?"+q.Encode())
	if err != nil {
		t.Fatalf("Failed to query changed-since after task delete: %v", err)
	}
	defer drainClose(resp)
	requireHTTPStatus(t, resp, http.StatusOK, "GET /queries/changed-since after null-entity task delete")

	var result map[string]interface{}
	if err := ParseResponse(resp, &result); err != nil {
		t.Fatalf("Failed to parse changed-since response: %v", err)
	}
	events := mustInterfaceSlice(t, result["events"], "events")
	deleteEvent := findChangeEvent(events, "task", taskID, "delete")
	if deleteEvent == nil {
		t.Fatalf("expected task delete event for %s", taskID)
	}
	if entityID, ok := deleteEvent["entity_id"]; ok && entityID != nil {
		t.Fatalf("expected deleted task entity_id to be null or omitted, got %#v", entityID)
	}
}

// TestQueryChangedSinceMissingParam tests error handling for missing since param
func TestQueryChangedSinceMissingParam(t *testing.T) {
	SkipIfSystemNotAvailable(t)

	client := NewAPIClient()
	ctx := context.Background()

	resp, err := client.Get(ctx, "/queries/changed-since")
	if err != nil {
		t.Fatalf("Failed to call API: %v", err)
	}
	defer drainClose(resp)

	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("Expected 400, got %d", resp.StatusCode)
	}

	var result map[string]interface{}
	if err := ParseResponse(resp, &result); err != nil {
		t.Fatalf("Failed to parse error response: %v", err)
	}

	if result["error_code"] != "VALIDATION_ERROR" {
		t.Errorf("Expected error_code 'VALIDATION_ERROR', got %v", result["error_code"])
	}
}

// TestQueryChangedSinceInvalidFormat tests error handling for invalid version
func TestQueryChangedSinceInvalidFormat(t *testing.T) {
	SkipIfSystemNotAvailable(t)

	client := NewAPIClient()
	ctx := context.Background()

	resp, err := client.Get(ctx, "/queries/changed-since?since_version=invalid-version")
	if err != nil {
		t.Fatalf("Failed to call API: %v", err)
	}
	defer drainClose(resp)

	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("Expected 400, got %d", resp.StatusCode)
	}

	var result map[string]interface{}
	if err := ParseResponse(resp, &result); err != nil {
		t.Fatalf("Failed to parse error response: %v", err)
	}
	if result["error_code"] != "VALIDATION_ERROR" {
		t.Errorf("Expected error_code 'VALIDATION_ERROR', got %v", result["error_code"])
	}
	details, _ := result["details"].(map[string]interface{})
	errs, _ := details["errors"].([]interface{})
	if len(errs) == 0 {
		t.Errorf("Expected validation details.errors for invalid since_version")
	} else {
		first, ok := errs[0].(string)
		if !ok || !strings.Contains(strings.ToLower(first), "since_version") {
			t.Errorf("Expected an error mentioning since_version, got %v", errs[0])
		}
	}
}

func TestQueryFullDatasetCursorContinuationOmitsUnrequestedStreams(t *testing.T) {
	SkipIfSystemNotAvailable(t)

	client := NewAPIClient()
	ctx := context.Background()
	prefix := TestArtifactPrefix()

	entityIDs := []string{
		fmt.Sprintf("%s-full-page-entity-1", prefix),
		fmt.Sprintf("%s-full-page-entity-2", prefix),
	}
	taskIDs := []string{
		fmt.Sprintf("%s-full-page-task-1", prefix),
		fmt.Sprintf("%s-full-page-task-2", prefix),
	}
	objectIDs := []string{
		fmt.Sprintf("%s-full-page-object-1", prefix),
		fmt.Sprintf("%s-full-page-object-2", prefix),
	}

	for _, entityID := range entityIDs {
		createQueryTestEntity(ctx, t, client, entityID)
	}
	for i, taskID := range taskIDs {
		createQueryTestTask(ctx, t, client, taskID, entityIDs[i%len(entityIDs)])
	}
	for i, objectID := range objectIDs {
		createQueryTestObject(ctx, t, client, objectID, entityIDs[i%len(entityIDs)], taskIDs[i%len(taskIDs)])
	}

	resp, err := client.Get(ctx, "/queries/full?entity_limit=1&task_limit=1&object_limit=1")
	if err != nil {
		t.Fatalf("Failed to query full dataset: %v", err)
	}
	defer drainClose(resp)
	requireHTTPStatus(t, resp, http.StatusOK, "GET /queries/full page 1")

	var firstPage map[string]interface{}
	if err := ParseResponse(resp, &firstPage); err != nil {
		t.Fatalf("Failed to parse first query page: %v", err)
	}

	firstEntities := mustInterfaceSlice(t, firstPage["entities"], "entities")
	firstTasks := mustInterfaceSlice(t, firstPage["tasks"], "tasks")
	firstObjects := mustInterfaceSlice(t, firstPage["objects"], "objects")
	if len(firstEntities) != 1 || len(firstTasks) != 1 || len(firstObjects) != 1 {
		t.Fatalf("expected one item per stream on page 1, got entities=%d tasks=%d objects=%d", len(firstEntities), len(firstTasks), len(firstObjects))
	}
	if firstPage["has_more_entities"] != true || firstPage["has_more_tasks"] != true || firstPage["has_more_objects"] != true {
		t.Fatalf("expected has_more_* flags on page 1, got %+v", firstPage)
	}

	entityCursor, _ := firstPage["next_entity_cursor"].(string)
	taskCursor, _ := firstPage["next_task_cursor"].(string)
	objectCursor, _ := firstPage["next_object_cursor"].(string)
	if entityCursor == "" || taskCursor == "" || objectCursor == "" {
		t.Fatalf("expected continuation cursors on page 1, got entity=%q task=%q object=%q", entityCursor, taskCursor, objectCursor)
	}

	q := url.Values{}
	q.Set("entity_limit", "1")
	q.Set("entity_cursor", entityCursor)
	resp, err = client.Get(ctx, "/queries/full?"+q.Encode())
	if err != nil {
		t.Fatalf("Failed to query full dataset entity continuation: %v", err)
	}
	defer drainClose(resp)
	requireHTTPStatus(t, resp, http.StatusOK, "GET /queries/full entity continuation")

	var entityPage map[string]interface{}
	if err := ParseResponse(resp, &entityPage); err != nil {
		t.Fatalf("Failed to parse entity continuation page: %v", err)
	}
	entityOnly := mustInterfaceSlice(t, entityPage["entities"], "entities")
	if len(entityOnly) != 1 {
		t.Fatalf("expected one entity on continuation page, got %d", len(entityOnly))
	}
	if len(mustInterfaceSlice(t, entityPage["tasks"], "tasks")) != 0 {
		t.Fatal("expected omitted task stream to stay empty on entity-only continuation")
	}
	if len(mustInterfaceSlice(t, entityPage["objects"], "objects")) != 0 {
		t.Fatal("expected omitted object stream to stay empty on entity-only continuation")
	}
	if firstEntityID := mustStringField(t, firstEntities[0], "entity_id"); mustStringField(t, entityOnly[0], "entity_id") == firstEntityID {
		t.Fatalf("expected entity continuation to advance past %s", firstEntityID)
	}

	q = url.Values{}
	q.Set("entity_limit", "1")
	q.Set("task_limit", "1")
	q.Set("object_limit", "1")
	q.Set("entity_cursor", entityCursor)
	q.Set("task_cursor", taskCursor)
	q.Set("object_cursor", objectCursor)
	resp, err = client.Get(ctx, "/queries/full?"+q.Encode())
	if err != nil {
		t.Fatalf("Failed to query full dataset full continuation: %v", err)
	}
	defer drainClose(resp)
	requireHTTPStatus(t, resp, http.StatusOK, "GET /queries/full all-stream continuation")

	var secondPage map[string]interface{}
	if err := ParseResponse(resp, &secondPage); err != nil {
		t.Fatalf("Failed to parse second query page: %v", err)
	}
	if len(mustInterfaceSlice(t, secondPage["entities"], "entities")) != 1 {
		t.Fatal("expected one entity on all-stream continuation")
	}
	if len(mustInterfaceSlice(t, secondPage["tasks"], "tasks")) != 1 {
		t.Fatal("expected one task on all-stream continuation")
	}
	if len(mustInterfaceSlice(t, secondPage["objects"], "objects")) != 1 {
		t.Fatal("expected one object on all-stream continuation")
	}
}

func TestQueryChangedSinceCursorContinuationUsesOneOrderedSnapshot(t *testing.T) {
	SkipIfSystemNotAvailable(t)

	client := NewAPIClient()
	ctx := context.Background()
	baselineResponse, err := client.Get(ctx, "/queries/full?limit=1")
	if err != nil {
		t.Fatalf("read full-query baseline: %v", err)
	}
	requireHTTPStatus(t, baselineResponse, http.StatusOK, "GET /queries/full baseline")
	var baselinePage map[string]interface{}
	if err := ParseResponse(baselineResponse, &baselinePage); err != nil {
		t.Fatalf("parse full-query baseline: %v", err)
	}
	baseline := int64(baselinePage["version"].(float64))

	prefix := TestArtifactPrefix()
	entityIDs := []string{
		fmt.Sprintf("%s-changed-page-entity-1", prefix),
		fmt.Sprintf("%s-changed-page-entity-2", prefix),
	}
	for _, entityID := range entityIDs {
		createQueryTestEntity(ctx, t, client, entityID)
	}
	taskID := fmt.Sprintf("%s-changed-page-task", prefix)
	createQueryTestTask(ctx, t, client, taskID, entityIDs[0])
	objectID := fmt.Sprintf("%s-changed-page-object", prefix)
	createQueryTestObject(ctx, t, client, objectID, entityIDs[0], taskID)
	lateEntityID := fmt.Sprintf("%s-changed-page-late-entity", prefix)

	var events []interface{}
	var cursor string
	var snapshotVersion int64
	for pageNumber := 0; ; pageNumber++ {
		q := url.Values{}
		q.Set("since_version", fmt.Sprintf("%d", baseline))
		q.Set("limit", "1")
		if cursor != "" {
			q.Set("cursor", cursor)
		}
		resp, err := client.Get(ctx, "/queries/changed-since?"+q.Encode())
		if err != nil {
			t.Fatalf("query changed-since page %d: %v", pageNumber+1, err)
		}
		requireHTTPStatus(t, resp, http.StatusOK, "GET /queries/changed-since continuation")
		var page map[string]interface{}
		if err := ParseResponse(resp, &page); err != nil {
			t.Fatalf("parse changed-since page %d: %v", pageNumber+1, err)
		}
		version := int64(page["version"].(float64))
		if pageNumber == 0 {
			snapshotVersion = version
			createQueryTestEntity(ctx, t, client, lateEntityID)
		} else if version != snapshotVersion {
			t.Fatalf("continuation version = %d, want %d", version, snapshotVersion)
		}
		events = append(events, mustInterfaceSlice(t, page["events"], "events")...)
		if page["has_more"] != true {
			break
		}
		cursor, _ = page["next_cursor"].(string)
		if cursor == "" {
			t.Fatal("has_more response omitted next_cursor")
		}
	}

	for _, entityID := range entityIDs {
		event := findChangeEvent(events, "entity", entityID, "")
		if event == nil {
			t.Fatalf("missing entity event %s", entityID)
		}
		resource, ok := event["resource"].(map[string]interface{})
		if !ok || resource["entity_id"] != entityID {
			t.Fatalf("entity create event resource = %#v, want %s", event["resource"], entityID)
		}
	}
	if findChangeEvent(events, "entity", lateEntityID, "") != nil {
		t.Fatalf("snapshot pagination included late entity %s", lateEntityID)
	}
	if findChangeEvent(events, "task", taskID, "") == nil || findChangeEvent(events, "object", objectID, "") == nil {
		t.Fatal("changed-since continuation omitted task or object event")
	}
	for index := 1; index < len(events); index++ {
		previous := events[index-1].(map[string]interface{})["version"].(float64)
		current := events[index].(map[string]interface{})["version"].(float64)
		if current <= previous {
			t.Fatalf("events are not globally ordered: %v then %v", previous, current)
		}
	}

	resp, err := client.Get(ctx, fmt.Sprintf("/queries/changed-since?since_version=%d", snapshotVersion))
	if err != nil {
		t.Fatalf("query changed-since after snapshot: %v", err)
	}
	requireHTTPStatus(t, resp, http.StatusOK, "GET /queries/changed-since after snapshot")
	var nextPage map[string]interface{}
	if err := ParseResponse(resp, &nextPage); err != nil {
		t.Fatalf("parse changed-since after snapshot: %v", err)
	}
	if findChangeEvent(mustInterfaceSlice(t, nextPage["events"], "events"), "entity", lateEntityID, "") == nil {
		t.Fatalf("next changed-since query omitted late entity %s", lateEntityID)
	}
}

// TestComplexScenario tests a complex workflow with entities, tasks, and objects
func TestComplexScenario(t *testing.T) {
	SkipIfSystemNotAvailable(t)

	client := NewAPIClient()
	ctx := context.Background()
	prefix := TestArtifactPrefix()

	// Create a fleet of entities
	entityIDs := make([]string, 3)
	for i := 0; i < 3; i++ {
		entityID := fmt.Sprintf("%s-fleet-drone-%d", prefix, i+1)
		entityIDs[i] = entityID

		entityPayload := map[string]interface{}{
			"entity_id":   entityID,
			"entity_type": "asset",
			"subtype":     "drone",
			"alias":       fmt.Sprintf("Fleet Drone %d", i+1),
			"components": map[string]interface{}{
				"telemetry": map[string]interface{}{
					"latitude":  40.7128 + float64(i)*0.001,
					"longitude": -74.0060 + float64(i)*0.001,
				},
				"status": map[string]interface{}{
					"value": "idle",
				},
			},
		}

		resp, err := client.Post(ctx, "/entities", entityPayload)
		if err != nil {
			t.Fatalf("Failed to create entity %d: %v", i+1, err)
		}
		if resp.StatusCode != http.StatusCreated {
			resp.Body.Close()
			t.Fatalf("Expected 201 for entity %d, got %d", i+1, resp.StatusCode)
		}
		resp.Body.Close()
	}

	t.Logf("Created fleet of %d entities", len(entityIDs))

	// Create a mission task for each entity
	taskIDs := make([]string, len(entityIDs))
	for i, entityID := range entityIDs {
		taskID := fmt.Sprintf("%s-mission-%d", prefix, i+1)
		taskIDs[i] = taskID

		taskPayload := map[string]interface{}{
			"task_id":   taskID,
			"entity_id": entityID,
			"status":    "pending",
			"components": map[string]interface{}{
				"custom_mission": map[string]interface{}{
					"type": "move_to",
					"target": map[string]interface{}{
						"latitude":  40.7128 + float64(i)*0.001,
						"longitude": -74.0060 + float64(i)*0.001,
					},
				},
			},
		}

		resp, err := client.Post(ctx, "/tasks", taskPayload)
		if err != nil {
			t.Fatalf("Failed to create task %d: %v", i+1, err)
		}
		if resp.StatusCode != http.StatusCreated {
			resp.Body.Close()
			t.Fatalf("Expected 201 for task %d, got %d", i+1, resp.StatusCode)
		}
		resp.Body.Close()
	}

	t.Logf("Created %d mission tasks", len(taskIDs))

	// Acknowledge all tasks
	for _, taskID := range taskIDs {
		resp, err := client.Patch(ctx, "/tasks/"+taskID, map[string]interface{}{"status": "acknowledged"})
		if err != nil {
			t.Fatalf("Failed to acknowledge task %s: %v", taskID, err)
		}
		if resp.StatusCode != http.StatusOK {
			resp.Body.Close()
			t.Fatalf("Expected 200 acknowledging task %s, got %d", taskID, resp.StatusCode)
		}
		resp.Body.Close()
	}

	t.Logf("Acknowledged all %d tasks", len(taskIDs))

	// Complete first task, fail second, leave third acknowledged
	completePayload := map[string]interface{}{
		"status": "completed",
		"extra": map[string]interface{}{
			"result": map[string]interface{}{
				"success":    true,
				"waypoint":   1,
				"photos":     5,
				"duration_s": 120,
			},
		},
	}

	resp, err := client.Patch(ctx, "/tasks/"+taskIDs[0], completePayload)
	if err != nil {
		t.Fatalf("Failed to complete task: %v", err)
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		t.Fatalf("Expected 200 completing task, got %d", resp.StatusCode)
	}
	resp.Body.Close()

	failPayload := map[string]interface{}{
		"status": "failed",
		"extra": map[string]interface{}{
			"error": map[string]interface{}{
				"code":    "LOW_BATTERY",
				"message": "Battery level critical, returning to base",
			},
		},
	}

	resp, err = client.Patch(ctx, "/tasks/"+taskIDs[1], failPayload)
	if err != nil {
		t.Fatalf("Failed to fail task: %v", err)
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		t.Fatalf("Expected 200 failing task, got %d", resp.StatusCode)
	}
	resp.Body.Close()

	// Create objects representing captured data
	for i := 0; i < 3; i++ {
		objectID := fmt.Sprintf("%s-capture-%d", prefix, i+1)
		objectPayload := map[string]interface{}{
			"object_id":    objectID,
			"content_type": "image/jpeg",
			"type":         "aerial-photo",
			"size_bytes":   1024 * 1024 * (i + 1),
			"referenced_by": []map[string]interface{}{
				{"entity_id": entityIDs[0]},
				{"task_id": taskIDs[0]},
			},
		}

		resp, err = client.Post(ctx, "/objects", objectPayload)
		if err != nil {
			t.Fatalf("Failed to create object %d: %v", i+1, err)
		}
		if resp.StatusCode != http.StatusCreated {
			resp.Body.Close()
			t.Fatalf("Expected 201 for object %d, got %d", i+1, resp.StatusCode)
		}
		resp.Body.Close()
	}

	t.Logf("Created 3 capture objects")

	// Verify full dataset
	resp, err = client.Get(ctx, "/queries/full")
	if err != nil {
		t.Fatalf("Failed to query full dataset: %v", err)
	}
	defer drainClose(resp)
	requireHTTPStatus(t, resp, http.StatusOK, "GET /queries/full (complex scenario)")

	var result map[string]interface{}
	if err := ParseResponse(resp, &result); err != nil {
		t.Fatalf("Failed to parse query response: %v", err)
	}

	entities, ok := result["entities"].([]interface{})
	if !ok {
		t.Fatalf("expected entities array, got %T", result["entities"])
	}
	tasks, ok := result["tasks"].([]interface{})
	if !ok {
		t.Fatalf("expected tasks array, got %T", result["tasks"])
	}
	objects, ok := result["objects"].([]interface{})
	if !ok {
		t.Fatalf("expected objects array, got %T", result["objects"])
	}
	if len(entities) < len(entityIDs) {
		t.Fatalf("expected at least %d entities in full query, got %d", len(entityIDs), len(entities))
	}
	if len(tasks) < len(taskIDs) {
		t.Fatalf("expected at least %d tasks in full query, got %d", len(taskIDs), len(tasks))
	}
	if len(objects) < 3 {
		t.Fatalf("expected at least 3 objects in full query, got %d", len(objects))
	}
	for _, id := range entityIDs {
		if !sliceContainsID(entities, "entity_id", id) {
			t.Fatalf("full query missing entity %s", id)
		}
	}
	for _, id := range taskIDs {
		if !sliceContainsID(tasks, "task_id", id) {
			t.Fatalf("full query missing task %s", id)
		}
	}
	for i := 1; i <= 3; i++ {
		oid := fmt.Sprintf("%s-capture-%d", prefix, i)
		if !sliceContainsID(objects, "object_id", oid) {
			t.Fatalf("full query missing object %s", oid)
		}
	}

	statusByID := make(map[string]string)
	for _, raw := range tasks {
		m, ok := raw.(map[string]interface{})
		if !ok {
			continue
		}
		id, _ := m["task_id"].(string)
		st, _ := m["status"].(string)
		if id != "" {
			statusByID[id] = st
		}
	}
	wantStatus := map[string]string{
		taskIDs[0]: "completed",
		taskIDs[1]: "failed",
		taskIDs[2]: "acknowledged",
	}
	for id, want := range wantStatus {
		if got := statusByID[id]; got != want {
			t.Fatalf("task %s: want status %q, got %q", id, want, got)
		}
	}

	t.Logf("Complex scenario complete. All artifacts left in system:")
	t.Logf("  - %d fleet entities", len(entityIDs))
	t.Logf("  - %d mission tasks (1 completed, 1 failed, 1 acknowledged)", len(taskIDs))
	t.Logf("  - 3 capture objects")
}

func createQueryTestEntity(ctx context.Context, t *testing.T, client *APIClient, entityID string) {
	t.Helper()
	entityPayload := map[string]interface{}{
		"entity_id":   entityID,
		"entity_type": "asset",
		"subtype":     "query-page-test",
	}
	resp, err := client.Post(ctx, "/entities", entityPayload)
	if err != nil {
		t.Fatalf("create entity %s: %v", entityID, err)
	}
	requireHTTPStatus(t, resp, http.StatusCreated, "POST /entities (query pagination)")
	if err := resp.Body.Close(); err != nil {
		t.Fatalf("close entity body: %v", err)
	}
}

func createQueryTestTask(ctx context.Context, t *testing.T, client *APIClient, taskID, entityID string) {
	t.Helper()
	taskPayload := map[string]interface{}{
		"task_id":   taskID,
		"entity_id": entityID,
		"status":    "pending",
	}
	resp, err := client.Post(ctx, "/tasks", taskPayload)
	if err != nil {
		t.Fatalf("create task %s: %v", taskID, err)
	}
	requireHTTPStatus(t, resp, http.StatusCreated, "POST /tasks (query pagination)")
	if err := resp.Body.Close(); err != nil {
		t.Fatalf("close task body: %v", err)
	}
}

func createQueryTestObject(ctx context.Context, t *testing.T, client *APIClient, objectID, entityID, taskID string) {
	t.Helper()
	objectPayload := map[string]interface{}{
		"object_id":    objectID,
		"content_type": "application/json",
		"type":         "query-page-test",
		"referenced_by": []map[string]interface{}{
			{"entity_id": entityID},
			{"task_id": taskID},
		},
	}
	resp, err := client.Post(ctx, "/objects", objectPayload)
	if err != nil {
		t.Fatalf("create object %s: %v", objectID, err)
	}
	requireHTTPStatus(t, resp, http.StatusCreated, "POST /objects (query pagination)")
	if err := resp.Body.Close(); err != nil {
		t.Fatalf("close object body: %v", err)
	}
}

func mustInterfaceSlice(t *testing.T, raw interface{}, label string) []interface{} {
	t.Helper()
	if raw == nil {
		return []interface{}{}
	}
	items, ok := raw.([]interface{})
	if !ok {
		t.Fatalf("expected %s array, got %T", label, raw)
	}
	return items
}

func findChangeEvent(events []interface{}, resourceType, id, eventType string) map[string]interface{} {
	for _, raw := range events {
		event, ok := raw.(map[string]interface{})
		if !ok || event["resource_type"] != resourceType || event["id"] != id {
			continue
		}
		if eventType == "" || event["event"] == eventType {
			return event
		}
	}
	return nil
}

func mustStringField(t *testing.T, raw interface{}, field string) string {
	t.Helper()
	item, ok := raw.(map[string]interface{})
	if !ok {
		t.Fatalf("expected object for %s lookup, got %T", field, raw)
	}
	value, ok := item[field].(string)
	if !ok {
		t.Fatalf("expected string field %s, got %T", field, item[field])
	}
	return value
}

func mustVersionFromMetadata(t *testing.T, metadata map[string]interface{}) int64 {
	t.Helper()
	raw, ok := metadata["version"].(float64)
	if !ok || raw <= 0 {
		t.Fatalf("expected positive metadata.version, got %#v", metadata["version"])
	}
	return int64(raw)
}
