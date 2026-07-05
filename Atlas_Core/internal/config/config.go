// Package config handles configuration loading from environment variables and settings files.
package config

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
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
	DatabasePoolSize          int
	DatabaseMaxOverflow       int
	DatabasePoolRecycle       int
	DatabasePoolTimeout       int
	DatabasePoolIdleTimeout   int
	DatabasePoolPrePing       bool

	// MinIO/S3 settings
	MinIOEndpoint  string
	MinIOAccessKey string
	MinIOSecretKey string
	MinioBucket    string
	MinIOSecure    bool
	MinIORegion    string

	// CORS settings
	CORSOrigins        []string
	CORSOriginPatterns []string

	// API authentication
	EnableAPIAuth bool
	APIAuthKey    string

	// Browser admin sessions
	AdminCookieSameSite string

	// Upload limits
	MaxUploadSizeMB int64 // Maximum file upload size in megabytes
	MaxViewSizeMB   int64 // Maximum file size for inline viewing in megabytes

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
	cfg := &Config{
		ServerPort:                getEnv("SERVER_PORT", "8000"),
		Debug:                     debug,
		LogLevel:                  getEnv("LOG_LEVEL", "INFO"),
		DatabaseURL:               getEnv("DATABASE_URL", "postgres://atlas@localhost:5432/atlas_core"),
		DatabaseRecreateOnStartup: dbRecreateOnStartup,
		DatabasePoolSize:          dbPoolSize,
		DatabaseMaxOverflow:       dbMaxOverflow,
		DatabasePoolRecycle:       dbPoolRecycle,
		DatabasePoolTimeout:       dbPoolTimeout,
		DatabasePoolIdleTimeout:   dbIdleTimeout,
		DatabasePoolPrePing:       dbPrePing,

		MinIOEndpoint:  getEnv("MINIO_ENDPOINT", "localhost:9000"),
		MinIOAccessKey: getEnv("MINIO_ACCESS_KEY", "atlas"),
		MinIOSecretKey: minioSecret,
		MinioBucket:    getEnv("MINIO_BUCKET", "atlas-media"),
		MinIOSecure:    minioSecure,
		MinIORegion:    getEnv("MINIO_REGION", ""),

		CORSOrigins: append([]string(nil), DefaultCORSOrigins...),

		EnableAPIAuth:       enableAPIAuth,
		APIAuthKey:          getEnv("API_AUTH_KEY", ""),
		AdminCookieSameSite: getEnv("ATLAS_ADMIN_COOKIE_SAMESITE", "none"),

		MaxUploadSizeMB: maxUploadMB,
		MaxViewSizeMB:   maxViewMB,
	}

	// Load settings file if it exists
	if err := cfg.loadSettingsFile(); err != nil {
		if !os.IsNotExist(err) && !errors.Is(err, fs.ErrNotExist) {
			return nil, err
		}
	}
	if err := cfg.validateSizeLimits(); err != nil {
		return nil, err
	}

	// CORS origins and origin patterns form one allowlist. If either env var is
	// present, the environment owns the whole allowlist and omitted halves are empty.
	_, corsOriginsEnvSet := os.LookupEnv("CORS_ORIGINS")
	_, corsOriginPatternsEnvSet := os.LookupEnv("CORS_ORIGIN_PATTERNS")
	if corsOriginsEnvSet || corsOriginPatternsEnvSet {
		cfg.CORSOrigins = nil
		cfg.CORSOriginPatterns = nil
	}
	if corsOriginsEnvSet {
		origins, err := parseCORSOriginsValue(os.Getenv("CORS_ORIGINS"))
		if err != nil {
			return nil, err
		}
		cfg.CORSOrigins = origins
	}
	if corsOriginPatternsEnvSet {
		patterns, err := parseCORSOriginPatternsValue(os.Getenv("CORS_ORIGIN_PATTERNS"))
		if err != nil {
			return nil, err
		}
		cfg.CORSOriginPatterns = patterns
	}

	if err := validateCORSOrigins(cfg.CORSOrigins); err != nil {
		return nil, err
	}
	if err := validateCORSOriginPatterns(cfg.CORSOriginPatterns); err != nil {
		return nil, err
	}
	cfg.AdminCookieSameSite = strings.ToLower(strings.TrimSpace(cfg.AdminCookieSameSite))
	if cfg.AdminCookieSameSite == "" {
		cfg.AdminCookieSameSite = "none"
	}
	switch cfg.AdminCookieSameSite {
	case "lax", "none", "strict":
	default:
		return nil, fmt.Errorf("ATLAS_ADMIN_COOKIE_SAMESITE must be lax, none, or strict")
	}

	cfg.APIAuthKey, err = validateAPIAuthKey(cfg.EnableAPIAuth, cfg.APIAuthKey)
	if err != nil {
		return nil, err
	}

	return cfg, nil
}
