package integration

import (
	"context"
	"fmt"
	"net/http"
	"testing"
)

func TestStaleIfMatchRejectsEntityPatch(t *testing.T) {
	SkipIfSystemNotAvailable(t)

	client := NewAPIClient()
	ctx := context.Background()
	entityID := fmt.Sprintf("%s-ifmatch-entity-patch", TestArtifactPrefix())

	staleETag := createIfMatchEntity(ctx, t, client, entityID)
	baselineAlias := "Baseline entity"
	baseline := patchEntity(ctx, t, client, entityID, map[string]interface{}{
		"alias": baselineAlias,
		"extra": map[string]interface{}{
			"marker": "baseline",
		},
	}, nil)

	resp, err := client.PatchWithHeaders(ctx, "/entities/"+entityID, map[string]interface{}{
		"alias": "Stale entity",
		"extra": map[string]interface{}{
			"marker": "stale",
		},
	}, ifMatchHeader(staleETag))
	if err != nil {
		t.Fatalf("stale entity PATCH: %v", err)
	}
	defer drainClose(resp)
	requirePreconditionFailed(t, resp, "stale entity PATCH")

	after := getMapResource(ctx, t, client, "/entities/"+entityID)
	requireSameVersion(t, after, metadataVersion(t, baseline), "entity after stale PATCH")
	if after["alias"] != baselineAlias {
		t.Fatalf("entity alias mutated after stale PATCH: %v", after["alias"])
	}
	requireNestedString(t, after, "extra", "marker", "baseline")
}

func TestStaleIfMatchRejectsEntityCheckin(t *testing.T) {
	SkipIfSystemNotAvailable(t)

	client := NewAPIClient()
	ctx := context.Background()
	entityID := fmt.Sprintf("%s-ifmatch-entity-checkin", TestArtifactPrefix())

	staleETag := createIfMatchEntity(ctx, t, client, entityID)
	baseline := patchEntity(ctx, t, client, entityID, map[string]interface{}{
		"extra": map[string]interface{}{
			"marker": "baseline",
		},
	}, nil)

	resp, err := client.PostWithHeaders(ctx, "/entities/"+entityID+"/checkin", map[string]interface{}{
		"status":    "active",
		"latitude":  40.75,
		"longitude": -73.99,
	}, ifMatchHeader(staleETag))
	if err != nil {
		t.Fatalf("stale entity checkin: %v", err)
	}
	defer drainClose(resp)
	requirePreconditionFailed(t, resp, "stale entity checkin")

	after := getMapResource(ctx, t, client, "/entities/"+entityID)
	requireSameVersion(t, after, metadataVersion(t, baseline), "entity after stale checkin")
	requireNestedString(t, after, "extra", "marker", "baseline")
	components, ok := after["components"].(map[string]interface{})
	if !ok {
		t.Fatalf("expected entity components map, got %T", after["components"])
	}
	if _, ok := components["heartbeat"]; ok {
		t.Fatalf("stale checkin unexpectedly wrote heartbeat: %#v", components["heartbeat"])
	}
	if _, ok := components["telemetry"]; ok {
		t.Fatalf("stale checkin unexpectedly wrote telemetry: %#v", components["telemetry"])
	}
}

func TestStaleIfMatchRejectsTaskPatch(t *testing.T) {
	SkipIfSystemNotAvailable(t)

	client := NewAPIClient()
	ctx := context.Background()
	taskID := fmt.Sprintf("%s-ifmatch-task-patch", TestArtifactPrefix())

	staleETag := createIfMatchTask(ctx, t, client, taskID)
	baseline := patchTask(ctx, t, client, taskID, map[string]interface{}{
		"extra": map[string]interface{}{
			"marker": "baseline",
		},
	}, nil)

	resp, err := client.PatchWithHeaders(ctx, "/tasks/"+taskID, map[string]interface{}{
		"extra": map[string]interface{}{
			"marker": "stale",
		},
	}, ifMatchHeader(staleETag))
	if err != nil {
		t.Fatalf("stale task PATCH: %v", err)
	}
	defer drainClose(resp)
	requirePreconditionFailed(t, resp, "stale task PATCH")

	after := getMapResource(ctx, t, client, "/tasks/"+taskID)
	requireSameVersion(t, after, metadataVersion(t, baseline), "task after stale PATCH")
	if after["status"] != "pending" {
		t.Fatalf("task status mutated after stale PATCH: %v", after["status"])
	}
	requireNestedString(t, after, "extra", "marker", "baseline")
}

func TestStaleIfMatchRejectsTaskStatusEndpoints(t *testing.T) {
	SkipIfSystemNotAvailable(t)

	client := NewAPIClient()
	ctx := context.Background()
	prefix := TestArtifactPrefix()

	tests := []struct {
		name   string
		suffix string
		body   interface{}
	}{
		{name: "acknowledge", suffix: "/acknowledge"},
		{name: "complete", suffix: "/complete", body: map[string]interface{}{
			"result": map[string]interface{}{"success": true},
		}},
		{name: "fail", suffix: "/fail", body: map[string]interface{}{
			"error": map[string]interface{}{"code": "STALE", "message": "ignored"},
		}},
		{name: "status", suffix: "/status", body: map[string]interface{}{
			"status":   "acknowledged",
			"progress": 25.0,
			"message":  "ignored",
		}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			taskID := fmt.Sprintf("%s-ifmatch-task-%s", prefix, tt.name)
			staleETag := createIfMatchTask(ctx, t, client, taskID)
			baseline := patchTask(ctx, t, client, taskID, map[string]interface{}{
				"extra": map[string]interface{}{
					"marker": tt.name + "-baseline",
				},
			}, nil)

			resp, err := client.PostWithHeaders(ctx, "/tasks/"+taskID+tt.suffix, tt.body, ifMatchHeader(staleETag))
			if err != nil {
				t.Fatalf("stale task %s: %v", tt.name, err)
			}
			defer drainClose(resp)
			requirePreconditionFailed(t, resp, "stale task "+tt.name)

			after := getMapResource(ctx, t, client, "/tasks/"+taskID)
			requireSameVersion(t, after, metadataVersion(t, baseline), "task after stale "+tt.name)
			if after["status"] != "pending" {
				t.Fatalf("task status mutated after stale %s: %v", tt.name, after["status"])
			}
			requireNestedString(t, after, "extra", "marker", tt.name+"-baseline")
		})
	}
}

func TestStaleIfMatchRejectsObjectPatch(t *testing.T) {
	SkipIfSystemNotAvailable(t)

	client := NewAPIClient()
	ctx := context.Background()
	objectID := fmt.Sprintf("%s-ifmatch-object-patch", TestArtifactPrefix())

	staleETag := createIfMatchObject(ctx, t, client, objectID)
	baseline := patchObject(ctx, t, client, objectID, map[string]interface{}{
		"extra": map[string]interface{}{
			"description": "baseline",
		},
	}, nil)

	resp, err := client.PatchWithHeaders(ctx, "/objects/"+objectID, map[string]interface{}{
		"extra": map[string]interface{}{
			"description": "stale",
		},
	}, ifMatchHeader(staleETag))
	if err != nil {
		t.Fatalf("stale object PATCH: %v", err)
	}
	defer drainClose(resp)
	requirePreconditionFailed(t, resp, "stale object PATCH")

	after := getMapResource(ctx, t, client, "/objects/"+objectID)
	requireSameVersion(t, after, metadataVersion(t, baseline), "object after stale PATCH")
	requireNestedString(t, after, "payload", "description", "baseline")
}

func createIfMatchEntity(ctx context.Context, t *testing.T, client *APIClient, entityID string) string {
	t.Helper()

	resp, err := client.Post(ctx, "/entities", map[string]interface{}{
		"entity_id":   entityID,
		"entity_type": "asset",
		"subtype":     "ifmatch-test",
	})
	if err != nil {
		t.Fatalf("create entity: %v", err)
	}
	requireHTTPStatus(t, resp, http.StatusCreated, "POST /entities")
	etag := requireETag(t, resp, "POST /entities")
	drainClose(resp)
	return etag
}

func createIfMatchTask(ctx context.Context, t *testing.T, client *APIClient, taskID string) string {
	t.Helper()

	resp, err := client.Post(ctx, "/tasks", map[string]interface{}{
		"task_id": taskID,
		"status":  "pending",
	})
	if err != nil {
		t.Fatalf("create task: %v", err)
	}
	requireHTTPStatus(t, resp, http.StatusCreated, "POST /tasks")
	etag := requireETag(t, resp, "POST /tasks")
	drainClose(resp)
	return etag
}

func createIfMatchObject(ctx context.Context, t *testing.T, client *APIClient, objectID string) string {
	t.Helper()

	path := fmt.Sprintf("objects/%s/ifmatch.json", objectID)
	resp, err := client.Post(ctx, "/objects", map[string]interface{}{
		"object_id":    objectID,
		"path":         path,
		"content_type": "application/json",
		"type":         "ifmatch-test",
		"size_bytes":   1,
	})
	if err != nil {
		t.Fatalf("create object: %v", err)
	}
	requireHTTPStatus(t, resp, http.StatusCreated, "POST /objects")
	etag := requireETag(t, resp, "POST /objects")
	drainClose(resp)
	return etag
}

func patchEntity(ctx context.Context, t *testing.T, client *APIClient, entityID string, body interface{}, headers map[string]string) map[string]interface{} {
	t.Helper()
	resp, err := client.PatchWithHeaders(ctx, "/entities/"+entityID, body, headers)
	if err != nil {
		t.Fatalf("PATCH /entities/%s: %v", entityID, err)
	}
	requireHTTPStatus(t, resp, http.StatusOK, "PATCH /entities/{id}")
	var resource map[string]interface{}
	if err := ParseResponse(resp, &resource); err != nil {
		t.Fatalf("parse entity PATCH response: %v", err)
	}
	return resource
}

func patchTask(ctx context.Context, t *testing.T, client *APIClient, taskID string, body interface{}, headers map[string]string) map[string]interface{} {
	t.Helper()
	resp, err := client.PatchWithHeaders(ctx, "/tasks/"+taskID, body, headers)
	if err != nil {
		t.Fatalf("PATCH /tasks/%s: %v", taskID, err)
	}
	requireHTTPStatus(t, resp, http.StatusOK, "PATCH /tasks/{id}")
	var resource map[string]interface{}
	if err := ParseResponse(resp, &resource); err != nil {
		t.Fatalf("parse task PATCH response: %v", err)
	}
	return resource
}

func patchObject(ctx context.Context, t *testing.T, client *APIClient, objectID string, body interface{}, headers map[string]string) map[string]interface{} {
	t.Helper()
	resp, err := client.PatchWithHeaders(ctx, "/objects/"+objectID, body, headers)
	if err != nil {
		t.Fatalf("PATCH /objects/%s: %v", objectID, err)
	}
	requireHTTPStatus(t, resp, http.StatusOK, "PATCH /objects/{id}")
	var resource map[string]interface{}
	if err := ParseResponse(resp, &resource); err != nil {
		t.Fatalf("parse object PATCH response: %v", err)
	}
	return resource
}

func getMapResource(ctx context.Context, t *testing.T, client *APIClient, path string) map[string]interface{} {
	t.Helper()
	resp, err := client.Get(ctx, path)
	if err != nil {
		t.Fatalf("GET %s: %v", path, err)
	}
	requireHTTPStatus(t, resp, http.StatusOK, "GET "+path)
	var resource map[string]interface{}
	if err := ParseResponse(resp, &resource); err != nil {
		t.Fatalf("parse GET %s response: %v", path, err)
	}
	return resource
}

func requirePreconditionFailed(t *testing.T, resp *http.Response, label string) {
	t.Helper()
	requireHTTPStatus(t, resp, http.StatusPreconditionFailed, label)
	var body map[string]interface{}
	if err := ParseResponse(resp, &body); err != nil {
		t.Fatalf("%s: parse error body: %v", label, err)
	}
	if body["error_code"] != "PRECONDITION_FAILED" {
		t.Fatalf("%s: expected PRECONDITION_FAILED, got %v", label, body["error_code"])
	}
}

func requireETag(t *testing.T, resp *http.Response, label string) string {
	t.Helper()
	etag := resp.Header.Get("ETag")
	if etag == "" {
		t.Fatalf("%s: expected ETag header", label)
	}
	return etag
}

func ifMatchHeader(etag string) map[string]string {
	return map[string]string{"If-Match": etag}
}

func metadataVersion(t *testing.T, resource map[string]interface{}) int64 {
	t.Helper()
	metadata, ok := resource["metadata"].(map[string]interface{})
	if !ok {
		t.Fatalf("expected metadata map, got %T", resource["metadata"])
	}
	version, ok := metadata["version"].(float64)
	if !ok {
		t.Fatalf("expected metadata.version number, got %T", metadata["version"])
	}
	return int64(version)
}

func requireSameVersion(t *testing.T, resource map[string]interface{}, want int64, label string) {
	t.Helper()
	if got := metadataVersion(t, resource); got != want {
		t.Fatalf("%s: version changed to %d, want %d", label, got, want)
	}
}

func requireNestedString(t *testing.T, resource map[string]interface{}, parent, key, want string) {
	t.Helper()
	fields, ok := resource[parent].(map[string]interface{})
	if !ok {
		t.Fatalf("expected %s map, got %T", parent, resource[parent])
	}
	if got := fields[key]; got != want {
		t.Fatalf("expected %s.%s %q, got %v", parent, key, want, got)
	}
}
