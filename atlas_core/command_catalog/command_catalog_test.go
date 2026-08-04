package commandcatalog

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func TestDefaultCatalogLoadsCommandAndCoercesParameters(t *testing.T) {
	catalog, err := Default()
	if err != nil {
		t.Fatalf("Default() returned error: %v", err)
	}
	if catalog.Type != "command_catalog" || catalog.Name == "" || len(catalog.Commands) == 0 {
		t.Fatalf("Default() = %#v, want populated command catalog", catalog)
	}
	command, ok := Command(catalog, "goto")
	if !ok {
		t.Fatal("Default().Command(\"goto\") was not found")
	}

	coerced, err := CoerceParameters(command, map[string]any{
		"latitude":       "38.5",
		"longitude":      json.Number("-77.1"),
		"arrival_radius": 4,
	})
	if err != nil {
		t.Fatalf("CoerceParameters returned error: %v", err)
	}
	if coerced["latitude"] != 38.5 || coerced["longitude"] != -77.1 || coerced["arrival_radius"] != float64(4) {
		t.Fatalf("coerced parameters = %#v", coerced)
	}

	if _, err := CoerceParameters(command, map[string]any{"latitude": 91, "longitude": 0}); err == nil || !strings.Contains(err.Error(), "latitude must be <= 90") {
		t.Fatalf("out-of-range latitude error = %v, want latitude maximum error", err)
	}
	if _, err := CoerceParameters(command, map[string]any{"latitude": 38.5, "longitude": -77.1, "unknown": true}); err == nil || !strings.Contains(err.Error(), "unknown parameter unknown") {
		t.Fatalf("unknown parameter error = %v, want unknown parameter error", err)
	}
}

func TestMoveToLocationUsesProtocolAltitudeParameter(t *testing.T) {
	data, err := os.ReadFile("command_catalog.json")
	if err != nil {
		t.Fatalf("read command catalog: %v", err)
	}

	var catalog struct {
		Commands []struct {
			ID               string `json:"id"`
			ParametersSchema map[string]struct {
				Type     string `json:"type"`
				Required bool   `json:"required"`
			} `json:"parameters_schema"`
		} `json:"commands"`
	}
	if err := json.Unmarshal(data, &catalog); err != nil {
		t.Fatalf("parse command catalog: %v", err)
	}

	for _, command := range catalog.Commands {
		if command.ID != "move_to_location" {
			continue
		}
		if _, exists := command.ParametersSchema["altitude"]; exists {
			t.Fatal("move_to_location must use altitude_m, not altitude")
		}
		altitude, exists := command.ParametersSchema["altitude_m"]
		if !exists {
			t.Fatal("move_to_location is missing altitude_m")
		}
		if altitude.Type != "number" {
			t.Fatalf("altitude_m type = %q, want number", altitude.Type)
		}
		if !altitude.Required {
			t.Fatal("altitude_m must be required")
		}
		return
	}

	t.Fatal("move_to_location command not found")
}
