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
		if testCase.Definition != "EntityCreateRequest" && testCase.Definition != "EntityUpdateRequest" {
			continue
		}
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
			case "EntityUpdateRequest":
				entityID := fmt.Sprintf("%s-conformance-update-%d", prefix, index)
				created, createErr := client.Post(ctx, "/entities", map[string]interface{}{
					"entity_id": entityID, "entity_type": "geofeature",
				})
				if createErr != nil {
					t.Fatal(createErr)
				}
				requireHTTPStatus(t, created, http.StatusCreated, "create entity for conformance update")
				drainClose(created)
				response, requestErr = client.Patch(ctx, "/entities/"+entityID, payload)
			}
			if requestErr != nil {
				t.Fatal(requestErr)
			}
			defer response.Body.Close()
			want := http.StatusBadRequest
			if testCase.Valid {
				want = http.StatusCreated
				if testCase.Definition == "EntityUpdateRequest" {
					want = http.StatusOK
				}
			}
			requireHTTPStatus(t, response, want, testCase.Name)
		})
	}
}
