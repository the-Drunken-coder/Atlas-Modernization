package database

import (
	"strings"
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

func TestCoreSchemaTables(t *testing.T) {
	want := []string{"entities", "tasks", "objects", "deletions"}
	if len(coreSchemaTables) != len(want) {
		t.Fatalf("expected %d core tables, got %d", len(want), len(coreSchemaTables))
	}
	for i, name := range want {
		if coreSchemaTables[i] != name {
			t.Fatalf("coreSchemaTables[%d] = %q, want %q", i, coreSchemaTables[i], name)
		}
	}
}

func TestCoreSchemaCreateDDLIncludesCursorIndexes(t *testing.T) {
	ddl := strings.Join(coreSchemaCreateDDL(), "\n")
	want := []string{
		"CREATE INDEX idx_entities_created_cursor ON entities(created_at DESC, entity_id DESC)",
		"CREATE INDEX idx_entities_updated_cursor ON entities(updated_at DESC, entity_id DESC)",
		"CREATE INDEX idx_tasks_created_cursor ON tasks(created_at DESC, task_id DESC)",
		"CREATE INDEX idx_tasks_updated_cursor ON tasks(updated_at DESC, task_id DESC)",
		"CREATE INDEX idx_tasks_entity_created_cursor ON tasks(entity_id, created_at DESC, task_id DESC)",
		"CREATE INDEX idx_tasks_entity_updated_cursor ON tasks(entity_id, updated_at DESC, task_id DESC)",
		"CREATE INDEX idx_objects_created_cursor ON objects(created_at DESC, object_id DESC)",
		"CREATE INDEX idx_objects_updated_cursor ON objects(updated_at DESC, object_id DESC)",
		"CREATE INDEX idx_deletions_type_deleted_cursor ON deletions(resource_type, deleted_at DESC, resource_id DESC)",
	}

	for _, stmt := range want {
		if !strings.Contains(ddl, stmt) {
			t.Fatalf("expected core schema DDL to include %q", stmt)
		}
	}
}
