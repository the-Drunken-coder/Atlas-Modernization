package config

import (
	"os"
	"strings"
	"testing"
)

func TestPluginConfigurationNormalizesAndRejectsInvalidEndpoints(t *testing.T) {
	cfg := Config{Plugins: []PluginConfig{{ID: " reference ", BaseURL: " http://reference:8080/ "}}}
	if err := cfg.validatePlugins(); err != nil {
		t.Fatalf("validatePlugins: %v", err)
	}
	if got := cfg.Plugins[0]; got.ID != "reference" || got.BaseURL != "http://reference:8080" {
		t.Fatalf("normalized Plugin = %#v", got)
	}

	for _, plugins := range [][]PluginConfig{
		{{ID: "reference-plugin", BaseURL: "http://reference:8080"}},
		{{ID: "reference", BaseURL: "https://reference:8080"}},
		{{ID: "reference", BaseURL: "http://reference:8080/path"}},
		{{ID: "reference", BaseURL: "http://reference:8080"}, {ID: "reference", BaseURL: "http://other:8080"}},
	} {
		if err := (&Config{Plugins: plugins}).validatePlugins(); err == nil {
			t.Fatalf("validatePlugins accepted %#v", plugins)
		}
	}
}

func TestAtlasPluginsEnvironmentReplacesSettingsArray(t *testing.T) {
	const value = `[{"id":"reference","base_url":"http://reference:8080"}]`
	if err := os.Setenv("ATLAS_PLUGINS", value); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Unsetenv("ATLAS_PLUGINS") })
	cfg := Config{Plugins: []PluginConfig{{ID: "from_settings", BaseURL: "http://settings:8080"}}}
	if err := cfg.applyEnvironmentOverrides(); err != nil {
		t.Fatalf("applyEnvironmentOverrides: %v", err)
	}
	if len(cfg.Plugins) != 1 || cfg.Plugins[0].ID != "reference" {
		t.Fatalf("Plugins = %#v", cfg.Plugins)
	}

	if err := os.Setenv("ATLAS_PLUGINS", `{}`); err != nil {
		t.Fatal(err)
	}
	if err := (&Config{}).applyEnvironmentOverrides(); err == nil || !strings.Contains(err.Error(), "JSON array") {
		t.Fatalf("invalid override error = %v", err)
	}
}
