package integration

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
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
		wildcardBody: map[string]interface{}{
			"extra": map[string]interface{}{"wildcard": true},
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
		wildcardBody: map[string]interface{}{
			"extra": map[string]interface{}{"wildcard": true},
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
		wildcardBody: map[string]interface{}{
			"extra": map[string]interface{}{"wildcard": true},
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

func TestIfMatchConcurrentConflict(t *testing.T) {
	SkipIfSystemNotAvailable(t)

	client := NewAPIClient()
	ctx := context.Background()
	prefix := TestArtifactPrefix()
	entityID := fmt.Sprintf("%s-ifmatch-concurrent-entity", prefix)

	resp, err := client.Post(ctx, "/entities", map[string]interface{}{
		"entity_id":   entityID,
		"entity_type": "asset",
		"subtype":     "drone",
	})
	if err != nil {
		t.Fatalf("create concurrent If-Match entity: %v", err)
	}
	requireHTTPStatus(t, resp, http.StatusCreated, "POST /entities (concurrent If-Match fixture)")
	initialETag := requireETag(t, resp)
	drainClose(resp)

	type patchResult struct {
		status int
		err    error
	}
	results := make(chan patchResult, 2)
	start := make(chan struct{})
	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			resp, err := requestJSONWithHeaders(
				ctx,
				client,
				http.MethodPatch,
				"/entities/"+entityID,
				map[string]interface{}{"extra": map[string]interface{}{"concurrent": i}},
				map[string]string{"If-Match": initialETag},
			)
			if err != nil {
				results <- patchResult{err: err}
				return
			}
			status := resp.StatusCode
			drainClose(resp)
			results <- patchResult{status: status}
		}(i)
	}
	close(start)
	wg.Wait()
	close(results)

	counts := map[int]int{}
	for result := range results {
		if result.err != nil {
			t.Fatalf("concurrent If-Match patch failed: %v", result.err)
		}
		counts[result.status]++
	}
	if counts[http.StatusOK] != 1 || counts[http.StatusPreconditionFailed] != 1 {
		t.Fatalf("concurrent If-Match statuses = %v, want one 200 and one 412", counts)
	}
}

type ifMatchResource struct {
	createPath    string
	createBody    map[string]interface{}
	patchPath     string
	matchBody     map[string]interface{}
	wildcardBody  map[string]interface{}
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
	assertResponseMarker(t, resp, "matched")

	resp, err = requestJSONWithHeaders(ctx, client, http.MethodPatch, resource.patchPath, resource.wildcardBody, map[string]string{"If-Match": "*"})
	if err != nil {
		t.Fatalf("wildcard If-Match patch %s: %v", resource.patchPath, err)
	}
	requireHTTPStatus(t, resp, http.StatusOK, "wildcard If-Match PATCH "+resource.patchPath)
	wildcardETag := requireETag(t, resp)
	if wildcardETag == currentETag {
		t.Fatalf("wildcard PATCH %s returned unchanged ETag %q", resource.patchPath, wildcardETag)
	}
	currentETag = wildcardETag
	assertResponseMarker(t, resp, "wildcard")

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
	assertResponseMarker(t, resp, "no_header")
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

func assertResponseMarker(t *testing.T, resp *http.Response, marker string) {
	t.Helper()
	defer resp.Body.Close()

	var body map[string]interface{}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode response body: %v", err)
	}
	for _, field := range []string{"extra", "payload"} {
		container, ok := body[field].(map[string]interface{})
		if !ok {
			continue
		}
		if got, ok := container[marker].(bool); ok && got {
			return
		}
		if got, ok := container[marker]; ok {
			t.Fatalf("response %s.%s = %v, want true", field, marker, got)
		}
	}
	t.Fatalf("response missing marker %q in extra or payload: %#v", marker, body)
}
