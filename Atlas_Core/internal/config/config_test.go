package config_test

import (
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/the-drunken-coder/atlas/atlas_core/internal/config"
)

// Keys read by config.Load() and loadSettingsFile — cleared so tests are not affected by stray process env.
var loadTestEnvKeys = []string{
	"MINIO_SECRET_KEY", "MINIO_SECRET_KEY_FILE",
	"DEBUG", "DATABASE_RECREATE_ON_STARTUP", "DATABASE_ECHO", "DATABASE_POOL_SIZE", "DATABASE_MAX_OVERFLOW",
	"DATABASE_POOL_RECYCLE", "DATABASE_POOL_TIMEOUT", "DATABASE_POOL_IDLE_TIMEOUT", "DATABASE_POOL_PRE_PING",
	"MINIO_SECURE", "MINIO_HTTP_POOL_SIZE", "MINIO_HTTP_POOL_TIMEOUT",
	"ENABLE_API_AUTH", "MAX_UPLOAD_SIZE_MB", "MAX_VIEW_SIZE_MB",
	"CHANGED_SINCE_SAFETY_LAG_MS",
	"SERVER_PORT", "LOG_LEVEL", "DATABASE_URL",
	"MINIO_ENDPOINT", "MINIO_EXTERNAL_ENDPOINT", "MINIO_ACCESS_KEY", "MINIO_BUCKET", "MINIO_REGION",
	"API_AUTH_KEY", "CORS_ORIGINS", "ALLOWED_ORIGINS",
}

func isolateLoadEnv(t *testing.T) {
	t.Helper()
	saved := make(map[string]string)
	for _, k := range loadTestEnvKeys {
		if v, ok := os.LookupEnv(k); ok {
			saved[k] = v
		}
		_ = os.Unsetenv(k)
	}
	t.Cleanup(func() {
		for _, k := range loadTestEnvKeys {
			if v, ok := saved[k]; ok {
				_ = os.Setenv(k, v)
			} else {
				_ = os.Unsetenv(k)
			}
		}
	})
}

func chdirToTemp(t *testing.T) {
	t.Helper()
	wd, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	tmp := t.TempDir()
	if err := os.Chdir(tmp); err != nil {
		t.Fatalf("chdir temp: %v", err)
	}
	t.Cleanup(func() { _ = os.Chdir(wd) })
}

func TestLoadConfig(t *testing.T) {
	chdirToTemp(t)
	isolateLoadEnv(t)
	t.Setenv("DATABASE_URL", "postgres://test@localhost:5432/test_db")
	t.Setenv("SERVER_PORT", "")
	t.Setenv("MINIO_BUCKET", "")
	t.Setenv("CORS_ORIGINS", "")
	t.Setenv("ALLOWED_ORIGINS", "")

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("Failed to load config: %v", err)
	}

	if cfg.DatabaseURL != "postgres://test@localhost:5432/test_db" {
		t.Errorf("Expected DATABASE_URL to be set, got %s", cfg.DatabaseURL)
	}

	if cfg.ServerPort != "8000" {
		t.Errorf("Expected default ServerPort to be 8000, got %s", cfg.ServerPort)
	}

	if !cfg.DatabaseRecreateOnStartup {
		t.Error("expected DATABASE_RECREATE_ON_STARTUP default true")
	}
}

func TestLoadDatabaseRecreateOnStartupFalse(t *testing.T) {
	chdirToTemp(t)
	isolateLoadEnv(t)
	t.Setenv("DATABASE_URL", "postgres://test@localhost:5432/test_db")
	t.Setenv("DATABASE_RECREATE_ON_STARTUP", "false")

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("Failed to load config: %v", err)
	}
	if cfg.DatabaseRecreateOnStartup {
		t.Fatal("expected DATABASE_RECREATE_ON_STARTUP=false")
	}
}

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
			t.Setenv("ALLOWED_ORIGINS", "")

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
			t.Setenv("ALLOWED_ORIGINS", "")

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

func TestDefaultCORSOriginsAreLocalOnly(t *testing.T) {
	for _, origin := range config.DefaultCORSOrigins {
		if !strings.HasPrefix(origin, "http://localhost:") && !strings.HasPrefix(origin, "http://127.0.0.1:") {
			t.Fatalf("default CORS origin must be local-only, got %q", origin)
		}
	}
}

func TestConfigDefaults(t *testing.T) {
	chdirToTemp(t)
	isolateLoadEnv(t)
	envVars := []string{
		"DATABASE_URL", "SERVER_PORT", "LOG_LEVEL",
		"DATABASE_POOL_SIZE", "DATABASE_MAX_OVERFLOW", "MINIO_BUCKET", "ENABLE_API_AUTH", "API_AUTH_KEY",
	}
	for _, v := range envVars {
		t.Setenv(v, "")
	}

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("Failed to load config: %v", err)
	}

	if cfg.DatabaseURL != "postgres://atlas@localhost:5432/atlas_core" {
		t.Errorf("Expected default DatabaseURL, got %s", cfg.DatabaseURL)
	}

	// Check defaults
	if cfg.ServerPort != "8000" {
		t.Errorf("Expected default ServerPort 8000, got %s", cfg.ServerPort)
	}
	if cfg.LogLevel != "INFO" {
		t.Errorf("Expected default LogLevel INFO, got %s", cfg.LogLevel)
	}
	if cfg.DatabasePoolSize != 5 {
		t.Errorf("Expected default DatabasePoolSize 5, got %d", cfg.DatabasePoolSize)
	}
	if cfg.DatabaseMaxOverflow != 10 {
		t.Errorf("Expected default DatabaseMaxOverflow 10, got %d", cfg.DatabaseMaxOverflow)
	}
	if cfg.MinioBucket != "atlas-media" {
		t.Errorf("Expected default MinioBucket atlas-media, got %s", cfg.MinioBucket)
	}
	if len(cfg.CORSOrigins) != len(config.DefaultCORSOrigins) {
		t.Errorf("Expected default CORS list length %d, got %d", len(config.DefaultCORSOrigins), len(cfg.CORSOrigins))
	}
	if cfg.MaxUploadSizeMB != 100 {
		t.Errorf("Expected default MaxUploadSizeMB 100, got %d", cfg.MaxUploadSizeMB)
	}
	if cfg.MaxViewSizeMB != 10 {
		t.Errorf("Expected default MaxViewSizeMB 10, got %d", cfg.MaxViewSizeMB)
	}
}

func TestLoadCopiesDefaultCORSOrigins(t *testing.T) {
	chdirToTemp(t)
	isolateLoadEnv(t)

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("Failed to load config: %v", err)
	}
	if len(cfg.CORSOrigins) == 0 {
		t.Fatal("expected default CORS origins")
	}

	originalDefault := config.DefaultCORSOrigins[0]
	cfg.CORSOrigins[0] = "http://mutated.example"

	if config.DefaultCORSOrigins[0] != originalDefault {
		t.Fatalf("mutating loaded config changed DefaultCORSOrigins: got %q", config.DefaultCORSOrigins[0])
	}
}

func TestLoadAllowedOriginsWhenCORSMissing(t *testing.T) {
	chdirToTemp(t)
	isolateLoadEnv(t)
	t.Setenv("DATABASE_URL", "postgres://test@localhost:5432/test_db")
	t.Setenv("SERVER_PORT", "")
	t.Setenv("MINIO_BUCKET", "")
	_ = os.Unsetenv("CORS_ORIGINS")
	t.Setenv("ALLOWED_ORIGINS", "http://one.example,http://two.example")

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if len(cfg.CORSOrigins) != 2 {
		t.Fatalf("expected 2 CORS origins from ALLOWED_ORIGINS, got %d", len(cfg.CORSOrigins))
	}
}

func TestLoadInvalidIntegerEnvFails(t *testing.T) {
	chdirToTemp(t)
	isolateLoadEnv(t)
	t.Setenv("DATABASE_URL", "postgres://test@localhost:5432/test_db")
	t.Setenv("DATABASE_POOL_SIZE", "not-an-int")

	_, err := config.Load()
	if err == nil {
		t.Fatal("expected error for invalid DATABASE_POOL_SIZE")
	}
	if !strings.Contains(err.Error(), "DATABASE_POOL_SIZE") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestLoadInvalidBoolEnvFails(t *testing.T) {
	chdirToTemp(t)
	isolateLoadEnv(t)
	t.Setenv("DATABASE_URL", "postgres://test@localhost:5432/test_db")
	t.Setenv("ENABLE_API_AUTH", "tru")

	_, err := config.Load()
	if err == nil {
		t.Fatal("expected error for invalid ENABLE_API_AUTH")
	}
}

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

func TestLoadAllowsEnabledAPIAuthWithKey(t *testing.T) {
	chdirToTemp(t)
	isolateLoadEnv(t)
	t.Setenv("ENABLE_API_AUTH", "true")
	t.Setenv("API_AUTH_KEY", "test-secret")

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
