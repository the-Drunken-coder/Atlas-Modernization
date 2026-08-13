package integration

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"

	"github.com/the-drunken-coder/atlas/atlas_protocol/conformance"
)

func TestRequestValidationConformance(t *testing.T) {
	SkipIfSystemNotAvailable(t)

	cases, err := conformance.LoadRequestValidationCases()
	if err != nil {
		t.Fatal(err)
	}
	client := NewAPIClient()
	ctx := context.Background()
	prefix := TestArtifactPrefix()

	for index, testCase := range cases {
		t.Run(testCase.Name, func(t *testing.T) {
			var payload map[string]interface{}
			if err := json.Unmarshal(testCase.Value, &payload); err != nil {
				t.Fatal(err)
			}

			var response *http.Response
			var requestErr error
			switch testCase.Definition {
			case "EntityCreateRequest":
				payload["entity_id"] = fmt.Sprintf("%s-conformance-%d", prefix, index)
				response, requestErr = client.Post(ctx, "/entities", payload)
			case "EntityCheckInRequest":
				entityID := fmt.Sprintf("%s-conformance-checkin-%d", prefix, index)
				requireConformanceSetup(ctx, t, client, "/entities", map[string]interface{}{
					"entity_id": entityID, "entity_type": "asset",
				}, "create entity for check-in conformance")
				response, requestErr = client.Post(ctx, "/entities/"+entityID+"/checkin", payload)
			case "EntityUpdateRequest":
				entityID := fmt.Sprintf("%s-conformance-update-%d", prefix, index)
				requireConformanceSetup(ctx, t, client, "/entities", map[string]interface{}{
					"entity_id": entityID, "entity_type": "geofeature",
				}, "create entity for conformance update")
				response, requestErr = client.Patch(ctx, "/entities/"+entityID, payload)
			case "TaskCreateRequest":
				payload["task_id"] = fmt.Sprintf("%s-conformance-%d", prefix, index)
				response, requestErr = client.Post(ctx, "/tasks", payload)
			case "TaskUpdateRequest":
				taskID := fmt.Sprintf("%s-conformance-update-%d", prefix, index)
				requireConformanceSetup(ctx, t, client, "/tasks", map[string]interface{}{
					"task_id": taskID,
				}, "create task for conformance update")
				response, requestErr = client.Patch(ctx, "/tasks/"+taskID, payload)
			case "ObjectCreateRequest":
				payload["object_id"] = fmt.Sprintf("%s-conformance-%d", prefix, index)
				response, requestErr = client.Post(ctx, "/objects", payload)
			case "ObjectUpdateRequest":
				objectID := fmt.Sprintf("%s-conformance-update-%d", prefix, index)
				requireConformanceSetup(ctx, t, client, "/objects", map[string]interface{}{
					"object_id": objectID,
				}, "create object for conformance update")
				response, requestErr = client.Patch(ctx, "/objects/"+objectID, payload)
			default:
				t.Fatalf("unsupported request definition %q", testCase.Definition)
			}
			if requestErr != nil {
				t.Fatal(requestErr)
			}
			defer response.Body.Close()
			want := http.StatusBadRequest
			if testCase.Valid {
				want = http.StatusCreated
				if testCase.Definition == "EntityCheckInRequest" ||
					testCase.Definition == "EntityUpdateRequest" ||
					testCase.Definition == "TaskUpdateRequest" ||
					testCase.Definition == "ObjectUpdateRequest" {
					want = http.StatusOK
				}
			}
			requireHTTPStatus(t, response, want, testCase.Name)
			if !testCase.Valid && testCase.Definition == "EntityCheckInRequest" {
				var errorBody map[string]interface{}
				if err := ParseResponse(response, &errorBody); err != nil {
					t.Fatalf("decode invalid check-in response: %v", err)
				}
				if errorBody["error_code"] != "VALIDATION_ERROR" {
					t.Fatalf("error_code = %v, want VALIDATION_ERROR", errorBody["error_code"])
				}
			}
		})
	}
}

func requireConformanceSetup(ctx context.Context, t *testing.T, client *APIClient, path string, payload map[string]interface{}, operation string) {
	t.Helper()
	response, err := client.Post(ctx, path, payload)
	if err != nil {
		t.Fatal(err)
	}
	requireHTTPStatus(t, response, http.StatusCreated, operation)
	drainClose(response)
}
