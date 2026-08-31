package config

import (
	"os"
	"path/filepath"
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

func TestPluginEndpointFragmentsLoadSortedAndFailClosed(t *testing.T) {
	directory := t.TempDir()
	write := func(name, contents string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(directory, name), []byte(contents), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write("20_second.json", `{"id":"second","base_url":"http://second:8080"}`)
	write("10_first.json", `{"id":"first","base_url":"http://first:8080"}`)
	cfg := Config{}
	if err := cfg.loadPluginEndpointFragments(directory); err != nil {
		t.Fatal(err)
	}
	if got := []string{cfg.Plugins[0].ID, cfg.Plugins[1].ID}; got[0] != "first" || got[1] != "second" {
		t.Fatalf("Plugin order = %v", got)
	}

	write("30_invalid.json", `{"id":"third"}`)
	if err := cfg.loadPluginEndpointFragments(directory); err != nil {
		t.Fatalf("fragment decoding should leave semantic validation to validatePlugins: %v", err)
	}
	if err := cfg.validatePlugins(); err == nil || !strings.Contains(err.Error(), "plain HTTP origin") {
		t.Fatalf("partial fragment error = %v", err)
	}

	write("40_unknown.json", `{"id":"fourth","base_url":"http://fourth:8080","unknown":true}`)
	if err := cfg.loadPluginEndpointFragments(directory); err == nil || !strings.Contains(err.Error(), "unknown") {
		t.Fatalf("unknown field error = %v", err)
	}
}
