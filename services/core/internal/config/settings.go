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
	LogLevel            string   `json:"log_level"`
	CORSOrigins         []string `json:"cors_origins"`
	CORSOriginPatterns  []string `json:"cors_origin_patterns"`
	EnableAPIAuth       bool     `json:"enable_api_auth"`
	APIAuthKey          string   `json:"api_auth_key"`
	AdminCookieSameSite string   `json:"admin_cookie_samesite"`
	MaxUploadSizeMB     *int64   `json:"max_upload_size_mb"`
	MaxViewSizeMB       *int64   `json:"max_view_size_mb"`
}

func (c *Config) loadSettingsFile() error {
	data, err := readSettingsFile()
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) || os.IsNotExist(err) {
			return nil
		}
		return err
	}
	if len(data) == 0 {
		return fmt.Errorf("settings file is empty")
	}

	var settings SettingsFile
	if err := json.Unmarshal(data, &settings); err != nil {
		return err
	}
	settings.applyTo(c)
	return nil
}

func readSettingsFile() ([]byte, error) {
	paths := []string{
		"atlas_core.settings.json",
		"../atlas_core.settings.json",
	}

	var lastErr error
	for _, path := range paths {
		// #nosec G304 -- paths are fixed literals above (settings discovery), not user-controlled.
		data, err := os.ReadFile(path)
		if err == nil {
			return data, nil
		}
		lastErr = err
		if !errors.Is(err, fs.ErrNotExist) && !os.IsNotExist(err) {
			return nil, err
		}
	}
	return nil, lastErr
}

func (s SettingsFile) applyTo(c *Config) {
	if _, ok := os.LookupEnv("LOG_LEVEL"); !ok && s.LogLevel != "" {
		c.LogLevel = s.LogLevel
	}
	if s.hasCORSAllowlist() {
		s.applyCORSAllowlist(c)
	}
	if _, ok := os.LookupEnv("ENABLE_API_AUTH"); !ok {
		c.EnableAPIAuth = s.EnableAPIAuth
	}
	if _, ok := os.LookupEnv("API_AUTH_KEY"); !ok {
		c.APIAuthKey = s.APIAuthKey
	}
	if _, ok := os.LookupEnv("ATLAS_ADMIN_COOKIE_SAMESITE"); !ok && s.AdminCookieSameSite != "" {
		c.AdminCookieSameSite = s.AdminCookieSameSite
	}
	if _, ok := os.LookupEnv("MAX_UPLOAD_SIZE_MB"); !ok && s.MaxUploadSizeMB != nil {
		c.MaxUploadSizeMB = *s.MaxUploadSizeMB
	}
	if _, ok := os.LookupEnv("MAX_VIEW_SIZE_MB"); !ok && s.MaxViewSizeMB != nil {
		c.MaxViewSizeMB = *s.MaxViewSizeMB
	}
}

func (s SettingsFile) hasCORSAllowlist() bool {
	return s.CORSOrigins != nil || s.CORSOriginPatterns != nil
}

func (s SettingsFile) applyCORSAllowlist(c *Config) {
	c.CORSOrigins = nil
	c.CORSOriginPatterns = nil
	if s.CORSOrigins != nil {
		c.CORSOrigins = s.CORSOrigins
	}
	if s.CORSOriginPatterns != nil {
		c.CORSOriginPatterns = s.CORSOriginPatterns
	}
}
