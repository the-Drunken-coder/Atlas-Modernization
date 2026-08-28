package config_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/the-drunken-coder/atlas/services/core/internal/config"
)

func TestLoadAdminCookieSameSiteFromSettingsWithEnvPrecedence(t *testing.T) {
	chdirToTemp(t)
	isolateLoadEnv(t)
	settings := config.SettingsFile{AdminCookieSameSite: "lax"}
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
	if cfg.AdminCookieSameSite != "lax" {
		t.Fatalf("AdminCookieSameSite = %q, want lax", cfg.AdminCookieSameSite)
	}

	t.Setenv("ATLAS_ADMIN_COOKIE_SAMESITE", "strict")
	cfg, err = config.Load()
	if err != nil {
		t.Fatalf("reload config: %v", err)
	}
	if cfg.AdminCookieSameSite != "strict" {
		t.Fatalf("AdminCookieSameSite with env = %q, want strict", cfg.AdminCookieSameSite)
	}
}

func TestLoadSettingsDoesNotOverrideExplicitEmptyEnv(t *testing.T) {
	chdirToTemp(t)
	isolateLoadEnv(t)
	settings := config.SettingsFile{
		LogLevel:        "DEBUG",
		MaxUploadSizeMB: int64Ptr(250),
		MaxViewSizeMB:   int64Ptr(25),
	}
	data, err := json.Marshal(settings)
	if err != nil {
		t.Fatalf("marshal settings: %v", err)
	}
	if err := os.WriteFile("atlas_core.settings.json", data, 0o600); err != nil {
		t.Fatalf("write settings: %v", err)
	}

	t.Setenv("LOG_LEVEL", "")
	t.Setenv("MAX_UPLOAD_SIZE_MB", "")
	t.Setenv("MAX_VIEW_SIZE_MB", "")

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("load config: %v", err)
	}
	if cfg.LogLevel != "INFO" {
		t.Fatalf("expected explicit empty LOG_LEVEL to keep env default INFO, got %q", cfg.LogLevel)
	}
	if cfg.MaxUploadSizeMB != 100 {
		t.Fatalf("expected explicit empty MAX_UPLOAD_SIZE_MB to keep env default 100, got %d", cfg.MaxUploadSizeMB)
	}
	if cfg.MaxViewSizeMB != 10 {
		t.Fatalf("expected explicit empty MAX_VIEW_SIZE_MB to keep env default 10, got %d", cfg.MaxViewSizeMB)
	}
}

func TestLoadSettingsFileDiscovery(t *testing.T) {
	tests := []struct {
		name         string
		writeCurrent bool
		currentLevel string
		parentLevel  string
		wantLogLevel string
	}{
		{
			name:         "current directory wins",
			writeCurrent: true,
			currentLevel: "CURRENT",
			parentLevel:  "PARENT",
			wantLogLevel: "CURRENT",
		},
		{
			name:         "parent directory fallback",
			parentLevel:  "PARENT",
			wantLogLevel: "PARENT",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			isolateLoadEnv(t)
			root := t.TempDir()
			workingDir := filepath.Join(root, "work")
			if err := os.Mkdir(workingDir, 0o700); err != nil {
				t.Fatalf("make working directory: %v", err)
			}
			wd, err := os.Getwd()
			if err != nil {
				t.Fatalf("getwd: %v", err)
			}
			if err := os.Chdir(workingDir); err != nil {
				t.Fatalf("chdir working directory: %v", err)
			}
			t.Cleanup(func() { _ = os.Chdir(wd) })

			writeSettings := func(path, level string) {
				t.Helper()
				data, err := json.Marshal(config.SettingsFile{LogLevel: level})
				if err != nil {
					t.Fatalf("marshal settings: %v", err)
				}
				if err := os.WriteFile(path, data, 0o600); err != nil {
					t.Fatalf("write settings: %v", err)
				}
			}
			writeSettings(filepath.Join(root, "atlas_core.settings.json"), tt.parentLevel)
			if tt.writeCurrent {
				writeSettings(filepath.Join(workingDir, "atlas_core.settings.json"), tt.currentLevel)
			}

			cfg, err := config.Load()
			if err != nil {
				t.Fatalf("load config: %v", err)
			}
			if cfg.LogLevel != tt.wantLogLevel {
				t.Fatalf("LogLevel = %q, want %q", cfg.LogLevel, tt.wantLogLevel)
			}
		})
	}
}
