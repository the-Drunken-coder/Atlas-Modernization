package config_test

import (
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/the-drunken-coder/atlas/atlas_core/internal/config"
)

func TestLoadRejectsEnabledAPIAuthWithEmptyEnvKey(t *testing.T) {
	chdirToTemp(t)
	isolateLoadEnv(t)
	settings := config.SettingsFile{
		EnableAPIAuth: true,
		APIAuthKey:    "from-settings",
	}
	data, err := json.Marshal(settings)
	if err != nil {
		t.Fatalf("marshal settings: %v", err)
	}
	if err := os.WriteFile("atlas_core.settings.json", data, 0o600); err != nil {
		t.Fatalf("write settings: %v", err)
	}

	t.Setenv("API_AUTH_KEY", "")

	_, err = config.Load()
	if err == nil {
		t.Fatal("expected enabled API auth with empty API_AUTH_KEY to fail")
	}
	if !strings.Contains(err.Error(), "API_AUTH_KEY") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestLoadRejectsEnabledAPIAuthWithEmptySettingsKey(t *testing.T) {
	chdirToTemp(t)
	isolateLoadEnv(t)
	settings := config.SettingsFile{
		EnableAPIAuth: true,
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
		t.Fatal("expected enabled API auth with empty settings key to fail")
	}
	if !strings.Contains(err.Error(), "API_AUTH_KEY") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestLoadRejectsEnabledAPIAuthWithPlaceholderKey(t *testing.T) {
	for _, apiKey := range []string{
		"changeme",
		"000000",
		"111111",
		"123456",
		"abcd1234",
		"admin",
		"apikey",
		"asdf",
		"default",
		"dummy",
		"example",
		"key",
		"password",
		"password123",
		"placeholder",
		"qwerty",
		"replace_with_secure_key",
		"REPLACE_WITH_STRONG_BOOTSTRAP_KEY",
		"your-secure-api-key",
		"secret",
		"test",
		"your-key-here",
		" changeme ",
		"CHANGEME",
		"PlAcEhOlDeR",
		"12345678",
		"87654321",
		"abcdefgh",
		"hgfedcba",
		"password1234",
		"letmein-now",
		"welcome-home",
		"abababababab",
		"€aaaaaaa",
		"KKKABC",
		"ÅåÅåÅåx1",
		"éøåßéøåß",
		"٠١٢٣٤٥x",
		string([]byte{0xff, 'A', 'z', 'B', 'y', 'C', 'x', 'D'}),
	} {
		t.Run(apiKey, func(t *testing.T) {
			chdirToTemp(t)
			isolateLoadEnv(t)
			t.Setenv("ENABLE_API_AUTH", "true")
			t.Setenv("API_AUTH_KEY", apiKey)

			_, err := config.Load()
			if err == nil {
				t.Fatalf("expected enabled API auth with placeholder API_AUTH_KEY %q to fail", apiKey)
			}
			if !strings.Contains(err.Error(), "too weak") {
				t.Fatalf("unexpected error: %v", err)
			}
			trimmed := strings.TrimSpace(apiKey)
			if strings.Contains(err.Error(), trimmed) {
				t.Fatalf("placeholder error should not echo API_AUTH_KEY %q, got %v", trimmed, err)
			}
		})
	}
}

func TestLoadRejectsEnabledAPIAuthWithPlaceholderSettingsKey(t *testing.T) {
	chdirToTemp(t)
	isolateLoadEnv(t)
	settings := config.SettingsFile{
		EnableAPIAuth: true,
		APIAuthKey:    " changeme ",
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
		t.Fatal("expected enabled API auth with placeholder settings api_auth_key to fail")
	}
	if !strings.Contains(err.Error(), "too weak") {
		t.Fatalf("unexpected error: %v", err)
	}
	if strings.Contains(err.Error(), "changeme") {
		t.Fatalf("placeholder error should not echo settings api_auth_key, got %v", err)
	}
}

func TestLoadAllowsEnabledAPIAuthWithKey(t *testing.T) {
	chdirToTemp(t)
	isolateLoadEnv(t)
	t.Setenv("ENABLE_API_AUTH", "true")
	t.Setenv("API_AUTH_KEY", "  test-secret\n")

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("load config: %v", err)
	}
	if !cfg.EnableAPIAuth {
		t.Fatal("expected API auth to be enabled")
	}
	if cfg.APIAuthKey != "test-secret" {
		t.Fatalf("expected API auth key from env, got %q", cfg.APIAuthKey)
	}
}
