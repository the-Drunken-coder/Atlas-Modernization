package config_test

import (
	"encoding/json"
	"net/netip"
	"os"
	"reflect"
	"strings"
	"testing"

	"github.com/the-drunken-coder/atlas/atlas_core/internal/config"
)

func TestParseCORSOrigins(t *testing.T) {
	tests := []struct {
		name     string
		envValue string
		expected int
	}{
		{
			name:     "JSON array",
			envValue: `["http://localhost:3000", "http://localhost:8080"]`,
			expected: 2,
		},
		{
			name:     "Comma separated",
			envValue: "http://localhost:3000,http://localhost:8080",
			expected: 2,
		},
		{
			name:     "Explicit empty CORS_ORIGINS means no origins",
			envValue: "",
			expected: 0,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			chdirToTemp(t)
			isolateLoadEnv(t)
			t.Setenv("DATABASE_URL", "postgres://test@localhost:5432/test_db")
			t.Setenv("SERVER_PORT", "")
			t.Setenv("MINIO_BUCKET", "")
			t.Setenv("CORS_ORIGINS", tt.envValue)

			cfg, err := config.Load()
			if err != nil {
				t.Fatalf("Failed to load config: %v", err)
			}

			if len(cfg.CORSOrigins) != tt.expected {
				t.Errorf("Expected %d CORS origins, got %d", tt.expected, len(cfg.CORSOrigins))
			}
		})
	}
}

func TestCORSOriginsRejectsWildcard(t *testing.T) {
	for _, value := range []string{"*", "https://*.example.com", "https://*"} {
		t.Run(value, func(t *testing.T) {
			chdirToTemp(t)
			isolateLoadEnv(t)
			t.Setenv("DATABASE_URL", "postgres://test@localhost:5432/test_db")
			t.Setenv("SERVER_PORT", "")
			t.Setenv("MINIO_BUCKET", "")
			t.Setenv("CORS_ORIGINS", value)

			_, err := config.Load()
			if err == nil {
				t.Fatalf("expected Load to reject CORS_ORIGINS=%q", value)
			}
			if !strings.Contains(err.Error(), "wildcard") {
				t.Fatalf("expected wildcard error, got: %v", err)
			}
		})
	}
}

func TestCORSOriginsRejectNonOriginValues(t *testing.T) {
	for _, value := range []string{
		"https://atlas.example/path",
		"https://atlas.example?debug=true",
		"https://user@atlas.example",
		"ftp://atlas.example",
		"atlas.example",
	} {
		t.Run(value, func(t *testing.T) {
			chdirToTemp(t)
			isolateLoadEnv(t)
			t.Setenv("DATABASE_URL", "postgres://test@localhost:5432/test_db")
			t.Setenv("SERVER_PORT", "")
			t.Setenv("MINIO_BUCKET", "")
			t.Setenv("CORS_ORIGINS", value)

			_, err := config.Load()
			if err == nil {
				t.Fatalf("expected Load to reject CORS_ORIGINS=%q", value)
			}
			if !strings.Contains(err.Error(), "CORS origins") {
				t.Fatalf("expected CORS origins error, got: %v", err)
			}
		})
	}
}

func TestParseCORSOriginPatterns(t *testing.T) {
	tests := []struct {
		name     string
		envValue string
		expected []string
	}{
		{
			name:     "JSON array",
			envValue: `["https://*.atlas-je0.pages.dev"]`,
			expected: []string{"https://*.atlas-je0.pages.dev"},
		},
		{
			name:     "Comma separated",
			envValue: "https://*.atlas-je0.pages.dev, https://*-atlas-preview.example.com",
			expected: []string{
				"https://*.atlas-je0.pages.dev",
				"https://*-atlas-preview.example.com",
			},
		},
		{
			name:     "Explicit empty CORS_ORIGIN_PATTERNS means no patterns",
			envValue: "",
			expected: []string{},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			chdirToTemp(t)
			isolateLoadEnv(t)
			t.Setenv("CORS_ORIGIN_PATTERNS", tt.envValue)

			cfg, err := config.Load()
			if err != nil {
				t.Fatalf("Failed to load config: %v", err)
			}

			if !reflect.DeepEqual(cfg.CORSOriginPatterns, tt.expected) {
				t.Errorf("CORSOriginPatterns = %#v, want %#v", cfg.CORSOriginPatterns, tt.expected)
			}
		})
	}
}

func TestCORSOriginPatternsRejectUnsafeWildcards(t *testing.T) {
	for _, value := range []string{
		"*",
		"https://*",
		"https://*.workers.dev",
		"https://*.pages.dev",
		"https://app-*.co.uk",
		"https://pr-*.github.io",
		"https://atlas.example/*",
		"https://*-atlas.example.com/path",
	} {
		t.Run(value, func(t *testing.T) {
			chdirToTemp(t)
			isolateLoadEnv(t)
			t.Setenv("CORS_ORIGIN_PATTERNS", value)

			_, err := config.Load()
			if err == nil {
				t.Fatalf("expected Load to reject CORS_ORIGIN_PATTERNS=%q", value)
			}
			if !strings.Contains(err.Error(), "CORS origin patterns") {
				t.Fatalf("expected CORS origin patterns error, got: %v", err)
			}
		})
	}
}

func TestLoadTrustedProxyCIDRs(t *testing.T) {
	chdirToTemp(t)
	isolateLoadEnv(t)
	t.Setenv("TRUSTED_PROXY_CIDRS", "172.30.0.3/32, 2001:db8:1::5/128")

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("load config: %v", err)
	}
	want := []netip.Prefix{
		netip.MustParsePrefix("172.30.0.3/32"),
		netip.MustParsePrefix("2001:db8:1::5/128"),
	}
	if !reflect.DeepEqual(cfg.TrustedProxyCIDRs, want) {
		t.Fatalf("TrustedProxyCIDRs = %#v, want %#v", cfg.TrustedProxyCIDRs, want)
	}
}

func TestLoadTrustedProxyCIDRsDefaultsEmpty(t *testing.T) {
	chdirToTemp(t)
	isolateLoadEnv(t)

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("load config: %v", err)
	}
	if len(cfg.TrustedProxyCIDRs) != 0 {
		t.Fatalf("TrustedProxyCIDRs = %#v, want empty", cfg.TrustedProxyCIDRs)
	}
}

func TestLoadTrustedProxyCIDRsRejectsUnsafeValues(t *testing.T) {
	for _, value := range []string{
		"172.30.0.3",
		"not-a-cidr",
		"10.20.30.40/8",
		"2001:db8::5/64",
		"0.0.0.0/0",
		"::/0",
		"::ffff:172.30.0.3/128",
	} {
		t.Run(value, func(t *testing.T) {
			chdirToTemp(t)
			isolateLoadEnv(t)
			t.Setenv("TRUSTED_PROXY_CIDRS", value)

			_, err := config.Load()
			if err == nil || !strings.Contains(err.Error(), "TRUSTED_PROXY_CIDRS") {
				t.Fatalf("Load() error = %v, want trusted-proxy CIDR error", err)
			}
		})
	}
}

func TestCORSOriginPatternsRejectUnsafeSettingsValues(t *testing.T) {
	for _, value := range []string{"https://*.workers.dev", " "} {
		t.Run(value, func(t *testing.T) {
			chdirToTemp(t)
			isolateLoadEnv(t)
			settings := config.SettingsFile{
				CORSOriginPatterns: []string{value},
			}
			data, err := json.Marshal(settings)
			if err != nil {
				t.Fatalf("marshal settings: %v", err)
			}
			if err := os.WriteFile("atlas_core.settings.json", data, 0o600); err != nil {
				t.Fatalf("write settings: %v", err)
			}

			_, err = config.Load()
			if err == nil {
				t.Fatalf("expected Load to reject settings CORS origin pattern %q", value)
			}
			if !strings.Contains(err.Error(), "CORS origin patterns") {
				t.Fatalf("expected CORS origin patterns error, got: %v", err)
			}
		})
	}
}

func TestLoadCORSOriginPatternsFromSettingsWithEnvPrecedence(t *testing.T) {
	chdirToTemp(t)
	isolateLoadEnv(t)
	settings := config.SettingsFile{
		CORSOrigins:        []string{"https://from-settings.example.com"},
		CORSOriginPatterns: []string{"https://*-from-settings.example.com"},
	}
	data, err := json.Marshal(settings)
	if err != nil {
		t.Fatalf("marshal settings: %v", err)
	}
	if err := os.WriteFile("atlas_core.settings.json", data, 0o600); err != nil {
		t.Fatalf("write settings: %v", err)
	}

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("load config: %v", err)
	}
	if got, want := strings.Join(cfg.CORSOriginPatterns, ","), "https://*-from-settings.example.com"; got != want {
		t.Fatalf("settings CORSOriginPatterns = %q, want %q", got, want)
	}
	if got, want := strings.Join(cfg.CORSOrigins, ","), "https://from-settings.example.com"; got != want {
		t.Fatalf("settings CORSOrigins = %q, want %q", got, want)
	}

	t.Setenv("CORS_ORIGIN_PATTERNS", "https://*-from-env.example.com")
	cfg, err = config.Load()
	if err != nil {
		t.Fatalf("reload config: %v", err)
	}
	if got, want := strings.Join(cfg.CORSOriginPatterns, ","), "https://*-from-env.example.com"; got != want {
		t.Fatalf("env CORSOriginPatterns = %q, want %q", got, want)
	}
	if len(cfg.CORSOrigins) != 0 {
		t.Fatalf("origin-pattern env should clear exact origins, got %#v", cfg.CORSOrigins)
	}

	t.Setenv("CORS_ORIGIN_PATTERNS", "")
	cfg, err = config.Load()
	if err != nil {
		t.Fatalf("reload config with explicit empty env: %v", err)
	}
	if len(cfg.CORSOriginPatterns) != 0 {
		t.Fatalf("explicit empty env should clear settings patterns, got %#v", cfg.CORSOriginPatterns)
	}
	if len(cfg.CORSOrigins) != 0 {
		t.Fatalf("explicit empty env should keep exact origins clear, got %#v", cfg.CORSOrigins)
	}
}

func TestLoadCORSOriginsEnvClearsSettingsPatterns(t *testing.T) {
	chdirToTemp(t)
	isolateLoadEnv(t)
	settings := config.SettingsFile{
		CORSOrigins:        []string{"https://from-settings.example.com"},
		CORSOriginPatterns: []string{"https://*-from-settings.example.com"},
	}
	data, err := json.Marshal(settings)
	if err != nil {
		t.Fatalf("marshal settings: %v", err)
	}
	if err := os.WriteFile("atlas_core.settings.json", data, 0o600); err != nil {
		t.Fatalf("write settings: %v", err)
	}
	t.Setenv("CORS_ORIGINS", "https://from-env.example.com")

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("load config: %v", err)
	}
	if got, want := strings.Join(cfg.CORSOrigins, ","), "https://from-env.example.com"; got != want {
		t.Fatalf("env CORSOrigins = %q, want %q", got, want)
	}
	if len(cfg.CORSOriginPatterns) != 0 {
		t.Fatalf("origin env should clear settings patterns, got %#v", cfg.CORSOriginPatterns)
	}
}

func TestExplicitEmptyCORSEnvOwnsWholeAllowlist(t *testing.T) {
	tests := []struct {
		name        string
		setOrigins  bool
		setPatterns bool
	}{
		{name: "origins only", setOrigins: true},
		{name: "patterns only", setPatterns: true},
		{name: "both origins and patterns", setOrigins: true, setPatterns: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			chdirToTemp(t)
			isolateLoadEnv(t)
			settings := config.SettingsFile{
				CORSOrigins:        []string{"https://from-settings.example.com"},
				CORSOriginPatterns: []string{"https://*-from-settings.example.com"},
			}
			data, err := json.Marshal(settings)
			if err != nil {
				t.Fatalf("marshal settings: %v", err)
			}
			if err := os.WriteFile("atlas_core.settings.json", data, 0o600); err != nil {
				t.Fatalf("write settings: %v", err)
			}
			if tt.setOrigins {
				t.Setenv("CORS_ORIGINS", "")
			}
			if tt.setPatterns {
				t.Setenv("CORS_ORIGIN_PATTERNS", "")
			}

			cfg, err := config.Load()
			if err != nil {
				t.Fatalf("load config: %v", err)
			}
			if len(cfg.CORSOrigins) != 0 || len(cfg.CORSOriginPatterns) != 0 {
				t.Fatalf("explicit empty CORS env must own whole allowlist, got origins=%#v patterns=%#v", cfg.CORSOrigins, cfg.CORSOriginPatterns)
			}
		})
	}
}

func TestMalformedCORSEnvPrecedesFinalValidation(t *testing.T) {
	chdirToTemp(t)
	isolateLoadEnv(t)
	settings := config.SettingsFile{
		EnableAPIAuth: true,
		APIAuthKey:    "changeme",
	}
	data, err := json.Marshal(settings)
	if err != nil {
		t.Fatalf("marshal settings: %v", err)
	}
	if err := os.WriteFile("atlas_core.settings.json", data, 0o600); err != nil {
		t.Fatalf("write settings: %v", err)
	}
	t.Setenv("CORS_ORIGINS", "https://atlas.example/path")

	_, err = config.Load()
	if err == nil {
		t.Fatal("expected malformed CORS env to fail")
	}
	if !strings.Contains(err.Error(), "CORS origins") {
		t.Fatalf("expected CORS error before final validation, got %v", err)
	}
	if strings.Contains(err.Error(), "too weak") {
		t.Fatalf("expected final API auth validation not to run after malformed CORS env, got %v", err)
	}
}

func TestDefaultCORSOriginsAreLocalOnly(t *testing.T) {
	for _, origin := range config.DefaultCORSOrigins {
		if !strings.HasPrefix(origin, "http://localhost:") && !strings.HasPrefix(origin, "http://127.0.0.1:") {
			t.Fatalf("default CORS origin must be local-only, got %q", origin)
		}
	}
}
