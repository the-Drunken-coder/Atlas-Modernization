package database_test

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/the-drunken-coder/atlas/services/core/internal/actions"
	"github.com/the-drunken-coder/atlas/services/core/internal/config"
	"github.com/the-drunken-coder/atlas/services/core/internal/database"
	"github.com/the-drunken-coder/atlas/services/core/internal/testenv"
)

func TestRecoveryFloorMigrationExpiresUnrepresentedLegacyCursor(t *testing.T) {
	dbURL, explicitDBURL := testenv.DatabaseURL("ATLAS_DATABASE_TEST_URL")
	if dbURL == "" {
		testenv.SkipOrFatal(t, "set ATLAS_DATABASE_TEST_URL, DATABASE_URL, or POSTGRES_PASSWORD to run migration integration tests")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	admin, err := pgx.Connect(ctx, dbURL)
	if err != nil {
		if explicitDBURL {
			t.Fatalf("connect migration test database: %v", err)
		}
		testenv.SkipOrFatal(t, "migration test database unavailable: %v", err)
	}
	schema := fmt.Sprintf("atlas_recovery_floor_test_%d", time.Now().UTC().UnixNano())
	identifier := pgx.Identifier{schema}.Sanitize()
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+identifier); err != nil {
		_ = admin.Close(context.Background())
		t.Fatalf("create migration test schema: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		if _, err := admin.Exec(cleanupCtx, "DROP SCHEMA IF EXISTS "+identifier+" CASCADE"); err != nil {
			t.Errorf("drop migration test schema: %v", err)
		}
		if err := admin.Close(cleanupCtx); err != nil {
			t.Errorf("close migration test connection: %v", err)
		}
	})

	parsed, err := url.Parse(dbURL)
	if err != nil {
		t.Fatalf("parse migration test database URL: %v", err)
	}
	query := parsed.Query()
	query.Set("search_path", schema)
	parsed.RawQuery = query.Encode()
	db, err := database.New(&config.Config{
		DatabaseURL:               parsed.String(),
		DatabasePoolSize:          2,
		DatabaseMaxOverflow:       1,
		DatabasePoolRecycle:       3600,
		DatabasePoolTimeout:       10,
		DatabasePoolIdleTimeout:   30,
		DatabasePoolPrePing:       false,
		DatabaseRecreateOnStartup: false,
	})
	if err != nil {
		t.Fatalf("open migration test database: %v", err)
	}
	defer db.Close()
	if err := db.EnsureTables(ctx); err != nil {
		t.Fatalf("install current schema: %v", err)
	}

	const legacyVersion int64 = 42
	// Reconstruct the schema as it existed after migration 5 so EnsureTables
	// exercises the recovery-floor correction before replaying later migrations.
	statements := []struct {
		query string
		args  []any
	}{
		{`INSERT INTO entities (entity_id, type, version) VALUES ('legacy-recovery-entity', 'asset', $1)`, []any{legacyVersion}},
		{`TRUNCATE atlas_change_events`, nil},
		{`UPDATE atlas_change_clock SET version = $1, min_retained_version = 0 WHERE singleton`, []any{legacyVersion}},
		{`DROP TABLE atlas_change_events`, nil},
		{`CREATE TABLE atlas_change_events (
			version BIGINT PRIMARY KEY CHECK (version > 0),
			event JSONB NOT NULL,
			before_task_entity_id VARCHAR(50),
			after_task_entity_id VARCHAR(50),
			created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
		)`, nil},
		{`DROP TABLE tasks`, nil},
		{`DROP TABLE asset_runtimes`, nil},
		{`DROP TABLE asset_runtime_generations`, nil},
		{`DROP TABLE resource_instance_tokens`, nil},
		{`ALTER TABLE entities DROP COLUMN instance_token_hash`, nil},
		{`ALTER TABLE objects DROP COLUMN instance_token_hash`, nil},
		{`CREATE TABLE tasks (
			task_id VARCHAR(50) PRIMARY KEY,
			status VARCHAR(50) NOT NULL DEFAULT 'pending',
			entity_id VARCHAR(50) REFERENCES entities(entity_id) ON DELETE SET NULL,
			json JSONB NOT NULL DEFAULT '{}',
			created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
			version BIGINT NOT NULL,
			CONSTRAINT tasks_version_positive CHECK (version > 0)
		)`, nil},
		{`CREATE INDEX idx_tasks_status ON tasks(status)`, nil},
		{`CREATE INDEX idx_tasks_entity_id ON tasks(entity_id)`, nil},
		{`CREATE INDEX idx_tasks_created_cursor ON tasks(created_at DESC, task_id DESC)`, nil},
		{`CREATE INDEX idx_tasks_updated_cursor ON tasks(updated_at DESC, task_id DESC)`, nil},
		{`CREATE INDEX idx_tasks_entity_created_cursor ON tasks(entity_id, created_at DESC, task_id DESC)`, nil},
		{`CREATE INDEX idx_tasks_entity_updated_cursor ON tasks(entity_id, updated_at DESC, task_id DESC)`, nil},
		{`CREATE INDEX idx_tasks_version ON tasks(version DESC, task_id DESC)`, nil},
		{`DELETE FROM atlas_schema_migrations WHERE version >= 6`, nil},
	}
	for _, statement := range statements {
		if _, err := db.Pool.Exec(ctx, statement.query, statement.args...); err != nil {
			t.Fatalf("prepare pre-correction schema with %q: %v", statement.query, err)
		}
	}
	if err := db.EnsureTables(ctx); err != nil {
		t.Fatalf("apply recovery-floor correction: %v", err)
	}

	_, err = actions.NewQueryActions(db.Pool).GetDataChangedSince(ctx, 0, 1, nil)
	var expired *actions.CursorExpiredError
	if !errors.As(err, &expired) || expired.MinRetainedVersion != legacyVersion {
		t.Fatalf("changed-since error = %#v, want cursor expired at %d", err, legacyVersion)
	}

	created, err := actions.NewEntityActions(db.Pool).Create(ctx, actions.CreateEntityParams{
		EntityID:   "post-migration-recovery-entity",
		EntityType: "asset",
	})
	if err != nil {
		t.Fatalf("create post-migration entity: %v", err)
	}
	recovered, err := actions.NewQueryActions(db.Pool).GetDataChangedSince(ctx, legacyVersion, 10, nil)
	if err != nil {
		t.Fatalf("recover post-migration event: %v", err)
	}
	if len(recovered.Events) != 1 || recovered.Events[0].ID != created.EntityID || recovered.Events[0].Version != created.Version {
		t.Fatalf("post-migration recovery = %+v, want entity %s at version %d", recovered.Events, created.EntityID, created.Version)
	}
}
