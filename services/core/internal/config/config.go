// Package config handles configuration loading from environment variables and settings files.
package config

import (
	"net/netip"
	"os"
)

type PluginConfig struct {
	ID      string `json:"id"`
	BaseURL string `json:"base_url"`
}

// Config holds all application configuration.
type Config struct {
	// Server settings
	ServerPort string
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

	// Browser admin sessions and login throttling
	AdminCookieSameSite string
	TrustedProxyCIDRs   []netip.Prefix

	// Upload limits
	MaxUploadSizeMB int64 // Maximum file upload size in megabytes
	MaxViewSizeMB   int64 // Maximum file size for inline viewing in megabytes

	// Private Plugin endpoints managed by the deployment.
	Plugins []PluginConfig
}

// Load loads configuration from environment variables and settings file.
// Environment variables take precedence over settings file values.
func Load() (*Config, error) {
	cfg, err := loadFromEnvironment()
	if err != nil {
		return nil, err
	}
	if err := cfg.loadSettingsFile(); err != nil {
		return nil, err
	}
	if err := cfg.validateSizeLimits(); err != nil {
		return nil, err
	}
	if err := cfg.applyEnvironmentOverrides(); err != nil {
		return nil, err
	}
	if err := cfg.loadPluginEndpointFragments(os.Getenv("ATLAS_PLUGIN_CONFIG_DIR")); err != nil {
		return nil, err
	}
	if err := cfg.validate(); err != nil {
		return nil, err
	}
	return cfg, nil
}
