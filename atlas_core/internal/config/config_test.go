package config_test

import (
	"os"
	"strings"
	"testing"

	"github.com/the-drunken-coder/atlas/atlas_core/internal/config"
)

// Keys read by config.Load and its settings overlay. Tests clear these keys so
// process environment cannot affect configuration expectations.
var loadTestEnvKeys = []string{
	"MINIO_SECRET_KEY", "MINIO_SECRET_KEY_FILE",
	"DATABASE_RECREATE_ON_STARTUP", "DATABASE_POOL_SIZE", "DATABASE_MAX_OVERFLOW",
	"DATABASE_POOL_RECYCLE", "DATABASE_POOL_TIMEOUT", "DATABASE_POOL_IDLE_TIMEOUT", "DATABASE_POOL_PRE_PING",
	"MINIO_SECURE",
	"ENABLE_API_AUTH", "MAX_UPLOAD_SIZE_MB", "MAX_VIEW_SIZE_MB",
	"SERVER_PORT", "LOG_LEVEL", "DATABASE_URL",
	"MINIO_ENDPOINT", "MINIO_ACCESS_KEY", "MINIO_BUCKET", "MINIO_REGION",
	"API_AUTH_KEY", "CORS_ORIGINS", "CORS_ORIGIN_PATTERNS", "ATLAS_ADMIN_COOKIE_SAMESITE",
	"TRUSTED_PROXY_CIDRS", "ALLOWED_ORIGINS",
}

func isolateLoadEnv(t *testing.T) {
	t.Helper()
	saved := make(map[string]string)
	for _, key := range loadTestEnvKeys {
		if value, ok := os.LookupEnv(key); ok {
			saved[key] = value
		}
		_ = os.Unsetenv(key)
	}
	t.Cleanup(func() {
		for _, key := range loadTestEnvKeys {
			if value, ok := saved[key]; ok {
				_ = os.Setenv(key, value)
			} else {
				_ = os.Unsetenv(key)
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

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("failed to load config: %v", err)
	}
	if cfg.DatabaseURL != "postgres://test@localhost:5432/test_db" {
		t.Errorf("expected DATABASE_URL to be set, got %s", cfg.DatabaseURL)
	}
	if cfg.ServerPort != "8000" {
		t.Errorf("expected default ServerPort to be 8000, got %s", cfg.ServerPort)
	}
	if cfg.DatabaseRecreateOnStartup {
		t.Error("expected DATABASE_RECREATE_ON_STARTUP default false")
	}
}

func TestLoadDatabaseRecreateOnStartupTrue(t *testing.T) {
	chdirToTemp(t)
	isolateLoadEnv(t)
	t.Setenv("DATABASE_URL", "postgres://test@localhost:5432/test_db")
	t.Setenv("DATABASE_RECREATE_ON_STARTUP", "true")

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("failed to load config: %v", err)
	}
	if !cfg.DatabaseRecreateOnStartup {
		t.Fatal("expected DATABASE_RECREATE_ON_STARTUP=true")
	}
}

func TestConfigDefaults(t *testing.T) {
	chdirToTemp(t)
	isolateLoadEnv(t)
	for _, key := range []string{
		"DATABASE_URL", "SERVER_PORT", "LOG_LEVEL",
		"DATABASE_POOL_SIZE", "DATABASE_MAX_OVERFLOW", "MINIO_BUCKET", "ENABLE_API_AUTH", "API_AUTH_KEY",
	} {
		t.Setenv(key, "")
	}

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("failed to load config: %v", err)
	}
	if cfg.DatabaseURL != "postgres://atlas@localhost:5432/atlas_core" {
		t.Errorf("expected default DatabaseURL, got %s", cfg.DatabaseURL)
	}
	if cfg.ServerPort != "8000" {
		t.Errorf("expected default ServerPort 8000, got %s", cfg.ServerPort)
	}
	if cfg.LogLevel != "INFO" {
		t.Errorf("expected default LogLevel INFO, got %s", cfg.LogLevel)
	}
	if cfg.DatabasePoolSize != 5 {
		t.Errorf("expected default DatabasePoolSize 5, got %d", cfg.DatabasePoolSize)
	}
	if cfg.DatabaseMaxOverflow != 10 {
		t.Errorf("expected default DatabaseMaxOverflow 10, got %d", cfg.DatabaseMaxOverflow)
	}
	if cfg.MinioBucket != "atlas-media" {
		t.Errorf("expected default MinioBucket atlas-media, got %s", cfg.MinioBucket)
	}
	if len(cfg.CORSOrigins) != len(config.DefaultCORSOrigins) {
		t.Errorf("expected default CORS list length %d, got %d", len(config.DefaultCORSOrigins), len(cfg.CORSOrigins))
	}
	if len(cfg.CORSOriginPatterns) != 0 {
		t.Errorf("expected no default CORS origin patterns, got %d", len(cfg.CORSOriginPatterns))
	}
	if cfg.MaxUploadSizeMB != 100 {
		t.Errorf("expected default MaxUploadSizeMB 100, got %d", cfg.MaxUploadSizeMB)
	}
	if cfg.MaxViewSizeMB != 10 {
		t.Errorf("expected default MaxViewSizeMB 10, got %d", cfg.MaxViewSizeMB)
	}
	if cfg.AdminCookieSameSite != "none" {
		t.Errorf("expected default AdminCookieSameSite none, got %s", cfg.AdminCookieSameSite)
	}
}

func TestLoadCopiesDefaultCORSOrigins(t *testing.T) {
	chdirToTemp(t)
	isolateLoadEnv(t)

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("failed to load config: %v", err)
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

func TestLoadIgnoresAllowedOriginsAlias(t *testing.T) {
	chdirToTemp(t)
	isolateLoadEnv(t)
	t.Setenv("DATABASE_URL", "postgres://test@localhost:5432/test_db")
	t.Setenv("SERVER_PORT", "")
	t.Setenv("MINIO_BUCKET", "")
	t.Setenv("ALLOWED_ORIGINS", "http://one.example,http://two.example")

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if len(cfg.CORSOrigins) != len(config.DefaultCORSOrigins) {
		t.Fatalf("expected ALLOWED_ORIGINS to be ignored, got %d CORS origins", len(cfg.CORSOrigins))
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
