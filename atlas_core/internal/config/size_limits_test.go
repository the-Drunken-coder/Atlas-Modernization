package config_test

import (
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/the-drunken-coder/atlas/atlas_core/internal/config"
)

func int64Ptr(v int64) *int64 {
	return &v
}

func TestLoadRejectsInvalidSizeLimitEnv(t *testing.T) {
	tests := []struct {
		name  string
		key   string
		value string
		want  string
	}{
		{name: "upload zero", key: "MAX_UPLOAD_SIZE_MB", value: "0", want: "MAX_UPLOAD_SIZE_MB"},
		{name: "upload too large", key: "MAX_UPLOAD_SIZE_MB", value: "10241", want: "MAX_UPLOAD_SIZE_MB"},
		{name: "view zero", key: "MAX_VIEW_SIZE_MB", value: "0", want: "MAX_VIEW_SIZE_MB"},
		{name: "view too large", key: "MAX_VIEW_SIZE_MB", value: "101", want: "MAX_VIEW_SIZE_MB"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			chdirToTemp(t)
			isolateLoadEnv(t)
			t.Setenv(tt.key, tt.value)

			_, err := config.Load()
			if err == nil {
				t.Fatalf("expected %s=%s to fail", tt.key, tt.value)
			}
			if !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("expected error to mention %s, got %v", tt.want, err)
			}
		})
	}
}

func TestLoadRejectsInvalidSizeLimitSettings(t *testing.T) {
	tests := []struct {
		name     string
		settings config.SettingsFile
		want     string
	}{
		{name: "upload zero", settings: config.SettingsFile{MaxUploadSizeMB: int64Ptr(0)}, want: "max_upload_size_mb"},
		{name: "upload too large", settings: config.SettingsFile{MaxUploadSizeMB: int64Ptr(10241)}, want: "max_upload_size_mb"},
		{name: "view zero", settings: config.SettingsFile{MaxViewSizeMB: int64Ptr(0)}, want: "max_view_size_mb"},
		{name: "view too large", settings: config.SettingsFile{MaxViewSizeMB: int64Ptr(101)}, want: "max_view_size_mb"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			chdirToTemp(t)
			isolateLoadEnv(t)
			data, err := json.Marshal(tt.settings)
			if err != nil {
				t.Fatalf("marshal settings: %v", err)
			}
			if err := os.WriteFile("atlas_core.settings.json", data, 0o600); err != nil {
				t.Fatalf("write settings: %v", err)
			}

			_, err = config.Load()
			if err == nil {
				t.Fatal("expected invalid settings size limit to fail")
			}
			if !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("expected error to mention %s, got %v", tt.want, err)
			}
		})
	}
}
