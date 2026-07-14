package actions

import (
	"encoding/json"
	"testing"

	commandcatalog "github.com/the-drunken-coder/atlas/atlas_core/command_catalog"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/models"
)

func TestCommandCatalogObjectMatchesPublishedCatalog(t *testing.T) {
	path := "objects/command_catalog/1"
	contentType := "application/json"
	objectType := commandcatalog.ObjectID
	catalogData := map[string]interface{}{
		"type":        commandcatalog.ObjectID,
		"name":        "Atlas Command Catalog",
		"description": "Commands",
		"commands":    []interface{}{map[string]interface{}{"id": "goto"}},
	}
	storedJSON, err := json.Marshal(map[string]interface{}{
		"bucket":        "atlas-media",
		"size_bytes":    100,
		"usage_hints":   []string{commandcatalog.ObjectID},
		"name":          catalogData["name"],
		"description":   catalogData["description"],
		"commands":      catalogData["commands"],
		"operator_note": "preserve this annotation",
	})
	if err != nil {
		t.Fatal(err)
	}
	object := &models.MediaObject{
		Path:        &path,
		ContentType: &contentType,
		Type:        &objectType,
		JSON:        storedJSON,
	}

	if !commandCatalogObjectMatches(object, catalogData, 100, "atlas-media") {
		t.Fatal("matching published catalog was not recognized")
	}
	if commandCatalogObjectMatches(object, catalogData, 101, "atlas-media") {
		t.Fatal("catalog with stale blob size matched")
	}
	catalogData["description"] = "Changed commands"
	if commandCatalogObjectMatches(object, catalogData, 100, "atlas-media") {
		t.Fatal("catalog with stale discovery metadata matched")
	}
}
