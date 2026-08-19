package config

import "os"

func loadFromEnvironment() (*Config, error) {
	minioSecret, err := loadMinIOSecretKey()
	if err != nil {
		return nil, err
	}

	dbRecreateOnStartup, err := getEnvBool("DATABASE_RECREATE_ON_STARTUP", false)
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

	return &Config{
		ServerPort:                getEnv("SERVER_PORT", "8000"),
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
	}, nil
}

func (c *Config) applyEnvironmentOverrides() error {
	if err := c.applyCORSOverrides(); err != nil {
		return err
	}
	if trustedProxyCIDRs, ok := os.LookupEnv("TRUSTED_PROXY_CIDRS"); ok {
		var err error
		c.TrustedProxyCIDRs, err = parseTrustedProxyCIDRs(trustedProxyCIDRs)
		if err != nil {
			return err
		}
	}
	return nil
}

func (c *Config) applyCORSOverrides() error {
	corsOrigins, originsSet := os.LookupEnv("CORS_ORIGINS")
	corsOriginPatterns, patternsSet := os.LookupEnv("CORS_ORIGIN_PATTERNS")
	if !originsSet && !patternsSet {
		return nil
	}

	// CORS origins and origin patterns form one allowlist. If either env var is
	// present, the environment owns the whole allowlist and omitted halves are empty.
	c.CORSOrigins = nil
	c.CORSOriginPatterns = nil
	if originsSet {
		var err error
		c.CORSOrigins, err = parseCORSOriginsValue(corsOrigins)
		if err != nil {
			return err
		}
	}
	if patternsSet {
		var err error
		c.CORSOriginPatterns, err = parseCORSOriginPatternsValue(corsOriginPatterns)
		if err != nil {
			return err
		}
	}
	return nil
}
