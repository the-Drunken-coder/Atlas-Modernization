package database

import (
	"testing"
	"time"

	"github.com/the-drunken-coder/atlas/atlas_core/internal/config"
)

func TestBuildPoolConfigRejectsInvalidDatabaseURL(t *testing.T) {
	_, err := buildPoolConfig(&config.Config{
		DatabaseURL: "not a valid postgres url",
	})
	if err == nil {
		t.Fatal("expected invalid database URL to fail")
	}
}

func TestBuildPoolConfigAppliesPoolSettingsAndCaps(t *testing.T) {
	cfg := &config.Config{
		DatabaseURL:             "postgres://user:pass@localhost:5432/dbname",
		DatabasePoolSize:        900,
		DatabaseMaxOverflow:     500,
		DatabasePoolRecycle:     3600,
		DatabasePoolIdleTimeout: 45,
		DatabasePoolPrePing:     true,
	}

	poolConfig, err := buildPoolConfig(cfg)
	if err != nil {
		t.Fatalf("expected valid config, got error: %v", err)
	}

	if poolConfig.MaxConns != 1000 {
		t.Fatalf("expected MaxConns to be capped at 1000, got %d", poolConfig.MaxConns)
	}
	if poolConfig.MinConns != 900 {
		t.Fatalf("expected MinConns 900, got %d", poolConfig.MinConns)
	}
	if poolConfig.MaxConnLifetime != time.Hour {
		t.Fatalf("expected MaxConnLifetime 1h, got %v", poolConfig.MaxConnLifetime)
	}
	if poolConfig.MaxConnIdleTime != 45*time.Second {
		t.Fatalf("expected MaxConnIdleTime 45s, got %v", poolConfig.MaxConnIdleTime)
	}
	if poolConfig.HealthCheckPeriod != 30*time.Second {
		t.Fatalf("expected HealthCheckPeriod 30s when pre-ping enabled, got %v", poolConfig.HealthCheckPeriod)
	}
}

func TestBuildPoolConfigCapsMinConnsIndependently(t *testing.T) {
	cfg := &config.Config{
		DatabaseURL:             "postgres://user:pass@localhost:5432/dbname",
		DatabasePoolSize:        5000,
		DatabaseMaxOverflow:     0,
		DatabasePoolRecycle:     120,
		DatabasePoolIdleTimeout: 15,
	}

	poolConfig, err := buildPoolConfig(cfg)
	if err != nil {
		t.Fatalf("expected valid config, got error: %v", err)
	}

	if poolConfig.MinConns != 1000 {
		t.Fatalf("expected MinConns to be capped at 1000, got %d", poolConfig.MinConns)
	}
	if poolConfig.MaxConns != 1000 {
		t.Fatalf("expected MaxConns to be capped at 1000, got %d", poolConfig.MaxConns)
	}
}

func TestBuildPoolConfigClampsNegativePoolSettings(t *testing.T) {
	cfg := &config.Config{
		DatabaseURL:             "postgres://user:pass@localhost:5432/dbname",
		DatabasePoolSize:        -5,
		DatabaseMaxOverflow:     -10,
		DatabasePoolRecycle:     120,
		DatabasePoolIdleTimeout: 15,
	}

	poolConfig, err := buildPoolConfig(cfg)
	if err != nil {
		t.Fatalf("expected valid config, got error: %v", err)
	}

	if poolConfig.MinConns != 1 {
		t.Fatalf("expected MinConns to be at least 1 when MaxConns >= 1, got %d", poolConfig.MinConns)
	}
	if poolConfig.MaxConns != 1 {
		t.Fatalf("expected MaxConns to be at least 1, got %d", poolConfig.MaxConns)
	}
}

func TestBuildPoolConfigClampsMinConnsWhenGreaterThanMaxConns(t *testing.T) {
	cfg := &config.Config{
		DatabaseURL:             "postgres://user:pass@localhost:5432/dbname",
		DatabasePoolSize:        100,
		DatabaseMaxOverflow:     -200,
		DatabasePoolRecycle:     120,
		DatabasePoolIdleTimeout: 15,
	}

	poolConfig, err := buildPoolConfig(cfg)
	if err != nil {
		t.Fatalf("expected valid config, got error: %v", err)
	}

	// maxConns = 100 + (-200) -> clamped to 1; minConns would be 100 but must not exceed maxConns
	if poolConfig.MaxConns != 1 {
		t.Fatalf("expected MaxConns 1, got %d", poolConfig.MaxConns)
	}
	if poolConfig.MinConns != 1 {
		t.Fatalf("expected MinConns clamped down to MaxConns (1), got %d", poolConfig.MinConns)
	}
}

func TestCloseHandlesNilPool(t *testing.T) {
	db := &DB{}

	db.Close()
}
