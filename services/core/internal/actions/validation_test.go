package actions_test

import (
	"strings"
	"testing"

	"github.com/the-drunken-coder/atlas/services/core/internal/actions"
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
