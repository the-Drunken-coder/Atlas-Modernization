package integration

import (
	"context"
	"fmt"
	"net/http"
	"testing"
)

// TestObjectLifecycle tests creating, reading, and keeping an object artifact
func TestObjectLifecycle(t *testing.T) {
	SkipIfSystemNotAvailable(t)

	client := NewAPIClient()
	ctx := context.Background()
	prefix := TestArtifactPrefix()

	// Create object metadata
	objectID := fmt.Sprintf("%s-object-lifecycle", prefix)
	createPayload := map[string]interface{}{
		"object_id":   objectID,
		"type":        "data",
		"usage_hints": []string{"integration-test"},
	}

	respCreate, err := client.Post(ctx, "/objects", createPayload)
	if err != nil {
		t.Fatalf("Failed to create object: %v", err)
	}

	if respCreate.StatusCode != http.StatusCreated {
		_ = respCreate.Body.Close()
		t.Fatalf("Expected 201, got %d", respCreate.StatusCode)
	}

	var created map[string]interface{}
	if err := ParseResponse(respCreate, &created); err != nil {
		t.Fatalf("Failed to parse created object: %v", err)
	}

	t.Logf("Created object artifact: %s", objectID)

	// Read object
	respGet, err := client.Get(ctx, "/objects/"+objectID)
	if err != nil {
		t.Fatalf("Failed to get object: %v", err)
	}

	if respGet.StatusCode != http.StatusOK {
		_ = respGet.Body.Close()
		t.Fatalf("Expected 200, got %d", respGet.StatusCode)
	}

	var fetched map[string]interface{}
	if err := ParseResponse(respGet, &fetched); err != nil {
		t.Fatalf("Failed to parse fetched object: %v", err)
	}

	if fetched["object_id"] != objectID {
		t.Errorf("Expected object_id %s, got %v", objectID, fetched["object_id"])
	}

	// Update object
	updatePayload := map[string]interface{}{
		"extra": map[string]interface{}{
			"description": "Updated by integration test",
		},
	}

	respPatch, err := client.Patch(ctx, "/objects/"+objectID, updatePayload)
	if err != nil {
		t.Fatalf("Failed to update object: %v", err)
	}

	if respPatch.StatusCode != http.StatusOK {
		_ = respPatch.Body.Close()
		t.Fatalf("Expected 200, got %d", respPatch.StatusCode)
	}
	if err := respPatch.Body.Close(); err != nil {
		t.Fatalf("close patch body: %v", err)
	}

	respVerify, err := client.Get(ctx, "/objects/"+objectID)
	if err != nil {
		t.Fatalf("Failed to get object after patch: %v", err)
	}
	if respVerify.StatusCode != http.StatusOK {
		_ = respVerify.Body.Close()
		t.Fatalf("Expected 200 on GET object, got %d", respVerify.StatusCode)
	}
	var after map[string]interface{}
	if err := ParseResponse(respVerify, &after); err != nil {
		t.Fatalf("Failed to parse object: %v", err)
	}
	extra, ok := after["extra"].(map[string]interface{})
	if !ok {
		t.Fatalf("expected extra map, got %T", after["extra"])
	}
	if extra["description"] != "Updated by integration test" {
		t.Fatalf("expected extra.description persisted, got %v", extra["description"])
	}

	t.Logf("Object %s updated and left as artifact in system", objectID)
}

// TestObjectWithReferences tests creating objects with entity/task references
func TestObjectWithReferences(t *testing.T) {
	SkipIfSystemNotAvailable(t)

	client := NewAPIClient()
	ctx := context.Background()
	prefix := TestArtifactPrefix()

	// Create entity to reference
	entityID := fmt.Sprintf("%s-object-ref-entity", prefix)
	entityPayload := map[string]interface{}{
		"entity_id":   entityID,
		"entity_type": "asset",
		"subtype":     "camera",
	}

	resp, err := client.Post(ctx, "/entities", entityPayload)
	if err != nil {
		t.Fatalf("Failed to create entity: %v", err)
	}
	requireHTTPStatus(t, resp, http.StatusCreated, "POST /entities (object refs setup)")
	if err := resp.Body.Close(); err != nil {
		t.Fatalf("close body: %v", err)
	}

	// Object references are descriptive and may name a retained Task without coupling
	// object creation to Task lifecycle setup in the empty production catalog.
	taskID := fmt.Sprintf("%s-object-ref-task", prefix)

	// Create object with references
	objectID := fmt.Sprintf("%s-object-with-refs", prefix)
	createPayload := map[string]interface{}{
		"object_id": objectID,
		"type":      "capture",
		"referenced_by": []map[string]interface{}{
			{"entity_id": entityID},
			{"task_id": taskID},
		},
	}

	resp, err = client.Post(ctx, "/objects", createPayload)
	if err != nil {
		t.Fatalf("Failed to create object: %v", err)
	}
	requireHTTPStatus(t, resp, http.StatusCreated, "POST /objects (with references)")
	if err := resp.Body.Close(); err != nil {
		t.Fatalf("close body: %v", err)
	}

	resp, err = client.Get(ctx, "/objects/"+objectID)
	if err != nil {
		t.Fatalf("Failed to get object with references: %v", err)
	}
	requireHTTPStatus(t, resp, http.StatusOK, "GET /objects (with references)")
	var stored map[string]interface{}
	if err := ParseResponse(resp, &stored); err != nil {
		t.Fatalf("parse object: %v", err)
	}
	refs, ok := stored["referenced_by"].([]interface{})
	if !ok || len(refs) < 2 {
		t.Fatalf("expected referenced_by with 2 entries, got %v", stored["referenced_by"])
	}
	hasEnt, hasTask := false, false
	for _, r := range refs {
		m, ok := r.(map[string]interface{})
		if !ok {
			continue
		}
		if eid, ok := m["entity_id"].(string); ok && eid == entityID {
			hasEnt = true
		}
		if tid, ok := m["task_id"].(string); ok && tid == taskID {
			hasTask = true
		}
	}
	if !hasEnt || !hasTask {
		t.Fatalf("referenced_by missing entity or task ref: %+v", refs)
	}

	t.Logf("Object %s with references to entity %s and task %s left as artifact", objectID, entityID, taskID)
}

// TestObjectsByEntity tests getting objects for a specific entity
func TestObjectsByEntity(t *testing.T) {
	SkipIfSystemNotAvailable(t)

	client := NewAPIClient()
	ctx := context.Background()
	prefix := TestArtifactPrefix()

	// Create entity
	entityID := fmt.Sprintf("%s-objects-by-entity", prefix)
	entityPayload := map[string]interface{}{
		"entity_id":   entityID,
		"entity_type": "asset",
		"subtype":     "sensor",
	}

	resp, err := client.Post(ctx, "/entities", entityPayload)
	if err != nil {
		t.Fatalf("Failed to create entity: %v", err)
	}
	requireHTTPStatus(t, resp, http.StatusCreated, "POST /entities (objects by entity)")
	if err := resp.Body.Close(); err != nil {
		t.Fatalf("close body: %v", err)
	}

	// Create objects referencing the entity
	for i := 1; i <= 3; i++ {
		objectID := fmt.Sprintf("%s-entity-object-%d", prefix, i)
		createPayload := map[string]interface{}{
			"object_id": objectID,
			"type":      "sensor-data",
			"referenced_by": []map[string]interface{}{
				{"entity_id": entityID},
			},
		}

		resp, err = client.Post(ctx, "/objects", createPayload)
		if err != nil {
			t.Fatalf("Failed to create object %d: %v", i, err)
		}
		if resp.StatusCode != http.StatusCreated {
			resp.Body.Close()
			t.Fatalf("Expected 201 for object %d, got %d", i, resp.StatusCode)
		}
		resp.Body.Close()
	}

	// Get objects by entity
	resp, err = client.Get(ctx, "/entities/"+entityID+"/objects")
	if err != nil {
		t.Fatalf("Failed to get objects by entity: %v", err)
	}
	defer drainClose(resp)

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("Expected 200, got %d", resp.StatusCode)
	}

	var objects []map[string]interface{}
	if err := ParseResponse(resp, &objects); err != nil {
		t.Fatalf("Failed to parse objects: %v", err)
	}

	for i := 1; i <= 3; i++ {
		oid := fmt.Sprintf("%s-entity-object-%d", prefix, i)
		found := false
		for _, o := range objects {
			if o["object_id"] == oid {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("objects by entity missing %s", oid)
		}
	}

	t.Logf("Entity %s with %d objects left as artifacts", entityID, len(objects))
}

// TestObjectsByTask tests getting objects for a specific task
func TestObjectsByTask(t *testing.T) {
	SkipIfSystemNotAvailable(t)

	client := NewAPIClient()
	ctx := context.Background()
	prefix := TestArtifactPrefix()

	// The relationship query is driven by descriptive object references. It does not
	// require a mutable Task fixture or a production Command.
	taskID := fmt.Sprintf("%s-objects-by-task", prefix)

	// Create objects referencing the task
	for i := 1; i <= 2; i++ {
		objectID := fmt.Sprintf("%s-task-object-%d", prefix, i)
		createPayload := map[string]interface{}{
			"object_id": objectID,
			"type":      "log",
			"referenced_by": []map[string]interface{}{
				{"task_id": taskID},
			},
		}

		resp, err := client.Post(ctx, "/objects", createPayload)
		if err != nil {
			t.Fatalf("Failed to create object %d: %v", i, err)
		}
		if resp.StatusCode != http.StatusCreated {
			resp.Body.Close()
			t.Fatalf("Expected 201 for object %d, got %d", i, resp.StatusCode)
		}
		resp.Body.Close()
	}

	// Get objects by task
	resp, err := client.Get(ctx, "/tasks/"+taskID+"/objects")
	if err != nil {
		t.Fatalf("Failed to get objects by task: %v", err)
	}
	defer drainClose(resp)

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("Expected 200, got %d", resp.StatusCode)
	}

	var objects []map[string]interface{}
	if err := ParseResponse(resp, &objects); err != nil {
		t.Fatalf("Failed to parse objects: %v", err)
	}

	for i := 1; i <= 2; i++ {
		oid := fmt.Sprintf("%s-task-object-%d", prefix, i)
		found := false
		for _, o := range objects {
			if o["object_id"] == oid {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("objects by task missing %s", oid)
		}
	}

	t.Logf("Task %s with %d objects left as artifacts", taskID, len(objects))
}

// TestObjectListPagination tests object listing with pagination
func TestObjectListPagination(t *testing.T) {
	SkipIfSystemNotAvailable(t)

	client := NewAPIClient()
	ctx := context.Background()

	resp, err := client.Get(ctx, "/objects?limit=10")
	if err != nil {
		t.Fatalf("Failed to list objects: %v", err)
	}
	defer resp.Body.Close()

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

	t.Logf("Object list pagination: limit=%s, returned=%s, has_more=%s, next_cursor=%s", resp.Header.Get("X-Limit"), resp.Header.Get("X-Returned-Count"), resp.Header.Get("X-Has-More"), resp.Header.Get("X-Next-Cursor"))
}

// TestObjectNotFound tests 404 response for non-existent object
func TestObjectNotFound(t *testing.T) {
	SkipIfSystemNotAvailable(t)

	client := NewAPIClient()
	ctx := context.Background()

	resp, err := client.Get(ctx, "/objects/non-existent-object-"+TestArtifactPrefix())
	if err != nil {
		t.Fatalf("Failed to call API: %v", err)
	}
	defer drainClose(resp)

	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("Expected 404, got %d", resp.StatusCode)
	}

	var result map[string]interface{}
	if err := ParseResponse(resp, &result); err != nil {
		t.Fatalf("Failed to parse error response: %v", err)
	}

	if result["error_code"] != "OBJECT_NOT_FOUND" {
		t.Errorf("Expected error_code 'OBJECT_NOT_FOUND', got %v", result["error_code"])
	}
}
