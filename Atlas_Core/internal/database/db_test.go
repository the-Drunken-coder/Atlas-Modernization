package database

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
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
	want := []string{"entities", "tasks", "objects", "deletions", "storage_deletion_outbox"}
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
		"CREATE TABLE storage_deletion_outbox",
		"UNIQUE (bucket, path)",
		"CREATE INDEX idx_storage_deletion_outbox_next_attempt ON storage_deletion_outbox(next_attempt_at, id)",
	}

	for _, stmt := range want {
		if !strings.Contains(ddl, stmt) {
			t.Fatalf("expected core schema DDL to include %q", stmt)
		}
	}
}

func TestCoreSchemaCreateDDLConstrainsPositiveVersions(t *testing.T) {
	ddl := strings.Join(coreSchemaCreateDDL(), "\n")
	want := []string{
		"CONSTRAINT entities_version_positive CHECK (version > 0)",
		"CONSTRAINT tasks_version_positive CHECK (version > 0)",
		"CONSTRAINT objects_version_positive CHECK (version > 0)",
		"CONSTRAINT deletions_version_positive CHECK (version > 0)",
	}

	for _, stmt := range want {
		if !strings.Contains(ddl, stmt) {
			t.Fatalf("expected core schema DDL to include %q", stmt)
		}
	}
}

func TestCoreSchemaPositiveVersionConstraintsRejectInvalidWrites(t *testing.T) {
	dbURL, explicitDBURL := databaseTestURL()
	if dbURL == "" {
		t.Skip("set ATLAS_DATABASE_TEST_URL, DATABASE_URL, or POSTGRES_PASSWORD to run DB-backed schema constraint tests")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	conn, err := pgx.Connect(ctx, dbURL)
	if err != nil {
		if explicitDBURL {
			t.Fatalf("connect test database: %v", err)
		}
		t.Skipf("test database unavailable: %v", err)
	}
	defer func() {
		if err := conn.Close(context.Background()); err != nil {
			t.Errorf("close test database connection: %v", err)
		}
	}()

	schema := fmt.Sprintf("atlas_schema_constraint_test_%d", time.Now().UTC().UnixNano())
	quotedSchema := pgx.Identifier{schema}.Sanitize()
	if _, err := conn.Exec(ctx, "CREATE SCHEMA "+quotedSchema); err != nil {
		if explicitDBURL {
			t.Fatalf("create test schema: %v", err)
		}
		t.Skipf("test database unavailable: %v", err)
	}
	defer func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		if _, err := conn.Exec(cleanupCtx, "DROP SCHEMA IF EXISTS "+quotedSchema+" CASCADE"); err != nil {
			t.Errorf("drop test schema %s: %v", schema, err)
		}
	}()

	if _, err := conn.Exec(ctx, "SET search_path TO "+quotedSchema); err != nil {
		t.Fatalf("set test schema search_path: %v", err)
	}
	for _, stmt := range coreSchemaCreateDDL() {
		if _, err := conn.Exec(ctx, stmt); err != nil {
			t.Fatalf("apply schema DDL %q: %v", stmt, err)
		}
	}

	tests := []struct {
		name       string
		constraint string
		sql        string
	}{
		{
			name:       "entities",
			constraint: "entities_version_positive",
			sql:        `INSERT INTO entities (entity_id, type, version) VALUES ($1, 'asset', $2)`,
		},
		{
			name:       "tasks",
			constraint: "tasks_version_positive",
			sql:        `INSERT INTO tasks (task_id, status, version) VALUES ($1, 'pending', $2)`,
		},
		{
			name:       "objects",
			constraint: "objects_version_positive",
			sql:        `INSERT INTO objects (object_id, version) VALUES ($1, $2)`,
		},
		{
			name:       "deletions",
			constraint: "deletions_version_positive",
			sql:        `INSERT INTO deletions (resource_type, resource_id, version) VALUES ('entity', $1, $2)`,
		},
	}

	for _, tt := range tests {
		for _, version := range []int64{0, -1} {
			t.Run(fmt.Sprintf("%s_%d", tt.name, version), func(t *testing.T) {
				_, err := conn.Exec(ctx, tt.sql, fmt.Sprintf("%s-%d", tt.name, version), version)
				assertConstraintViolation(t, err, tt.constraint)
			})
		}
		t.Run(tt.name+"_positive", func(t *testing.T) {
			if _, err := conn.Exec(ctx, tt.sql, tt.name+"-positive", int64(1)); err != nil {
				t.Fatalf("insert %s with version 1: %v", tt.name, err)
			}
		})
	}
}

func databaseTestURL() (string, bool) {
	if dbURL := os.Getenv("ATLAS_DATABASE_TEST_URL"); dbURL != "" {
		return dbURL, true
	}
	if dbURL := os.Getenv("DATABASE_URL"); dbURL != "" {
		return dbURL, true
	}
	password := os.Getenv("POSTGRES_PASSWORD")
	if password == "" {
		return "", false
	}
	dbURL := url.URL{
		Scheme: "postgres",
		User:   url.UserPassword("atlas", password),
		Host:   "localhost:5432",
		Path:   "/atlas_core",
	}
	return dbURL.String(), false
}

func assertConstraintViolation(t *testing.T, err error, constraint string) {
	t.Helper()
	if err == nil {
		t.Fatalf("expected constraint violation %s", constraint)
	}
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) {
		t.Fatalf("error type = %T, want *pgconn.PgError: %v", err, err)
	}
	if pgErr.Code != "23514" {
		t.Fatalf("SQLSTATE = %s, want check_violation for %s: %v", pgErr.Code, constraint, err)
	}
	if pgErr.ConstraintName != constraint {
		t.Fatalf("constraint = %q, want %q: %v", pgErr.ConstraintName, constraint, err)
	}
}
