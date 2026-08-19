package atlasprotocol_test

import (
	"testing"

	"github.com/the-drunken-coder/atlas/atlas_protocol/conformance"
	protocol "github.com/the-drunken-coder/atlas/atlas_protocol/generated/go/atlasprotocol"
)

func TestPublicRequestValidatorsCoverConformanceCorpus(t *testing.T) {
	cases, err := conformance.LoadRequestValidationCases()
	if err != nil {
		t.Fatal(err)
	}
	validators := map[string]func(any) []string{
		"EntityCreateRequest":        protocol.ValidateEntityCreateRequest,
		"EntityCheckInRequest":       protocol.ValidateEntityCheckInRequest,
		"EntityUpdateRequest":        protocol.ValidateEntityUpdateRequest,
		"TaskCreateRequest":          protocol.ValidateTaskCreateRequest,
		"TaskAcknowledgeRequest":     protocol.ValidateTaskAcknowledgeRequest,
		"TaskStartRequest":           protocol.ValidateTaskStartRequest,
		"TaskProgressRequest":        protocol.ValidateTaskProgressRequest,
		"TaskCompleteRequest":        protocol.ValidateTaskCompleteRequest,
		"TaskFailRequest":            protocol.ValidateTaskFailRequest,
		"TaskCancelRequest":          protocol.ValidateTaskCancelRequest,
		"RuntimeRegistrationRequest": protocol.ValidateRuntimeRegistrationRequest,
		"RuntimeReadyRequest":        protocol.ValidateRuntimeReadyRequest,
		"ObjectCreateRequest":        protocol.ValidateObjectCreateRequest,
		"ObjectUpdateRequest":        protocol.ValidateObjectUpdateRequest,
	}
	seen := make(map[string]bool, len(validators))

	for _, testCase := range cases {
		t.Run(testCase.Name, func(t *testing.T) {
			validate, ok := validators[testCase.Definition]
			if !ok {
				t.Fatalf("no public Go validator for %q", testCase.Definition)
			}
			seen[testCase.Definition] = true
			if valid := len(validate(testCase.Value)) == 0; valid != testCase.Valid {
				t.Fatalf("public Go validator valid = %t, want %t", valid, testCase.Valid)
			}
		})
	}
	for definition := range validators {
		if !seen[definition] {
			t.Errorf("conformance corpus has no %s case", definition)
		}
	}
}
