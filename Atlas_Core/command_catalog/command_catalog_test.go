package command_catalog

import (
	"encoding/json"
	"os"
	"testing"
)

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
