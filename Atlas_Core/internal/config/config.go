// Package config handles configuration loading from environment variables and settings files.
package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"strconv"
	"strings"
)

// Config holds all application configuration.
type Config struct {
	// Server settings
	ServerPort string
	Debug      bool
	LogLevel   string

	// Database settings
	DatabaseURL               string
	DatabaseRecreateOnStartup bool
	DatabaseEcho              bool
	DatabasePoolSize          int
	DatabaseMaxOverflow       int
	DatabasePoolRecycle       int
	DatabasePoolTimeout       int
	DatabasePoolIdleTimeout   int
	DatabasePoolPrePing       bool

	// MinIO/S3 settings
	MinIOEndpoint         string
	MinIOExternalEndpoint string
	MinIOAccessKey        string
	MinIOSecretKey        string
	MinioBucket           string
	MinIOSecure           bool
	MinIORegion           string
	MinIOHTTPPoolSize     int
	MinIOHTTPPoolTimeout  int

	// CORS settings
	CORSOrigins []string

	// API authentication
	EnableAPIAuth bool
	APIAuthKey    string

	// Upload limits
	MaxUploadSizeMB int64 // Maximum file upload size in megabytes
	MaxViewSizeMB   int64 // Maximum file size for inline viewing in megabytes

	// ChangedSinceSafetyLagMS lags the watermark returned by /queries/changed-since
	// behind the read snapshot. It must exceed the longest gap between a writer
	// stamping updated_at and that write becoming visible (commit), so the
	// incremental sync stream cannot skip a row whose commit lands after a
	// poller's snapshot. See docs/problems/2026-05-29-changed-since-lost-update.md.
	ChangedSinceSafetyLagMS int
}

// MaxChangedSinceSafetyLagMS caps the configured safety lag to a sane upper bound.
const MaxChangedSinceSafetyLagMS = 60000

// SettingsFile represents the atlas_core.settings.json file structure.
type SettingsFile struct {
	Debug           bool     `json:"debug"`
	LogLevel        string   `json:"log_level"`
	CORSOrigins     []string `json:"cors_origins"`
	EnableAPIAuth   bool     `json:"enable_api_auth"`
	APIAuthKey      string   `json:"api_auth_key"`
	MaxUploadSizeMB int64    `json:"max_upload_size_mb"`
	MaxViewSizeMB   int64    `json:"max_view_size_mb"`
}

// DefaultCORSOrigins are the default allowed origins for CORS.
var DefaultCORSOrigins = []string{
	"http://localhost:3000",
	"http://localhost:8080",
	"http://localhost:5173",
	"http://localhost:5175",
	"http://localhost:4173",
	"http://127.0.0.1:3000",
	"http://127.0.0.1:8080",
	"http://127.0.0.1:5173",
	"http://127.0.0.1:5175",
	"http://127.0.0.1:4173",
}

// Load loads configuration from environment variables and settings file.
// Environment variables take precedence over settings file values.
func Load() (*Config, error) {
	minioSecret, err := loadMinIOSecretKey()
	if err != nil {
		return nil, err
	}

	debug, err := getEnvBool("DEBUG", false)
	if err != nil {
		return nil, err
	}
	dbRecreateOnStartup, err := getEnvBool("DATABASE_RECREATE_ON_STARTUP", true)
	if err != nil {
		return nil, err
	}
	dbEcho, err := getEnvBool("DATABASE_ECHO", false)
	if err != nil {
		return nil, err
	}
	dbPoolSize, err := getEnvInt("DATABASE_POOL_SIZE", 5)
	if err != nil {
		return nil, err
	}
	dbMaxOverflow, err := getEnvInt("DATABASE_MAX_OVERFLOW", 10)
	if err != nil {
		return nil, err
	}
	dbPoolRecycle, err := getEnvInt("DATABASE_POOL_RECYCLE", 3600)
	if err != nil {
		return nil, err
	}
	dbPoolTimeout, err := getEnvInt("DATABASE_POOL_TIMEOUT", 30)
	if err != nil {
		return nil, err
	}
	dbIdleTimeout, err := getEnvInt("DATABASE_POOL_IDLE_TIMEOUT", 600)
	if err != nil {
		return nil, err
	}
	dbPrePing, err := getEnvBool("DATABASE_POOL_PRE_PING", true)
	if err != nil {
		return nil, err
	}
	minioSecure, err := getEnvBool("MINIO_SECURE", false)
	if err != nil {
		return nil, err
	}
	minioHTTPPoolSize, err := getEnvInt("MINIO_HTTP_POOL_SIZE", 10)
	if err != nil {
		return nil, err
	}
	minioHTTPPoolTimeout, err := getEnvInt("MINIO_HTTP_POOL_TIMEOUT", 30)
	if err != nil {
		return nil, err
	}
	enableAPIAuth, err := getEnvBool("ENABLE_API_AUTH", false)
	if err != nil {
		return nil, err
	}
	maxUploadMB, err := getEnvInt64("MAX_UPLOAD_SIZE_MB", 100)
	if err != nil {
		return nil, err
	}
	maxViewMB, err := getEnvInt64("MAX_VIEW_SIZE_MB", 10)
	if err != nil {
		return nil, err
	}
	if maxUploadMB < 0 {
		return nil, fmt.Errorf("invalid MAX_UPLOAD_SIZE_MB: %d", maxUploadMB)
	}
	if maxViewMB < 0 {
		return nil, fmt.Errorf("invalid MAX_VIEW_SIZE_MB: %d", maxViewMB)
	}
	changedSinceLagMS, err := getEnvInt("CHANGED_SINCE_SAFETY_LAG_MS", 2000)
	if err != nil {
		return nil, err
	}
	if changedSinceLagMS < 0 {
		return nil, fmt.Errorf("invalid CHANGED_SINCE_SAFETY_LAG_MS: %d", changedSinceLagMS)
	}
	if changedSinceLagMS > MaxChangedSinceSafetyLagMS {
		changedSinceLagMS = MaxChangedSinceSafetyLagMS
	}

	cfg := &Config{
		ServerPort:                getEnv("SERVER_PORT", "8000"),
		Debug:                     debug,
		LogLevel:                  getEnv("LOG_LEVEL", "INFO"),
		DatabaseURL:               getEnv("DATABASE_URL", "postgres://atlas@localhost:5432/atlas_core"),
		DatabaseRecreateOnStartup: dbRecreateOnStartup,
		DatabaseEcho:              dbEcho,
		DatabasePoolSize:          dbPoolSize,
		DatabaseMaxOverflow:       dbMaxOverflow,
		DatabasePoolRecycle:       dbPoolRecycle,
		DatabasePoolTimeout:       dbPoolTimeout,
		DatabasePoolIdleTimeout:   dbIdleTimeout,
		DatabasePoolPrePing:       dbPrePing,

		MinIOEndpoint:         getEnv("MINIO_ENDPOINT", "localhost:9000"),
		MinIOExternalEndpoint: getEnv("MINIO_EXTERNAL_ENDPOINT", ""),
		MinIOAccessKey:        getEnv("MINIO_ACCESS_KEY", "atlas"),
		MinIOSecretKey:        minioSecret,
		MinioBucket:           getEnv("MINIO_BUCKET", "atlas-media"),
		MinIOSecure:           minioSecure,
		MinIORegion:           getEnv("MINIO_REGION", ""),
		MinIOHTTPPoolSize:     minioHTTPPoolSize,
		MinIOHTTPPoolTimeout:  minioHTTPPoolTimeout,

		CORSOrigins: append([]string(nil), DefaultCORSOrigins...),

		EnableAPIAuth: enableAPIAuth,
		APIAuthKey:    getEnv("API_AUTH_KEY", ""),

		MaxUploadSizeMB: maxUploadMB,
		MaxViewSizeMB:   maxViewMB,

		ChangedSinceSafetyLagMS: changedSinceLagMS,
	}

	// Load settings file if it exists
	if err := cfg.loadSettingsFile(); err != nil {
		if !os.IsNotExist(err) && !errors.Is(err, fs.ErrNotExist) {
			return nil, err
		}
	}

	// Override CORS origins from environment when explicitly set (including empty = deny all).
	if _, ok := os.LookupEnv("CORS_ORIGINS"); ok {
		origins, err := parseCORSOriginsValue(os.Getenv("CORS_ORIGINS"))
		if err != nil {
			return nil, err
		}
		cfg.CORSOrigins = origins
	} else if _, ok := os.LookupEnv("ALLOWED_ORIGINS"); ok {
		origins, err := parseCORSOriginsValue(os.Getenv("ALLOWED_ORIGINS"))
		if err != nil {
			return nil, err
		}
		cfg.CORSOrigins = origins
	}

	if err := validateCORSOrigins(cfg.CORSOrigins); err != nil {
		return nil, err
	}

	if cfg.EnableAPIAuth && strings.TrimSpace(cfg.APIAuthKey) == "" {
		return nil, fmt.Errorf("ENABLE_API_AUTH is true but API_AUTH_KEY is empty")
	}

	return cfg, nil
}

// loadSettingsFile loads settings from atlas_core.settings.json.
func (c *Config) loadSettingsFile() error {
	// Try current directory first, then parent directory
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

	// Apply settings (env vars take precedence, so only set if not already set via env)
	if os.Getenv("LOG_LEVEL") == "" && settings.LogLevel != "" {
		c.LogLevel = settings.LogLevel
	}
	if _, ok := os.LookupEnv("DEBUG"); !ok {
		c.Debug = settings.Debug
	}
	if settings.CORSOrigins != nil {
		if _, ok := os.LookupEnv("CORS_ORIGINS"); !ok {
			if _, ok2 := os.LookupEnv("ALLOWED_ORIGINS"); !ok2 {
				c.CORSOrigins = settings.CORSOrigins
			}
		}
	}
	if _, ok := os.LookupEnv("ENABLE_API_AUTH"); !ok {
		c.EnableAPIAuth = settings.EnableAPIAuth
	}
	if _, ok := os.LookupEnv("API_AUTH_KEY"); !ok {
		c.APIAuthKey = settings.APIAuthKey
	}

	// Load upload limits from settings (env vars take precedence)
	if os.Getenv("MAX_UPLOAD_SIZE_MB") == "" && settings.MaxUploadSizeMB > 0 {
		c.MaxUploadSizeMB = settings.MaxUploadSizeMB
	}
	if os.Getenv("MAX_VIEW_SIZE_MB") == "" && settings.MaxViewSizeMB > 0 {
		c.MaxViewSizeMB = settings.MaxViewSizeMB
	}

	return nil
}

// getEnv returns an environment variable value or a default.
func getEnv(key, defaultVal string) string {
	if val := os.Getenv(key); val != "" {
		return val
	}
	return defaultVal
}

// getEnvBool returns an environment variable as a boolean.
func getEnvBool(key string, defaultVal bool) (bool, error) {
	v, ok := os.LookupEnv(key)
	if !ok {
		return defaultVal, nil
	}
	val := strings.TrimSpace(v)
	if val == "" {
		return defaultVal, nil
	}
	switch strings.ToLower(val) {
	case "true", "1", "yes", "on":
		return true, nil
	case "false", "0", "no", "off":
		return false, nil
	default:
		return false, fmt.Errorf("invalid boolean for %s: %q", key, v)
	}
}

// getEnvInt returns an environment variable as an integer.
func getEnvInt(key string, defaultVal int) (int, error) {
	v, ok := os.LookupEnv(key)
	if !ok {
		return defaultVal, nil
	}
	val := strings.TrimSpace(v)
	if val == "" {
		return defaultVal, nil
	}
	i, err := strconv.Atoi(val)
	if err != nil {
		return 0, fmt.Errorf("invalid integer for %s: %q", key, v)
	}
	return i, nil
}

// getEnvInt64 returns an environment variable as an int64.
func getEnvInt64(key string, defaultVal int64) (int64, error) {
	v, ok := os.LookupEnv(key)
	if !ok {
		return defaultVal, nil
	}
	val := strings.TrimSpace(v)
	if val == "" {
		return defaultVal, nil
	}
	i, err := strconv.ParseInt(val, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("invalid integer for %s: %q", key, v)
	}
	return i, nil
}

// loadMinIOSecretKey reads the MinIO secret from env or MINIO_SECRET_KEY_FILE.
func loadMinIOSecretKey() (string, error) {
	if key := strings.TrimSpace(os.Getenv("MINIO_SECRET_KEY")); key != "" {
		return key, nil
	}
	if keyFile := strings.TrimSpace(os.Getenv("MINIO_SECRET_KEY_FILE")); keyFile != "" {
		// #nosec G304 G703 -- path comes from operator env (MINIO_SECRET_KEY_FILE), not request input.
		data, err := os.ReadFile(keyFile)
		if err != nil {
			return "", fmt.Errorf("read MINIO_SECRET_KEY_FILE %s: %w", keyFile, err)
		}
		key := strings.TrimSpace(string(data))
		if key == "" {
			return "", fmt.Errorf("MINIO_SECRET_KEY_FILE %s is empty", keyFile)
		}
		return key, nil
	}
	return "", nil
}

// parseCORSOriginsValue parses CORS origins when the env var is explicitly set.
// Empty or whitespace-only means no allowed origins (not the compile-time defaults).
// Values that look like JSON arrays must parse as JSON; invalid JSON is rejected (no CSV fallback).
func parseCORSOriginsValue(raw string) ([]string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return []string{}, nil
	}

	if strings.HasPrefix(raw, "[") {
		var origins []string
		if err := json.Unmarshal([]byte(raw), &origins); err != nil {
			return nil, fmt.Errorf("CORS origins: invalid JSON array: %w", err)
		}
		result := make([]string, 0, len(origins))
		for _, o := range origins {
			if trimmed := strings.TrimSpace(o); trimmed != "" {
				result = append(result, trimmed)
			}
		}
		return result, validateCORSOrigins(result)
	}

	parts := strings.Split(raw, ",")
	result := make([]string, 0, len(parts))
	for _, p := range parts {
		if trimmed := strings.TrimSpace(p); trimmed != "" {
			result = append(result, trimmed)
		}
	}
	return result, validateCORSOrigins(result)
}

// validateCORSOrigins rejects wildcard origins so production origins must be explicit.
func validateCORSOrigins(origins []string) error {
	for _, o := range origins {
		if strings.Contains(o, "*") {
			return fmt.Errorf("CORS origins: wildcard origin %q is not allowed; configure explicit origins", o)
		}
	}
	return nil
}
