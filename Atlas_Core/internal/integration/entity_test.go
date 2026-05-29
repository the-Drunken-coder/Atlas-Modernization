package integration

import (
	"context"
	"fmt"
	"net/http"
	"testing"
	"time"
)

// TestHealthEndpoint tests the /health endpoint
func TestHealthEndpoint(t *testing.T) {
	SkipIfSystemNotAvailable(t)

	client := NewAPIClient()
	ctx := context.Background()

	resp, err := client.Get(ctx, "/health")
	if err != nil {
		t.Fatalf("Failed to call /health: %v", err)
	}
	defer drainClose(resp)

	if resp.StatusCode != http.StatusOK {
		t.Errorf("Expected 200, got %d", resp.StatusCode)
	}

	var result map[string]interface{}
	if err := ParseResponse(resp, &result); err != nil {
		t.Fatalf("Failed to parse response: %v", err)
	}

	if result["status"] != "healthy" {
		t.Errorf("Expected status 'healthy', got %v", result["status"])
	}
	if result["service"] != "atlas-core" {
		t.Errorf("Expected service 'atlas-core', got %v", result["service"])
	}
	if _, ok := result["checks"]; ok {
		t.Error("Liveness response should not include dependency checks")
	}

	t.Logf("Health check passed: %v", result)
}

// TestReadinessEndpoint tests the /readiness endpoint
func TestReadinessEndpoint(t *testing.T) {
	SkipIfSystemNotAvailable(t)

	client := NewAPIClient()
	ctx := context.Background()

	resp, err := client.Get(ctx, "/readiness")
	if err != nil {
		t.Fatalf("Failed to call /readiness: %v", err)
	}
	defer drainClose(resp)

	if resp.StatusCode != http.StatusOK {
		t.Errorf("Expected 200, got %d", resp.StatusCode)
	}

	var result map[string]interface{}
	if err := ParseResponse(resp, &result); err != nil {
		t.Fatalf("Failed to parse response: %v", err)
	}

	if result["status"] != "healthy" && result["status"] != "degraded" {
		t.Errorf("Expected status 'healthy' or 'degraded', got %v", result["status"])
	}
	if result["service"] != "atlas-core" {
		t.Errorf("Expected service 'atlas-core', got %v", result["service"])
	}

	checks, ok := result["checks"].(map[string]interface{})
	if !ok {
		t.Fatalf("Expected checks object in readiness response, got %T", result["checks"])
	}
	if _, ok := checks["database"]; !ok {
		t.Error("Expected database check in readiness response")
	}
	if _, ok := checks["storage"]; !ok {
		t.Error("Expected storage check in readiness response")
	}
}

// TestRootEndpoint tests the / endpoint
func TestRootEndpoint(t *testing.T) {
	SkipIfSystemNotAvailable(t)

	client := NewAPIClient()
	ctx := context.Background()

	resp, err := client.Get(ctx, "/")
	if err != nil {
		t.Fatalf("Failed to call /: %v", err)
	}
	defer drainClose(resp)

	if resp.StatusCode != http.StatusOK {
		t.Errorf("Expected 200, got %d", resp.StatusCode)
	}

	var result map[string]interface{}
	if err := ParseResponse(resp, &result); err != nil {
		t.Fatalf("Failed to parse response: %v", err)
	}

	if result["name"] != "ATLAS Core API" {
		t.Errorf("Expected name 'ATLAS Core API', got %v", result["name"])
	}

	t.Logf("Root endpoint: %v", result)
}

// TestCreateEntityDuplicateReturnsConflict verifies a second POST with the same entity_id returns 409.
func TestCreateEntityDuplicateReturnsConflict(t *testing.T) {
	SkipIfSystemNotAvailable(t)

	client := NewAPIClient()
	ctx := context.Background()
	prefix := TestArtifactPrefix()
	entityID := fmt.Sprintf("%s-entity-dup", prefix)

	createPayload := map[string]interface{}{
		"entity_id":   entityID,
		"entity_type": "asset",
		"subtype":     "test",
		"alias":       fmt.Sprintf("Dup Test %s", prefix),
	}

	{
		resp, err := client.Post(ctx, "/entities", createPayload)
		if err != nil {
			t.Fatalf("Failed to create entity: %v", err)
		}
		defer drainClose(resp)
		if resp.StatusCode != http.StatusCreated {
			t.Fatalf("Expected 201 on first create, got %d", resp.StatusCode)
		}
	}

	{
		resp, err := client.Post(ctx, "/entities", createPayload)
		if err != nil {
			t.Fatalf("Failed second POST: %v", err)
		}
		defer drainClose(resp)
		if resp.StatusCode != http.StatusConflict {
			t.Fatalf("Expected 409 Conflict on duplicate create, got %d", resp.StatusCode)
		}
		var body map[string]interface{}
		if err := ParseResponse(resp, &body); err != nil {
			t.Fatalf("parse body: %v", err)
		}
		if body["error_code"] != "ENTITY_ALREADY_EXISTS" {
			t.Fatalf("Expected ENTITY_ALREADY_EXISTS, got %v", body["error_code"])
		}
	}
}

// TestEntityLifecycle tests creating, reading, updating, and keeping an entity artifact
func TestEntityLifecycle(t *testing.T) {
	SkipIfSystemNotAvailable(t)

	client := NewAPIClient()
	ctx := context.Background()
	prefix := TestArtifactPrefix()

	// This entity will be left as an artifact
	entityID := fmt.Sprintf("%s-entity-lifecycle", prefix)

	// Create entity
	createPayload := map[string]interface{}{
		"entity_id":   entityID,
		"entity_type": "asset",
		"subtype":     "test-drone",
		"alias":       fmt.Sprintf("Test Drone %s", prefix),
		"components": map[string]interface{}{
			"telemetry": map[string]interface{}{
				"latitude":  40.7128,
				"longitude": -74.0060,
			},
		},
	}

	{
		resp, err := client.Post(ctx, "/entities", createPayload)
		if err != nil {
			t.Fatalf("Failed to create entity: %v", err)
		}
		defer drainClose(resp)

		if resp.StatusCode != http.StatusCreated {
			t.Fatalf("Expected 201, got %d", resp.StatusCode)
		}

		var created map[string]interface{}
		if err := ParseResponse(resp, &created); err != nil {
			t.Fatalf("Failed to parse created entity: %v", err)
		}

		t.Logf("Created entity artifact: %s", entityID)
	}

	// Read entity
	var fetched map[string]interface{}
	{
		resp, err := client.Get(ctx, "/entities/"+entityID)
		if err != nil {
			t.Fatalf("Failed to get entity: %v", err)
		}
		defer drainClose(resp)

		if resp.StatusCode != http.StatusOK {
			t.Fatalf("Expected 200, got %d", resp.StatusCode)
		}

		if err := ParseResponse(resp, &fetched); err != nil {
			t.Fatalf("Failed to parse fetched entity: %v", err)
		}
	}

	if fetched["entity_id"] != entityID {
		t.Errorf("Expected entity_id %s, got %v", entityID, fetched["entity_id"])
	}

	// Update entity
	updatePayload := map[string]interface{}{
		"components": map[string]interface{}{
			"telemetry": map[string]interface{}{
				"latitude":   40.7589,
				"longitude":  -73.9851,
				"altitude_m": 100.0,
			},
		},
	}

	var updated map[string]interface{}
	{
		resp, err := client.Patch(ctx, "/entities/"+entityID, updatePayload)
		if err != nil {
			t.Fatalf("Failed to update entity: %v", err)
		}
		defer drainClose(resp)
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("Expected 200, got %d", resp.StatusCode)
		}

		if err := ParseResponse(resp, &updated); err != nil {
			t.Fatalf("Failed to parse updated entity: %v", err)
		}
	}

	components, ok := updated["components"].(map[string]interface{})
	if !ok {
		t.Fatalf("Expected updated components object, got %T", updated["components"])
	}
	telemetry, ok := components["telemetry"].(map[string]interface{})
	if !ok {
		t.Fatalf("Expected telemetry object, got %T", components["telemetry"])
	}
	if telemetry["latitude"] != 40.7589 {
		t.Fatalf("Expected latitude 40.7589, got %v", telemetry["latitude"])
	}
	if telemetry["longitude"] != -73.9851 {
		t.Fatalf("Expected longitude -73.9851, got %v", telemetry["longitude"])
	}
	if telemetry["altitude_m"] != 100.0 {
		t.Fatalf("Expected altitude_m 100, got %v", telemetry["altitude_m"])
	}

	t.Logf("Entity %s updated and left as artifact in system", entityID)
}

// TestTrackEntitySignalSubtype ensures track entities preserve subtype "signal".
func TestTrackEntitySignalSubtype(t *testing.T) {
	SkipIfSystemNotAvailable(t)

	client := NewAPIClient()
	ctx := context.Background()
	prefix := TestArtifactPrefix()
	entityID := fmt.Sprintf("%s-track-signal", prefix)

	createPayload := map[string]interface{}{
		"entity_id":   entityID,
		"entity_type": "track",
		"subtype":     "signal",
		"alias":       fmt.Sprintf("Signal Track %s", prefix),
		"components": map[string]interface{}{
			"telemetry": map[string]interface{}{
				"latitude":  40.7128,
				"longitude": -74.0060,
			},
		},
	}

	createResp, err := client.Post(ctx, "/entities", createPayload)
	if err != nil {
		t.Fatalf("Failed to create track entity: %v", err)
	}
	defer createResp.Body.Close()
	if createResp.StatusCode != http.StatusCreated {
		t.Fatalf("Expected 201, got %d", createResp.StatusCode)
	}

	resp, err := client.Get(ctx, "/entities/"+entityID)
	if err != nil {
		t.Fatalf("Failed to get track entity: %v", err)
	}
	defer drainClose(resp)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("Expected 200, got %d", resp.StatusCode)
	}

	var fetched map[string]interface{}
	if err := ParseResponse(resp, &fetched); err != nil {
		t.Fatalf("Failed to parse fetched entity: %v", err)
	}

	if fetched["entity_id"] != entityID {
		t.Errorf("Expected entity_id %s, got %v", entityID, fetched["entity_id"])
	}
	if fetched["type"] != "track" {
		t.Errorf("Expected type track, got %v", fetched["type"])
	}
	if fetched["subtype"] != "signal" {
		t.Errorf("Expected subtype signal, got %v", fetched["subtype"])
	}
}

// TestEntityTelemetryUpdate tests updating entity telemetry
func TestEntityTelemetryUpdate(t *testing.T) {
	SkipIfSystemNotAvailable(t)

	client := NewAPIClient()
	ctx := context.Background()
	prefix := TestArtifactPrefix()

	// Create entity first
	entityID := fmt.Sprintf("%s-telemetry-test", prefix)

	createPayload := map[string]interface{}{
		"entity_id":   entityID,
		"entity_type": "asset",
		"subtype":     "drone",
	}

	resp, err := client.Post(ctx, "/entities", createPayload)
	if err != nil {
		t.Fatalf("Failed to create entity: %v", err)
	}

	if resp.StatusCode != http.StatusCreated {
		_ = resp.Body.Close()
		t.Fatalf("Expected 201, got %d", resp.StatusCode)
	}
	resp.Body.Close()

	// Update telemetry
	telemetryPayload := map[string]interface{}{
		"latitude":    40.7128,
		"longitude":   -74.0060,
		"altitude_m":  50.0,
		"speed_m_s":   10.5,
		"heading_deg": 45.0,
	}

	resp, err = client.Patch(ctx, "/entities/"+entityID+"/telemetry", telemetryPayload)
	if err != nil {
		t.Fatalf("Failed to update telemetry: %v", err)
	}

	if resp.StatusCode != http.StatusOK {
		_ = resp.Body.Close()
		t.Fatalf("Expected 200, got %d", resp.StatusCode)
	}
	resp.Body.Close()

	resp, err = client.Get(ctx, "/entities/"+entityID)
	if err != nil {
		t.Fatalf("Failed to get entity after telemetry patch: %v", err)
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		t.Fatalf("Expected 200 on GET entity, got %d", resp.StatusCode)
	}
	var got map[string]interface{}
	if err := ParseResponse(resp, &got); err != nil {
		t.Fatalf("Failed to parse entity: %v", err)
	}
	comp, ok := got["components"].(map[string]interface{})
	if !ok {
		t.Fatalf("expected components object, got %T", got["components"])
	}
	tel, ok := comp["telemetry"].(map[string]interface{})
	if !ok {
		t.Fatalf("expected telemetry in components, got %T", comp["telemetry"])
	}
	if lat, ok := tel["latitude"].(float64); !ok || lat != 40.7128 {
		t.Fatalf("expected telemetry.latitude 40.7128, got %v (%T)", tel["latitude"], tel["latitude"])
	}
	if lng, ok := tel["longitude"].(float64); !ok || lng != -74.0060 {
		t.Fatalf("expected telemetry.longitude -74.0060, got %v (%T)", tel["longitude"], tel["longitude"])
	}
	if alt, ok := tel["altitude_m"].(float64); !ok || alt != 50.0 {
		t.Fatalf("expected telemetry.altitude_m 50.0, got %v (%T)", tel["altitude_m"], tel["altitude_m"])
	}
	if speed, ok := tel["speed_m_s"].(float64); !ok || speed != 10.5 {
		t.Fatalf("expected telemetry.speed_m_s 10.5, got %v (%T)", tel["speed_m_s"], tel["speed_m_s"])
	}
	if heading, ok := tel["heading_deg"].(float64); !ok || heading != 45.0 {
		t.Fatalf("expected telemetry.heading_deg 45.0, got %v (%T)", tel["heading_deg"], tel["heading_deg"])
	}

	t.Logf("Entity %s with telemetry left as artifact", entityID)
}

// TestEntityCheckin tests the entity checkin endpoint
func TestEntityCheckin(t *testing.T) {
	SkipIfSystemNotAvailable(t)

	client := NewAPIClient()
	ctx := context.Background()
	prefix := TestArtifactPrefix()

	// Create entity first
	entityID := fmt.Sprintf("%s-checkin-test", prefix)

	createPayload := map[string]interface{}{
		"entity_id":   entityID,
		"entity_type": "asset",
		"subtype":     "rover",
	}

	resp, err := client.Post(ctx, "/entities", createPayload)
	if err != nil {
		t.Fatalf("Failed to create entity: %v", err)
	}

	if resp.StatusCode != http.StatusCreated {
		_ = resp.Body.Close()
		t.Fatalf("Expected 201, got %d", resp.StatusCode)
	}
	resp.Body.Close()

	// Create tasks for the entity and another entity to validate checkin filtering.
	pendingTaskID := fmt.Sprintf("%s-checkin-pending", prefix)
	pendingTaskPayload := map[string]interface{}{
		"task_id":   pendingTaskID,
		"entity_id": entityID,
		"status":    "pending",
		"components": map[string]interface{}{
			"command": map[string]interface{}{
				"type": "move_to_location",
			},
			"parameters": map[string]interface{}{
				"latitude":  40.73061,
				"longitude": -73.935242,
				"altitude":  50,
			},
		},
	}
	resp, err = client.Post(ctx, "/tasks", pendingTaskPayload)
	if err != nil {
		t.Fatalf("Failed to create pending checkin task: %v", err)
	}
	if resp.StatusCode != http.StatusCreated {
		_ = resp.Body.Close()
		t.Fatalf("Expected 201 creating pending task, got %d", resp.StatusCode)
	}
	resp.Body.Close()

	completedTaskPayload := map[string]interface{}{
		"task_id":   fmt.Sprintf("%s-checkin-completed", prefix),
		"entity_id": entityID,
		"status":    "completed",
	}
	resp, err = client.Post(ctx, "/tasks", completedTaskPayload)
	if err != nil {
		t.Fatalf("Failed to create completed checkin task: %v", err)
	}
	if resp.StatusCode != http.StatusCreated {
		_ = resp.Body.Close()
		t.Fatalf("Expected 201 creating completed task, got %d", resp.StatusCode)
	}
	resp.Body.Close()

	otherEntityID := fmt.Sprintf("%s-checkin-other", prefix)
	otherEntityPayload := map[string]interface{}{
		"entity_id":   otherEntityID,
		"entity_type": "asset",
		"subtype":     "rover",
	}
	resp, err = client.Post(ctx, "/entities", otherEntityPayload)
	if err != nil {
		t.Fatalf("Failed to create secondary entity: %v", err)
	}
	if resp.StatusCode != http.StatusCreated {
		_ = resp.Body.Close()
		t.Fatalf("Expected 201 creating secondary entity, got %d", resp.StatusCode)
	}
	resp.Body.Close()

	otherTaskPayload := map[string]interface{}{
		"task_id":   fmt.Sprintf("%s-checkin-other-task", prefix),
		"entity_id": otherEntityID,
		"status":    "pending",
	}
	resp, err = client.Post(ctx, "/tasks", otherTaskPayload)
	if err != nil {
		t.Fatalf("Failed to create secondary entity task: %v", err)
	}
	if resp.StatusCode != http.StatusCreated {
		_ = resp.Body.Close()
		t.Fatalf("Expected 201 creating secondary task, got %d", resp.StatusCode)
	}
	resp.Body.Close()

	// Perform checkin
	checkinPayload := map[string]interface{}{
		"status":     "active",
		"latitude":   40.7128,
		"longitude":  -74.0060,
		"altitude_m": 0.0,
	}

	resp, err = client.Post(ctx, "/entities/"+entityID+"/checkin?status_filter=pending,acknowledged&limit=10&fields=minimal", checkinPayload)
	if err != nil {
		t.Fatalf("Failed to checkin: %v", err)
	}
	defer drainClose(resp)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("Expected 200, got %d", resp.StatusCode)
	}

	var result map[string]interface{}
	if err := ParseResponse(resp, &result); err != nil {
		t.Fatalf("Failed to parse checkin response: %v", err)
	}

	rawEntity, hasEntity := result["entity"]
	if !hasEntity || rawEntity == nil {
		t.Fatalf("Expected entity in checkin response")
	}

	rawTasks, hasTasks := result["tasks"]
	if !hasTasks {
		t.Fatalf("Expected tasks in checkin response")
	}
	tasks, ok := rawTasks.([]interface{})
	if !ok {
		t.Fatalf("Expected tasks to be an array, got %T", rawTasks)
	}
	if len(tasks) != 1 {
		t.Fatalf("Expected exactly one pending/acknowledged task, got %d", len(tasks))
	}

	task, ok := tasks[0].(map[string]interface{})
	if !ok {
		t.Fatalf("Expected task item to be an object, got %T", tasks[0])
	}
	if task["task_id"] != pendingTaskID {
		t.Fatalf("Expected pending task_id %s, got %v", pendingTaskID, task["task_id"])
	}
	if task["command_id"] != "move_to_location" {
		t.Fatalf("Expected minimal command_id move_to_location, got %v", task["command_id"])
	}
	if _, ok := task["parameters"].(map[string]interface{}); !ok {
		t.Fatalf("Expected minimal parameters object in task response")
	}

	if result["task_count"] != float64(1) {
		t.Fatalf("Expected task_count 1, got %v", result["task_count"])
	}
	if result["task_limit"] != float64(10) {
		t.Fatalf("Expected task_limit 10, got %v", result["task_limit"])
	}

	t.Logf("Entity %s checked in and left as artifact", entityID)
}

// TestEntityListPagination tests entity listing with pagination
func TestEntityListPagination(t *testing.T) {
	SkipIfSystemNotAvailable(t)

	client := NewAPIClient()
	ctx := context.Background()

	resp, err := client.Get(ctx, "/entities?limit=10&offset=0")
	if err != nil {
		t.Fatalf("Failed to list entities: %v", err)
	}
	defer drainClose(resp)

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("Expected 200, got %d", resp.StatusCode)
	}

	// Check pagination headers
	totalCount := resp.Header.Get("X-Total-Count")
	if totalCount == "" {
		t.Error("Expected X-Total-Count header")
	}

	limit := resp.Header.Get("X-Limit")
	if limit != "10" {
		t.Errorf("Expected X-Limit '10', got '%s'", limit)
	}

	offset := resp.Header.Get("X-Offset")
	if offset != "0" {
		t.Errorf("Expected X-Offset '0', got '%s'", offset)
	}

	t.Logf("Entity list pagination: total=%s, limit=%s, offset=%s", totalCount, limit, offset)
}

// TestEntityByAlias tests getting an entity by alias
func TestEntityByAlias(t *testing.T) {
	SkipIfSystemNotAvailable(t)

	client := NewAPIClient()
	ctx := context.Background()
	prefix := TestArtifactPrefix()

	// Create entity with alias
	entityID := fmt.Sprintf("%s-alias-test", prefix)
	alias := fmt.Sprintf("alias-%s", prefix)

	createPayload := map[string]interface{}{
		"entity_id":   entityID,
		"entity_type": "asset",
		"subtype":     "sensor",
		"alias":       alias,
	}

	resp, err := client.Post(ctx, "/entities", createPayload)
	if err != nil {
		t.Fatalf("Failed to create entity: %v", err)
	}
	if resp.StatusCode != http.StatusCreated {
		_ = resp.Body.Close()
		t.Fatalf("Expected 201, got %d", resp.StatusCode)
	}
	_ = resp.Body.Close()

	// Get by alias
	resp, err = client.Get(ctx, "/entities/alias/"+alias)
	if err != nil {
		t.Fatalf("Failed to get entity by alias: %v", err)
	}

	if resp.StatusCode != http.StatusOK {
		_ = resp.Body.Close()
		t.Fatalf("Expected 200, got %d", resp.StatusCode)
	}

	var result map[string]interface{}
	if err := ParseResponse(resp, &result); err != nil {
		t.Fatalf("Failed to parse response: %v", err)
	}

	if result["entity_id"] != entityID {
		t.Errorf("Expected entity_id %s, got %v", entityID, result["entity_id"])
	}

	t.Logf("Entity %s with alias %s left as artifact", entityID, alias)
}

// TestEntityNotFound tests 404 response for non-existent entity
func TestEntityNotFound(t *testing.T) {
	SkipIfSystemNotAvailable(t)

	client := NewAPIClient()
	ctx := context.Background()

	resp, err := client.Get(ctx, "/entities/non-existent-entity-"+time.Now().Format("20060102150405"))
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

	if result["error_code"] != "ENTITY_NOT_FOUND" {
		t.Errorf("Expected error_code 'ENTITY_NOT_FOUND', got %v", result["error_code"])
	}
}
