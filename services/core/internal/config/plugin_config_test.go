package config

import (
	"bufio"
	"context"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
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
		{baseURL: "http://REFERENCE.example", want: "http://REFERENCE.example"},
		{baseURL: "http://reference_plugin:8080", want: "http://reference_plugin:8080"},
		{baseURL: "http://ab--cd.example", want: "http://ab--cd.example"},
		{baseURL: "http://bücher.example", want: "http://xn--bcher-kva.example"},
		{baseURL: "http://BÜCHER.example", want: "http://xn--bcher-kva.example"},
		{baseURL: "http://BÜCHER.example:8080", want: "http://xn--bcher-kva.example:8080"},
		{baseURL: "http://ΟΣ.example", want: "http://xn--0xai.example"},
		{baseURL: "http://bücher.example.", want: "http://xn--bcher-kva.example."},
		{baseURL: "http://bücher.example.:8080", want: "http://xn--bcher-kva.example.:8080"},
		{baseURL: "http://reference_plugin.bücher.example", want: "http://reference_plugin.xn--bcher-kva.example"},
		{baseURL: "http://ab--cd.bücher.example", want: "http://ab--cd.xn--bcher-kva.example"},
		{baseURL: "http://bücher.xn--caf-dma.example", want: "http://xn--bcher-kva.xn--caf-dma.example"},
		{baseURL: "http://reference.", want: "http://reference."},
		{baseURL: "http://127.0.0.1", want: "http://127.0.0.1"},
		{baseURL: "http://[::1]", want: "http://[::1]"},
		{baseURL: "http://[::1]:8080", want: "http://[::1]:8080"},
		{baseURL: "http://[fe80::1%25eth0]", want: "http://[fe80::1%25eth0]"},
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
		{{ID: "reference", BaseURL: "http://K.example"}},
		{{ID: "reference", BaseURL: "http://Å.example"}},
		{{ID: "reference", BaseURL: "http://bu\u0308cher.example"}},
		{{ID: "reference", BaseURL: "http://a..example"}},
		{{ID: "reference", BaseURL: "http://-reference.example"}},
		{{ID: "reference", BaseURL: "http://reference-.example"}},
		{{ID: "reference", BaseURL: "http://xn--abc-.example"}},
		{{ID: "reference", BaseURL: "http://xn----bga.example"}},
		{{ID: "reference", BaseURL: "http://xn--ab---epa.example"}},
		{{ID: "reference", BaseURL: "http://-ü.example"}},
		{{ID: "reference", BaseURL: "http://ü-.example"}},
		{{ID: "reference", BaseURL: "http://ab--ü.example"}},
		{{ID: "reference", BaseURL: "http://bü--cher.example"}},
		{{ID: "reference", BaseURL: "http://999.999.999.999"}},
		{{ID: "reference", BaseURL: "http://01.02.03.04"}},
		{{ID: "reference", BaseURL: "http://127.0.0.1."}},
		{{ID: "reference", BaseURL: "http://" + strings.Repeat("a", 64) + ".example"}},
		{{ID: "reference", BaseURL: "http://" + strings.Repeat("a.", 127) + "a"}},
		{{ID: "reference", BaseURL: "http://" + strings.Repeat("a.", 121) + "bücher"}},
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

func TestPluginConfigurationAcceptsFullUnicodeCaseMappings(t *testing.T) {
	cfg := Config{Plugins: []PluginConfig{{ID: "reference", BaseURL: "http://İ.example"}}}
	if err := cfg.validatePlugins(); err != nil {
		t.Fatal(err)
	}
	if got, want := cfg.Plugins[0].BaseURL, "http://xn--i-9bb.example"; got != want {
		t.Fatalf("BaseURL = %q, want %q", got, want)
	}
}

func TestPluginConfigurationCanonicalizesUnicodeForDialAndHost(t *testing.T) {
	cfg := Config{Plugins: []PluginConfig{{ID: "reference", BaseURL: "http://BÜCHER.example"}}}
	if err := cfg.validatePlugins(); err != nil {
		t.Fatal(err)
	}
	if got, want := cfg.Plugins[0].BaseURL, "http://xn--bcher-kva.example"; got != want {
		t.Fatalf("BaseURL = %q, want %q", got, want)
	}

	type requestResult struct {
		host string
		err  error
	}
	dialed := make(chan string, 1)
	requestRead := make(chan requestResult, 1)
	transport := &http.Transport{
		Proxy: nil,
		DialContext: func(_ context.Context, _, address string) (net.Conn, error) {
			dialed <- address
			client, server := net.Pipe()
			go func() {
				defer func() { _ = server.Close() }()
				request, err := http.ReadRequest(bufio.NewReader(server))
				if err != nil {
					requestRead <- requestResult{err: err}
					return
				}
				requestRead <- requestResult{host: request.Host}
				_, _ = server.Write([]byte("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n"))
			}()
			return client, nil
		},
	}
	t.Cleanup(transport.CloseIdleConnections)
	client := &http.Client{Transport: transport, Timeout: time.Second}
	response, err := client.Get(cfg.Plugins[0].BaseURL + "/health")
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()

	if got, want := <-dialed, "xn--bcher-kva.example:80"; got != want {
		t.Fatalf("dial address = %q, want %q", got, want)
	}
	result := <-requestRead
	if result.err != nil {
		t.Fatal(result.err)
	}
	if got, want := result.host, "xn--bcher-kva.example"; got != want {
		t.Fatalf("Host = %q, want %q", got, want)
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
