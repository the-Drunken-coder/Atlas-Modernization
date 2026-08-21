package artifacts

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoadCommandDefinitionsRejectsTrailingJSON(t *testing.T) {
	root := t.TempDir()
	directory := filepath.Join(root, commandCatalogDirectory)
	if err := os.Mkdir(directory, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(directory, "fixture.json")
	if err := os.WriteFile(path, []byte(`[{"command":"fixture.run"}] []`), 0o600); err != nil {
		t.Fatal(err)
	}

	_, err := loadCommandDefinitions(root, commandCatalogDirectory)
	if err == nil || !strings.Contains(err.Error(), "multiple JSON values") {
		t.Fatalf("load trailing Command JSON error = %v", err)
	}
}
