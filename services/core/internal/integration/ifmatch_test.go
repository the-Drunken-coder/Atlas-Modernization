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

func TestIfMatchPreconditionsForEntityAndObject(t *testing.T) {
	SkipIfSystemNotAvailable(t)

	client := NewAPIClient()
	ctx := context.Background()
	prefix := TestArtifactPrefix()

	entityID := fmt.Sprintf("%s-ifmatch-entity", prefix)
	exerciseIfMatchResource(ctx, t, client, ifMatchResource{
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

	objectID := fmt.Sprintf("%s-ifmatch-object", prefix)
	exerciseIfMatchResource(ctx, t, client, ifMatchResource{
		createPath: "/objects",
		createBody: map[string]interface{}{
			"object_id": objectID,
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
	objectID := fmt.Sprintf("%s-ifmatch-concurrent-object", prefix)

	tests := []struct {
		name     string
		resource ifMatchConcurrentResource
	}{
		{
			name: "entity",
			resource: ifMatchConcurrentResource{
				createPath: "/entities",
				createBody: map[string]interface{}{
					"entity_id":   entityID,
					"entity_type": "asset",
					"subtype":     "drone",
				},
				patchPath: "/entities/" + entityID,
			},
		},
		{
			name: "object",
			resource: ifMatchConcurrentResource{
				createPath: "/objects",
				createBody: map[string]interface{}{
					"object_id": objectID,
				},
				patchPath: "/objects/" + objectID,
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			exerciseConcurrentIfMatchConflict(ctx, t, client, tt.resource)
		})
	}
}

func TestResourceInstanceTokenPreconditionsForEntityAndObject(t *testing.T) {
	SkipIfSystemNotAvailable(t)

	client := NewAPIClient()
	ctx := context.Background()
	prefix := TestArtifactPrefix()
	for _, resource := range []struct {
		name         string
		createPath   string
		id           string
		body         map[string]interface{}
		resourcePath string
	}{
		{
			name: "entity", createPath: "/entities", id: fmt.Sprintf("%s-token-entity", prefix),
			body:         map[string]interface{}{"entity_id": fmt.Sprintf("%s-token-entity", prefix), "entity_type": "asset"},
			resourcePath: "/entities/" + fmt.Sprintf("%s-token-entity", prefix),
		},
		{
			name: "object", createPath: "/objects", id: fmt.Sprintf("%s-token-object", prefix),
			body:         map[string]interface{}{"object_id": fmt.Sprintf("%s-token-object", prefix)},
			resourcePath: "/objects/" + fmt.Sprintf("%s-token-object", prefix),
		},
	} {
		t.Run(resource.name, func(t *testing.T) {
			token := fmt.Sprintf("instance-token-%s-%s", prefix, resource.name)
			resp, err := requestJSONWithHeaders(ctx, client, http.MethodPost, resource.createPath, resource.body, map[string]string{
				"Atlas-Resource-Instance-Token": token,
			})
			if err != nil {
				t.Fatalf("create token-bound %s: %v", resource.name, err)
			}
			requireHTTPStatus(t, resp, http.StatusCreated, "create token-bound "+resource.name)
			createdBody, err := io.ReadAll(resp.Body)
			resp.Body.Close()
			if err != nil {
				t.Fatalf("read token-bound %s response: %v", resource.name, err)
			}
			if strings.Contains(string(createdBody), token) || strings.Contains(string(createdBody), "instance_token") {
				t.Fatalf("token-bound %s response exposed the instance token: %s", resource.name, createdBody)
			}

			resp, err = requestJSONWithHeaders(ctx, client, http.MethodDelete, resource.resourcePath, nil, map[string]string{
				"Atlas-Resource-Instance-Token": token,
			})
			if err != nil {
				t.Fatalf("delete token-bound %s: %v", resource.name, err)
			}
			requireHTTPStatus(t, resp, http.StatusNoContent, "delete token-bound "+resource.name)
			drainClose(resp)

			resp, err = client.Post(ctx, resource.createPath, resource.body)
			if err != nil {
				t.Fatalf("recreate ordinary %s: %v", resource.name, err)
			}
			requireHTTPStatus(t, resp, http.StatusCreated, "recreate ordinary "+resource.name)
			drainClose(resp)

			resp, err = requestJSONWithHeaders(ctx, client, http.MethodDelete, resource.resourcePath, nil, map[string]string{
				"Atlas-Resource-Instance-Token": token,
			})
			if err != nil {
				t.Fatalf("delete replacement %s: %v", resource.name, err)
			}
			requireHTTPStatus(t, resp, http.StatusPreconditionFailed, "delete replacement "+resource.name)
			drainClose(resp)

			resp, err = client.Get(ctx, resource.resourcePath)
			if err != nil {
				t.Fatalf("get replacement %s: %v", resource.name, err)
			}
			requireHTTPStatus(t, resp, http.StatusOK, "get replacement "+resource.name)
			drainClose(resp)

			resp, err = client.Request(ctx, http.MethodDelete, resource.resourcePath, nil)
			if err != nil {
				t.Fatalf("ordinary delete replacement %s: %v", resource.name, err)
			}
			requireHTTPStatus(t, resp, http.StatusNoContent, "ordinary delete replacement "+resource.name)
			drainClose(resp)

			var otherBody map[string]interface{}
			if resource.name == "entity" {
				otherBody = map[string]interface{}{"entity_id": resource.id + "-reuse", "entity_type": "asset"}
			} else {
				otherBody = map[string]interface{}{"object_id": resource.id + "-reuse"}
			}
			resp, err = requestJSONWithHeaders(ctx, client, http.MethodPost, resource.createPath, otherBody, map[string]string{
				"Atlas-Resource-Instance-Token": token,
			})
			if err != nil {
				t.Fatalf("reuse token %s: %v", resource.name, err)
			}
			requireHTTPStatus(t, resp, http.StatusBadRequest, "reuse token "+resource.name)
			drainClose(resp)
		})
	}
}

type ifMatchConcurrentResource struct {
	createPath string
	createBody map[string]interface{}
	patchPath  string
}

func exerciseConcurrentIfMatchConflict(ctx context.Context, t *testing.T, client *APIClient, resource ifMatchConcurrentResource) {
	t.Helper()

	resp, err := client.Post(ctx, resource.createPath, resource.createBody)
	if err != nil {
		t.Fatalf("create concurrent If-Match fixture %s: %v", resource.createPath, err)
	}
	requireHTTPStatus(t, resp, http.StatusCreated, "create concurrent If-Match fixture "+resource.createPath)
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
				resource.patchPath,
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
	var errors []error
	for result := range results {
		if result.err != nil {
			errors = append(errors, result.err)
			continue
		}
		counts[result.status]++
	}
	if len(errors) > 0 {
		t.Fatalf("concurrent If-Match patch %s failed: %v", resource.patchPath, errors)
	}
	if counts[http.StatusOK] != 1 || counts[http.StatusPreconditionFailed] != 1 {
		t.Fatalf("concurrent If-Match statuses for %s = %v, want one 200 and one 412", resource.patchPath, counts)
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

func exerciseIfMatchResource(ctx context.Context, t *testing.T, client *APIClient, resource ifMatchResource) {
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
	if client.APIKey != "" {
		req.Header.Set("X-API-Key", client.APIKey)
	}
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
	container, ok := body["extra"].(map[string]interface{})
	if !ok {
		t.Fatalf("response missing extra field: %#v", body)
	}
	if got, ok := container[marker].(bool); ok && got {
		return
	}
	if got, ok := container[marker]; ok {
		t.Fatalf("response extra.%s = %v, want true", marker, got)
	}
	t.Fatalf("response missing marker %q in extra: %#v", marker, body)
}
