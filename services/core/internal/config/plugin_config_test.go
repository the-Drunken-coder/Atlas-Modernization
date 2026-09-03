package config

import (
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPluginConfigurationNormalizesAndRejectsInvalidEndpoints(t *testing.T) {
	for _, test := range []struct {
		baseURL string
		want    string
	}{
		{baseURL: "http://reference", want: "http://reference"},
		{baseURL: "http://reference:1", want: "http://reference:1"},
		{baseURL: "http://reference:8080", want: "http://reference:8080"},
		{baseURL: " http://reference:8080/ ", want: "http://reference:8080"},
		{baseURL: "http://reference:65535", want: "http://reference:65535"},
		{baseURL: "http://ab--cd.example", want: "http://ab--cd.example"},
		{baseURL: "http://bücher.example", want: "http://bücher.example"},
		{baseURL: "http://reference.", want: "http://reference."},
		{baseURL: "http://127.0.0.1", want: "http://127.0.0.1"},
		{baseURL: "http://[::1]", want: "http://[::1]"},
		{baseURL: "http://[::1]:8080", want: "http://[::1]:8080"},
	} {
		cfg := Config{Plugins: []PluginConfig{{ID: " reference ", BaseURL: test.baseURL}}}
		if err := cfg.validatePlugins(); err != nil {
			t.Fatalf("validatePlugins(%q): %v", test.baseURL, err)
		}
		if got := cfg.Plugins[0]; got.ID != "reference" || got.BaseURL != test.want {
			t.Fatalf("normalized Plugin = %#v", got)
		}
	}

	for _, plugins := range [][]PluginConfig{
		{{ID: "reference-plugin", BaseURL: "http://reference:8080"}},
		{{ID: "reference", BaseURL: "https://reference:8080"}},
		{{ID: "reference", BaseURL: "http://user:password@reference:8080"}},
		{{ID: "reference", BaseURL: "http://reference:8080/path"}},
		{{ID: "reference", BaseURL: "http://reference:8080?query"}},
		{{ID: "reference", BaseURL: "http://reference:8080?"}},
		{{ID: "reference", BaseURL: "http://reference:8080#fragment"}},
		{{ID: "reference", BaseURL: "http://reference:8080#"}},
		{{ID: "reference", BaseURL: "http://:8080"}},
		{{ID: "reference", BaseURL: "http://reference]:8080"}},
		{{ID: "reference", BaseURL: "http://foo;bar"}},
		{{ID: "reference", BaseURL: "http://foo%25bar"}},
		{{ID: "reference", BaseURL: "http://b%C3%BCcher.example"}},
		{{ID: "reference", BaseURL: "http://foo\u00adbar.example"}},
		{{ID: "reference", BaseURL: "http://ｅｘａｍｐｌｅ.com"}},
		{{ID: "reference", BaseURL: "http://a..example"}},
		{{ID: "reference", BaseURL: "http://-reference.example"}},
		{{ID: "reference", BaseURL: "http://reference-.example"}},
		{{ID: "reference", BaseURL: "http://" + strings.Repeat("a", 64) + ".example"}},
		{{ID: "reference", BaseURL: "http://" + strings.Repeat("a.", 127) + "a"}},
		{{ID: "reference", BaseURL: "http://reference:"}},
		{{ID: "reference", BaseURL: "http://[::1]:"}},
		{{ID: "reference", BaseURL: "http://reference:0"}},
		{{ID: "reference", BaseURL: "http://reference:65536"}},
		{{ID: "reference", BaseURL: "http://reference:8080"}, {ID: "reference", BaseURL: "http://other:8080"}},
	} {
		if err := (&Config{Plugins: plugins}).validatePlugins(); err == nil {
			t.Fatalf("validatePlugins accepted %#v", plugins)
		}
	}
}

func TestPluginConfigurationRejectsUnbracketedIPv6WithRelaxedURLParsing(t *testing.T) {
	t.Setenv("GODEBUG", "urlstrictcolons=0")
	const baseURL = "http://2001:db8::1:8080"
	if _, err := url.Parse(baseURL); err != nil {
		t.Fatalf("relaxed URL parsing is not active: %v", err)
	}
	cfg := Config{Plugins: []PluginConfig{{ID: "reference", BaseURL: baseURL}}}
	if err := cfg.validatePlugins(); err == nil {
		t.Fatal("validatePlugins accepted unbracketed IPv6")
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

	if err := os.Remove(filepath.Join(directory, "40_unknown.json")); err != nil {
		t.Fatal(err)
	}
	write("40_oversized.json", strings.Repeat(" ", maxPluginEndpointFragmentBytes+1))
	if err := cfg.loadPluginEndpointFragments(directory); err == nil || !strings.Contains(err.Error(), "1 to") {
		t.Fatalf("oversized fragment error = %v", err)
	}
}
