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
		"context JSONB NOT NULL DEFAULT '{}'",
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

func TestCoreSchemaCheckRequiresCurrentColumnsAndSequence(t *testing.T) {
	query := &recordingSchemaCheckQuery{
		tableCount:      len(coreSchemaTables),
		sequencePresent: true,
		contextColumn: schemaColumn{
			udtName:              "jsonb",
			isNullable:           "NO",
			defaultIsEmptyObject: true,
		},
	}

	ok, err := coreSchemaTablesPresent(context.Background(), query)
	if err != nil {
		t.Fatalf("coreSchemaTablesPresent returned error: %v", err)
	}
	if !ok {
		t.Fatal("coreSchemaTablesPresent = false, want true from fake row")
	}

	sql := strings.Join(query.sqls, "\n")
	for _, fragment := range []string{
		"information_schema.tables",
		"table_schema = 'public'",
		"table_name = ANY($1::text[])",
		"atlas_change_version_seq",
		"table_name = 'deletions'",
		"column_name = 'context'",
	} {
		if !strings.Contains(sql, fragment) {
			t.Fatalf("schema check SQL missing %q:\n%s", fragment, sql)
		}
	}
	if len(query.sqls) != 3 {
		t.Fatalf("schema check query count = %d, want 3: %#v", len(query.sqls), query.sqls)
	}
	if len(query.args) != 3 || len(query.args[0]) != 1 {
		t.Fatalf("schema check args = %#v, want table list on first query only", query.args)
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

	t.Run("deletions_context_rejects_null", func(t *testing.T) {
		_, err := conn.Exec(ctx, `INSERT INTO deletions (resource_type, resource_id, version, context) VALUES ('task', 'task-null-context', 1, NULL)`)
		assertSQLState(t, err, "23502")
	})

	t.Run("deletions_context_defaults_to_empty_object", func(t *testing.T) {
		var contextText string
		err := conn.QueryRow(ctx, `INSERT INTO deletions (resource_type, resource_id, version) VALUES ('task', 'task-default-context', 1) RETURNING context::text`).Scan(&contextText)
		if err != nil {
			t.Fatalf("insert deletion without context: %v", err)
		}
		if contextText != "{}" {
			t.Fatalf("context default = %q, want {}", contextText)
		}
	})

	t.Run("deletions_context_persists_json", func(t *testing.T) {
		var entityID string
		err := conn.QueryRow(ctx, `INSERT INTO deletions (resource_type, resource_id, version, context) VALUES ('task', 'task-json-context', 1, $1::jsonb) RETURNING context->>'entity_id'`, `{"entity_id":"asset-1"}`).Scan(&entityID)
		if err != nil {
			t.Fatalf("insert deletion with context: %v", err)
		}
		if entityID != "asset-1" {
			t.Fatalf("context entity_id = %q, want asset-1", entityID)
		}
	})
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

type recordingSchemaCheckQuery struct {
	sqls            []string
	args            [][]any
	tableCount      int
	sequencePresent bool
	contextColumn   schemaColumn
	err             error
}

type schemaColumn struct {
	udtName              string
	isNullable           string
	defaultIsEmptyObject bool
}

func (q *recordingSchemaCheckQuery) QueryRow(_ context.Context, sql string, args ...any) pgx.Row {
	q.sqls = append(q.sqls, sql)
	q.args = append(q.args, append([]any(nil), args...))
	if q.err != nil {
		return schemaCheckRow{err: q.err}
	}
	switch {
	case strings.Contains(sql, "information_schema.tables"):
		return schemaCheckRow{values: []any{q.tableCount}}
	case strings.Contains(sql, "atlas_change_version_seq"):
		return schemaCheckRow{values: []any{q.sequencePresent}}
	case strings.Contains(sql, "information_schema.columns"):
		return schemaCheckRow{values: []any{q.contextColumn.udtName, q.contextColumn.isNullable, q.contextColumn.defaultIsEmptyObject}}
	default:
		return schemaCheckRow{err: fmt.Errorf("unexpected schema check query: %s", sql)}
	}
}

type schemaCheckRow struct {
	values []any
	err    error
}

func (r schemaCheckRow) Scan(dest ...any) error {
	if r.err != nil {
		return r.err
	}
	if len(dest) != len(r.values) {
		return fmt.Errorf("schemaCheckRow destination count = %d, want %d", len(dest), len(r.values))
	}
	for index, value := range r.values {
		switch target := dest[index].(type) {
		case *bool:
			typed, ok := value.(bool)
			if !ok {
				return fmt.Errorf("schemaCheckRow value %d = %T, want bool", index, value)
			}
			*target = typed
		case *int:
			typed, ok := value.(int)
			if !ok {
				return fmt.Errorf("schemaCheckRow value %d = %T, want int", index, value)
			}
			*target = typed
		case *string:
			typed, ok := value.(string)
			if !ok {
				return fmt.Errorf("schemaCheckRow value %d = %T, want string", index, value)
			}
			*target = typed
		default:
			return fmt.Errorf("schemaCheckRow destination %d = %T", index, dest[index])
		}
	}
	return nil
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

func assertSQLState(t *testing.T, err error, code string) {
	t.Helper()
	if err == nil {
		t.Fatalf("expected SQLSTATE %s", code)
	}
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) {
		t.Fatalf("error type = %T, want *pgconn.PgError: %v", err, err)
	}
	if pgErr.Code != code {
		t.Fatalf("SQLSTATE = %s, want %s: %v", pgErr.Code, code, err)
	}
}
