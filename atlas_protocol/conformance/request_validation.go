package conformance

import (
	_ "embed"
	"encoding/json"
	"fmt"
)

// RequestValidationCase is one shared request-validation expectation.
type RequestValidationCase struct {
	Name        string          `json:"name"`
	Definition  string          `json:"definition"`
	SchemaValid bool            `json:"schema_valid"`
	Valid       bool            `json:"valid"`
	Value       json.RawMessage `json:"value"`
}

//go:embed request-validation.json
var requestValidationJSON []byte

// LoadRequestValidationCases returns the protocol-owned request corpus.
func LoadRequestValidationCases() ([]RequestValidationCase, error) {
	var corpus struct {
		Cases []RequestValidationCase `json:"cases"`
	}
	if err := json.Unmarshal(requestValidationJSON, &corpus); err != nil {
		return nil, fmt.Errorf("decode request-validation corpus: %w", err)
	}
	if len(corpus.Cases) == 0 {
		return nil, fmt.Errorf("request-validation corpus contains no cases")
	}
	return corpus.Cases, nil
}
