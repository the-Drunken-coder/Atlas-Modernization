package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
)

// SettingsFile represents the atlas_core.settings.json file structure.
type SettingsFile struct {
	Debug               bool     `json:"debug"`
	LogLevel            string   `json:"log_level"`
	CORSOrigins         []string `json:"cors_origins"`
	CORSOriginPatterns  []string `json:"cors_origin_patterns"`
	EnableAPIAuth       bool     `json:"enable_api_auth"`
	APIAuthKey          string   `json:"api_auth_key"`
	AdminCookieSameSite string   `json:"admin_cookie_samesite"`
	MaxUploadSizeMB     *int64   `json:"max_upload_size_mb"`
	MaxViewSizeMB       *int64   `json:"max_view_size_mb"`
}

const (
	maxUploadSizeMinMB int64 = 1
	maxUploadSizeMaxMB int64 = 10240
	maxViewSizeMinMB   int64 = 1
	maxViewSizeMaxMB   int64 = 100
)

func (c *Config) loadSettingsFile() error {
	paths := []string{
		"atlas_core.settings.json",
		"../atlas_core.settings.json",
	}

	var data []byte
	var lastErr error
	for _, path := range paths {
		// #nosec G304 -- paths are fixed literals above (settings discovery), not user-controlled.
		b, err := os.ReadFile(path)
		if err == nil {
			data = b
			lastErr = nil
			break
		}
		lastErr = err
		if !errors.Is(err, fs.ErrNotExist) && !os.IsNotExist(err) {
			return err
		}
	}
	if data == nil {
		return lastErr
	}
	if len(data) == 0 {
		return fmt.Errorf("settings file is empty")
	}

	var settings SettingsFile
	if err := json.Unmarshal(data, &settings); err != nil {
		return err
	}

	if _, ok := os.LookupEnv("LOG_LEVEL"); !ok && settings.LogLevel != "" {
		c.LogLevel = settings.LogLevel
	}
	if _, ok := os.LookupEnv("DEBUG"); !ok {
		c.Debug = settings.Debug
	}
	settingsHasCORSAllowlist := settings.CORSOrigins != nil || settings.CORSOriginPatterns != nil
	_, corsOriginsEnvSet := os.LookupEnv("CORS_ORIGINS")
	_, corsOriginPatternsEnvSet := os.LookupEnv("CORS_ORIGIN_PATTERNS")
	if settingsHasCORSAllowlist && !corsOriginsEnvSet && !corsOriginPatternsEnvSet {
		c.CORSOrigins = nil
		c.CORSOriginPatterns = nil
		if settings.CORSOrigins != nil {
			c.CORSOrigins = settings.CORSOrigins
		}
		if settings.CORSOriginPatterns != nil {
			c.CORSOriginPatterns = settings.CORSOriginPatterns
		}
	}
	if _, ok := os.LookupEnv("ENABLE_API_AUTH"); !ok {
		c.EnableAPIAuth = settings.EnableAPIAuth
	}
	if _, ok := os.LookupEnv("API_AUTH_KEY"); !ok {
		c.APIAuthKey = settings.APIAuthKey
	}
	if _, ok := os.LookupEnv("ATLAS_ADMIN_COOKIE_SAMESITE"); !ok && settings.AdminCookieSameSite != "" {
		c.AdminCookieSameSite = settings.AdminCookieSameSite
	}
	if _, ok := os.LookupEnv("MAX_UPLOAD_SIZE_MB"); !ok && settings.MaxUploadSizeMB != nil {
		c.MaxUploadSizeMB = *settings.MaxUploadSizeMB
	}
	if _, ok := os.LookupEnv("MAX_VIEW_SIZE_MB"); !ok && settings.MaxViewSizeMB != nil {
		c.MaxViewSizeMB = *settings.MaxViewSizeMB
	}

	return nil
}

func (c *Config) validateSizeLimits() error {
	if c.MaxUploadSizeMB < maxUploadSizeMinMB || c.MaxUploadSizeMB > maxUploadSizeMaxMB {
		return fmt.Errorf("MAX_UPLOAD_SIZE_MB/max_upload_size_mb must be between %d and %d MB (got %d)", maxUploadSizeMinMB, maxUploadSizeMaxMB, c.MaxUploadSizeMB)
	}
	if c.MaxViewSizeMB < maxViewSizeMinMB || c.MaxViewSizeMB > maxViewSizeMaxMB {
		return fmt.Errorf("MAX_VIEW_SIZE_MB/max_view_size_mb must be between %d and %d MB (got %d)", maxViewSizeMinMB, maxViewSizeMaxMB, c.MaxViewSizeMB)
	}
	return nil
}
