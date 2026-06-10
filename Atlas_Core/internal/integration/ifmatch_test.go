package integration

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestIfMatchPreconditionsForEntityTaskAndObject(t *testing.T) {
	SkipIfSystemNotAvailable(t)

	client := NewAPIClient()
	ctx := context.Background()
	prefix := TestArtifactPrefix()

	entityID := fmt.Sprintf("%s-ifmatch-entity", prefix)
	exerciseIfMatchResource(t, client, ctx, ifMatchResource{
		createPath: "/entities",
		createBody: map[string]interface{}{
			"entity_id":   entityID,
			"entity_type": "asset",
			"subtype":     "drone",
		},
		patchPath: "/entities/" + entityID,
		matchBody: map[string]interface{}{
			"extra": map[string]interface{}{"matched": true},
		},
		staleBody: map[string]interface{}{
			"extra": map[string]interface{}{"stale": true},
		},
		weakBody: map[string]interface{}{
			"extra": map[string]interface{}{"weak": true},
		},
		malformedBody: map[string]interface{}{
			"extra": map[string]interface{}{"malformed": true},
		},
		noHeaderBody: map[string]interface{}{
			"extra": map[string]interface{}{"no_header": true},
		},
	})

	taskEntityID := fmt.Sprintf("%s-ifmatch-task-entity", prefix)
	resp, err := client.Post(ctx, "/entities", map[string]interface{}{
		"entity_id":   taskEntityID,
		"entity_type": "asset",
	})
	if err != nil {
		t.Fatalf("create task entity fixture: %v", err)
	}
	requireHTTPStatus(t, resp, http.StatusCreated, "POST /entities (task If-Match fixture)")
	drainClose(resp)

	taskID := fmt.Sprintf("%s-ifmatch-task", prefix)
	exerciseIfMatchResource(t, client, ctx, ifMatchResource{
		createPath: "/tasks",
		createBody: map[string]interface{}{
			"task_id":   taskID,
			"entity_id": taskEntityID,
			"status":    "pending",
		},
		patchPath: "/tasks/" + taskID,
		matchBody: map[string]interface{}{
			"extra": map[string]interface{}{"matched": true},
		},
		staleBody: map[string]interface{}{
			"extra": map[string]interface{}{"stale": true},
		},
		weakBody: map[string]interface{}{
			"extra": map[string]interface{}{"weak": true},
		},
		malformedBody: map[string]interface{}{
			"extra": map[string]interface{}{"malformed": true},
		},
		noHeaderBody: map[string]interface{}{
			"extra": map[string]interface{}{"no_header": true},
		},
	})

	objectID := fmt.Sprintf("%s-ifmatch-object", prefix)
	exerciseIfMatchResource(t, client, ctx, ifMatchResource{
		createPath: "/objects",
		createBody: map[string]interface{}{
			"object_id":    objectID,
			"content_type": "application/json",
			"size_bytes":   1,
		},
		patchPath: "/objects/" + objectID,
		matchBody: map[string]interface{}{
			"extra": map[string]interface{}{"matched": true},
		},
		staleBody: map[string]interface{}{
			"extra": map[string]interface{}{"stale": true},
		},
		weakBody: map[string]interface{}{
			"extra": map[string]interface{}{"weak": true},
		},
		malformedBody: map[string]interface{}{
			"extra": map[string]interface{}{"malformed": true},
		},
		noHeaderBody: map[string]interface{}{
			"extra": map[string]interface{}{"no_header": true},
		},
	})
}

type ifMatchResource struct {
	createPath    string
	createBody    map[string]interface{}
	patchPath     string
	matchBody     map[string]interface{}
	staleBody     map[string]interface{}
	weakBody      map[string]interface{}
	malformedBody map[string]interface{}
	noHeaderBody  map[string]interface{}
}

func exerciseIfMatchResource(t *testing.T, client *APIClient, ctx context.Context, resource ifMatchResource) {
	t.Helper()

	resp, err := client.Post(ctx, resource.createPath, resource.createBody)
	if err != nil {
		t.Fatalf("create %s: %v", resource.createPath, err)
	}
	requireHTTPStatus(t, resp, http.StatusCreated, "create "+resource.createPath)
	initialETag := requireETag(t, resp)
	drainClose(resp)

	resp, err = requestJSONWithHeaders(ctx, client, http.MethodPatch, resource.patchPath, resource.matchBody, map[string]string{"If-Match": initialETag})
	if err != nil {
		t.Fatalf("If-Match patch %s: %v", resource.patchPath, err)
	}
	requireHTTPStatus(t, resp, http.StatusOK, "matching If-Match PATCH "+resource.patchPath)
	currentETag := requireETag(t, resp)
	if currentETag == initialETag {
		t.Fatalf("PATCH %s returned unchanged ETag %q", resource.patchPath, currentETag)
	}
	drainClose(resp)

	resp, err = requestJSONWithHeaders(ctx, client, http.MethodPatch, resource.patchPath, resource.staleBody, map[string]string{"If-Match": initialETag})
	if err != nil {
		t.Fatalf("stale If-Match patch %s: %v", resource.patchPath, err)
	}
	requireHTTPStatus(t, resp, http.StatusPreconditionFailed, "stale If-Match PATCH "+resource.patchPath)
	drainClose(resp)

	resp, err = requestJSONWithHeaders(ctx, client, http.MethodPatch, resource.patchPath, resource.weakBody, map[string]string{"If-Match": "W/" + currentETag})
	if err != nil {
		t.Fatalf("weak If-Match patch %s: %v", resource.patchPath, err)
	}
	requireHTTPStatus(t, resp, http.StatusPreconditionFailed, "weak If-Match PATCH "+resource.patchPath)
	drainClose(resp)

	resp, err = requestJSONWithHeaders(ctx, client, http.MethodPatch, resource.patchPath, resource.malformedBody, map[string]string{"If-Match": "not-an-etag"})
	if err != nil {
		t.Fatalf("malformed If-Match patch %s: %v", resource.patchPath, err)
	}
	requireHTTPStatus(t, resp, http.StatusPreconditionFailed, "malformed If-Match PATCH "+resource.patchPath)
	drainClose(resp)

	resp, err = requestJSONWithHeaders(ctx, client, http.MethodPatch, resource.patchPath, resource.noHeaderBody, nil)
	if err != nil {
		t.Fatalf("no-header patch %s: %v", resource.patchPath, err)
	}
	requireHTTPStatus(t, resp, http.StatusOK, "no If-Match PATCH "+resource.patchPath)
	requireETag(t, resp)
	drainClose(resp)
}

func requestJSONWithHeaders(ctx context.Context, client *APIClient, method, path string, body interface{}, headers map[string]string) (*http.Response, error) {
	var bodyReader io.Reader
	if body != nil {
		jsonBytes, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		bodyReader = bytes.NewReader(jsonBytes)
	}

	fullURL, err := joinURL(client.BaseURL, path)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, method, fullURL, bodyReader)
	if err != nil {
		return nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Accept", "application/json")
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	return client.Client.Do(req)
}

func requireETag(t *testing.T, resp *http.Response) string {
	t.Helper()
	etag := strings.TrimSpace(resp.Header.Get("ETag"))
	if etag == "" {
		t.Fatal("response missing ETag")
	}
	return etag
}
