package actions_test

import (
	"fmt"
	"strings"
	"testing"

	"github.com/the-drunken-coder/atlas/atlas_core/internal/actions"
)

func TestValidateResourceID(t *testing.T) {
	tests := []struct {
		name         string
		id           string
		resourceType string
		wantErr      bool
		errContains  string
	}{
		// Valid IDs
		{"valid alphanumeric", "abc123", "entity", false, ""},
		{"valid with hyphen", "entity-123", "entity", false, ""},
		{"valid with underscore", "entity_123", "entity", false, ""},
		{"valid with dot", "entity.123", "entity", false, ""},
		{"valid UUID", "550e8400-e29b-41d4-a716-446655440000", "entity", false, ""},
		{"valid mixed", "Entity-123_test.v2", "entity", false, ""},

		// Invalid IDs
		{"empty", "", "entity", true, "is required"},
		{"whitespace only", "   ", "entity", true, "is required"},
		{"too long", strings.Repeat("a", 51), "entity", true, "must not exceed 50 characters"},
		{"starts with hyphen", "-abc", "entity", true, "invalid characters"},
		{"starts with underscore", "_abc", "entity", true, "invalid characters"},
		{"starts with dot", ".abc", "entity", true, "invalid characters"},
		{"contains space", "entity 123", "entity", true, "invalid characters"},
		{"contains special char", "entity@123", "entity", true, "invalid characters"},
		{"contains quote", `entity"123`, "entity", true, "invalid characters"},
		{"SQL injection attempt", "'; DROP TABLE entities; --", "entity", true, "invalid characters"},
		{"JSON injection attempt", `{"entity_id": "evil"}`, "entity", true, "invalid characters"},
		{"newline injection", "entity\n123", "entity", true, "invalid characters"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := actions.ValidateResourceID(tt.id, tt.resourceType)
			if (err != nil) != tt.wantErr {
				t.Errorf("ValidateResourceID(%q, %q) error = %v, wantErr %v", tt.id, tt.resourceType, err, tt.wantErr)
				return
			}
			if tt.wantErr && tt.errContains != "" {
				if err == nil || !strings.Contains(err.Error(), tt.errContains) {
					t.Errorf("ValidateResourceID(%q, %q) error = %v, want error containing %q", tt.id, tt.resourceType, err, tt.errContains)
				}
			}
		})
	}
}

func TestValidateEntityID(t *testing.T) {
	if err := actions.ValidateEntityID("valid-entity-123"); err != nil {
		t.Errorf("ValidateEntityID should accept valid ID, got %v", err)
	}

	if err := actions.ValidateEntityID(""); err == nil {
		t.Fatal("ValidateEntityID should reject empty ID")
	} else if got := err.Error(); got != "entity_id is required" {
		t.Errorf("unexpected empty entity_id error: %q", got)
	}

	if err := actions.ValidateEntityID("bad@entity"); err == nil {
		t.Fatal("ValidateEntityID should reject invalid ID")
	} else if got := err.Error(); !strings.HasPrefix(got, "entity_id contains invalid characters") {
		t.Errorf("unexpected invalid entity_id error: %q", got)
	}

	longID := strings.Repeat("a", actions.IDMaxLength+1)
	wantLong := fmt.Sprintf("entity_id must not exceed %d characters", actions.IDMaxLength)
	if err := actions.ValidateEntityID(longID); err == nil {
		t.Fatal("ValidateEntityID should reject too-long ID")
	} else if got := err.Error(); got != wantLong {
		t.Errorf("unexpected too-long entity_id error: %q, want %q", got, wantLong)
	}
}

func TestValidateTaskID(t *testing.T) {
	if err := actions.ValidateTaskID("valid-task-123"); err != nil {
		t.Errorf("ValidateTaskID should accept valid ID, got %v", err)
	}

	if err := actions.ValidateTaskID(""); err == nil {
		t.Fatal("ValidateTaskID should reject empty ID")
	} else if got := err.Error(); got != "task_id is required" {
		t.Errorf("unexpected empty task_id error: %q", got)
	}

	if err := actions.ValidateTaskID("invalid@task"); err == nil {
		t.Fatal("ValidateTaskID should reject invalid ID")
	} else if got := err.Error(); !strings.HasPrefix(got, "task_id contains invalid characters") {
		t.Errorf("unexpected task_id error: %q", got)
	}
}

func TestValidateObjectID(t *testing.T) {
	if err := actions.ValidateObjectID("valid-object-123"); err != nil {
		t.Errorf("ValidateObjectID should accept valid ID, got %v", err)
	}

	if err := actions.ValidateObjectID(""); err == nil {
		t.Fatal("ValidateObjectID should reject empty ID")
	} else if got := err.Error(); got != "object_id is required" {
		t.Errorf("unexpected empty object_id error: %q", got)
	}

	if err := actions.ValidateObjectID("invalid/object"); err == nil {
		t.Fatal("ValidateObjectID should reject invalid ID")
	} else if got := err.Error(); !strings.HasPrefix(got, "object_id contains invalid characters") {
		t.Errorf("unexpected object_id error: %q", got)
	}
}

func TestValidateAlias(t *testing.T) {
	tests := []struct {
		name    string
		alias   string
		wantErr bool
	}{
		{"empty is valid", "", false},
		{"valid simple", "MyAlias", false},
		{"valid with space", "My Alias", false},
		{"valid with numbers", "Alias 123", false},
		{"valid with hyphen", "My-Alias", false},
		{"valid with underscore", "My_Alias", false},
		{"valid with dot", "My.Alias", false},
		{"trim surrounding whitespace", " MyAlias ", false},

		{"too long", strings.Repeat("a", 256), true},
		{"contains special char", "My@Alias", true},
		{"starts with hyphen", "-MyAlias", true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := actions.ValidateAlias(tt.alias)
			if (err != nil) != tt.wantErr {
				t.Errorf("ValidateAlias(%q) error = %v, wantErr %v", tt.alias, err, tt.wantErr)
			}
		})
	}
}

func TestNormalizeAlias(t *testing.T) {
	normalized, err := actions.NormalizeAlias("  Demo Alias  ")
	if err != nil {
		t.Fatalf("NormalizeAlias returned error: %v", err)
	}
	if normalized != "Demo Alias" {
		t.Fatalf("NormalizeAlias returned %q, want %q", normalized, "Demo Alias")
	}

	_, err = actions.NormalizeAlias("bad@alias")
	if err == nil {
		t.Fatal("expected invalid alias to return an error")
	}
}

func TestSanitizeID(t *testing.T) {
	tests := []struct {
		input    string
		expected string
	}{
		{"  entity-123  ", "entity-123"},
		{"entity-123", "entity-123"},
		{"\tentity\n", "entity"},
	}

	for _, tt := range tests {
		result := actions.SanitizeID(tt.input)
		if result != tt.expected {
			t.Errorf("SanitizeID(%q) = %q, want %q", tt.input, result, tt.expected)
		}
	}
}
