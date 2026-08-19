package database

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
)

const (
	migrationTableName              = "atlas_schema_migrations"
	baselineMigrationName           = "baseline_current_schema"
	baselineMigrationChecksum       = "ef8c1f811a672ee5c1394f494e9b3d8b196aea564242437ed6fae55b00d72f23"
	uploadIntentsMigrationName      = "durable_storage_upload_intents"
	uploadIntentsMigrationChecksum  = "397e1731dbc7b9f0a5258d8084e7086ad1d674a164db8118ed58cc928189345c"
	pathTombstonesMigrationName     = "index_storage_path_tombstones"
	pathTombstonesMigrationChecksum = "fc9d12136384e8f4bdcd15d96c6ec8a1b802092a66a8b6b78f33c5548241d19f"
	changeStreamMigrationName       = "transactional_change_stream"
	changeStreamMigrationChecksum   = "362d2f71c1d51c7d172e0818b68a7eec725104aeec91002558ebac7d74a978eb"
	recoveryLogMigrationName        = "bounded_recovery_log"
	recoveryLogMigrationChecksum    = "7ae3a729125b872f1dc3a4265196dde2473ccc61ca3b5b820120d81278f917d8"
	recoveryFloorMigrationName      = "recovery_log_floor_and_retention_index"
	recoveryFloorMigrationChecksum  = "ac7ed32b7d9f4331bd0f8db417ea69e52148f1f5bbdb74f1b82a8b8ba3e62ead"
	taskingRuntimeMigrationName     = "immutable_tasks_and_asset_runtimes"
	taskingRuntimeMigrationChecksum = "8109dede8ab513300e490d3d1fc19caf36a0371e67906bb233b2e1b1cc8c3d73"
	fingerprintVersionV1            = 1
)

var (
	// ErrSchemaDrift means Atlas-owned PostgreSQL objects no longer match the
	// catalog fingerprint recorded by the latest successful migration.
	ErrSchemaDrift = errors.New("database: schema drift detected")
	// ErrMigrationHistory means the applied version ledger is unknown, gapped,
	// ahead of this binary, or no longer matches immutable migration code.
	ErrMigrationHistory = errors.New("database: invalid schema migration history")
)

type schemaMigration struct {
	version            int
	name               string
	checksum           string
	fingerprintVersion int
	statements         []string
}

type appliedMigration struct {
	version            int
	name               string
	checksum           string
	fingerprintVersion int
	schemaFingerprint  string
}

func coreSchemaMigrations() []schemaMigration {
	return []schemaMigration{
		{
			version:            1,
			name:               baselineMigrationName,
			checksum:           baselineMigrationChecksum,
			fingerprintVersion: fingerprintVersionV1,
			statements:         baselineSchemaDDL(),
		},
		{
			version:            2,
			name:               uploadIntentsMigrationName,
			checksum:           uploadIntentsMigrationChecksum,
			fingerprintVersion: fingerprintVersionV1,
			statements: []string{
				`CREATE TABLE storage_upload_intents (
					bucket VARCHAR(255) NOT NULL,
					path VARCHAR(500) NOT NULL,
					object_id VARCHAR(50) NOT NULL,
					owner_id UUID NOT NULL,
					expires_at TIMESTAMPTZ NOT NULL,
					orphaned_at TIMESTAMPTZ,
					created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
					updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
					PRIMARY KEY (bucket, path)
				)`,
				`CREATE INDEX idx_storage_upload_intents_recovery ON storage_upload_intents(orphaned_at, expires_at, path)`,
			},
		},
		{
			version:            3,
			name:               pathTombstonesMigrationName,
			checksum:           pathTombstonesMigrationChecksum,
			fingerprintVersion: fingerprintVersionV1,
			statements: []string{
				`CREATE INDEX idx_storage_deletion_outbox_path ON storage_deletion_outbox(path)`,
			},
		},
		{
			version:            4,
			name:               changeStreamMigrationName,
			checksum:           changeStreamMigrationChecksum,
			fingerprintVersion: fingerprintVersionV1,
			statements: []string{
				`CREATE TABLE atlas_change_clock (
					singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
					version BIGINT NOT NULL CHECK (version >= 0)
				)`,
				`INSERT INTO atlas_change_clock (singleton, version)
				 SELECT TRUE, GREATEST(
					COALESCE((SELECT MAX(version) FROM entities), 0),
					COALESCE((SELECT MAX(version) FROM tasks), 0),
					COALESCE((SELECT MAX(version) FROM objects), 0),
					COALESCE((SELECT MAX(version) FROM deletions), 0),
					COALESCE((SELECT CASE WHEN is_called THEN last_value ELSE 0 END FROM atlas_change_version_seq), 0)
				 )`,
				`CREATE TABLE atlas_change_events (
					version BIGINT PRIMARY KEY CHECK (version > 0),
					event JSONB NOT NULL,
					before_task_entity_id VARCHAR(50),
					after_task_entity_id VARCHAR(50),
					created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
				)`,
				`CREATE INDEX idx_atlas_change_events_object_deletes
				 ON atlas_change_events ((event->>'id'), version DESC)
				 WHERE event->>'resource_type' = 'object' AND event->>'event' = 'delete'`,
				`ALTER TABLE entities ALTER COLUMN version DROP DEFAULT`,
				`ALTER TABLE tasks ALTER COLUMN version DROP DEFAULT`,
				`ALTER TABLE objects ALTER COLUMN version DROP DEFAULT`,
				`DROP TABLE deletions`,
				`DROP SEQUENCE atlas_change_version_seq`,
			},
		},
		{
			version:            5,
			name:               recoveryLogMigrationName,
			checksum:           recoveryLogMigrationChecksum,
			fingerprintVersion: fingerprintVersionV1,
			statements: []string{
				`ALTER TABLE atlas_change_clock
				 ADD COLUMN min_retained_version BIGINT NOT NULL DEFAULT 0
				 CHECK (min_retained_version >= 0 AND min_retained_version <= version)`,
				`CREATE TABLE object_deletion_fences (
					object_id VARCHAR(50) PRIMARY KEY,
					version BIGINT NOT NULL CHECK (version > 0),
					deleted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
				)`,
				`INSERT INTO object_deletion_fences (object_id, version, deleted_at)
				 SELECT event->>'id', MAX(version), MAX(created_at)
				 FROM atlas_change_events
				 WHERE event->>'resource_type' = 'object' AND event->>'event' = 'delete'
				 GROUP BY event->>'id'`,
				`DROP INDEX idx_atlas_change_events_object_deletes`,
			},
		},
		{
			version:            6,
			name:               recoveryFloorMigrationName,
			checksum:           recoveryFloorMigrationChecksum,
			fingerprintVersion: fingerprintVersionV1,
			statements: []string{
				`UPDATE atlas_change_clock AS clock
				 SET min_retained_version = COALESCE(
					(SELECT MIN(event.version) - 1 FROM atlas_change_events AS event),
					clock.version
				 )
				 WHERE clock.singleton`,
				`CREATE INDEX idx_atlas_change_events_retention ON atlas_change_events(created_at, version)`,
			},
		},
		{
			version:            7,
			name:               taskingRuntimeMigrationName,
			checksum:           taskingRuntimeMigrationChecksum,
			fingerprintVersion: fingerprintVersionV1,
			statements: []string{
				`DO $$ BEGIN
					IF EXISTS (SELECT 1 FROM tasks LIMIT 1) THEN
						RAISE EXCEPTION 'Atlas Task cutover requires an empty tasks table';
					END IF;
				END $$`,
				`DO $$ BEGIN
					IF EXISTS (
						SELECT 1 FROM atlas_change_events
						WHERE event->>'resource_type' = 'task'
						LIMIT 1
					) THEN
						RAISE EXCEPTION 'Atlas Task cutover requires an empty Task change history';
					END IF;
				END $$`,
				`ALTER TABLE atlas_change_events
					DROP COLUMN before_task_entity_id,
					DROP COLUMN after_task_entity_id,
					ADD COLUMN task_asset_id VARCHAR(50)`,
				`DROP TABLE tasks`,
				`CREATE TABLE asset_runtimes (
					asset_id VARCHAR(50) PRIMARY KEY REFERENCES entities(entity_id) ON DELETE CASCADE,
					runtime_id VARCHAR(255) NOT NULL,
					ready BOOLEAN NOT NULL DEFAULT FALSE,
					manifest JSONB NOT NULL DEFAULT '[]',
					registered_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
					ready_at TIMESTAMPTZ
				)`,
				`CREATE UNIQUE INDEX idx_asset_runtimes_runtime ON asset_runtimes(runtime_id)`,
				`CREATE TABLE tasks (
					task_id VARCHAR(50) PRIMARY KEY,
					asset_id VARCHAR(50) NOT NULL,
					command VARCHAR(255) NOT NULL,
					input JSONB NOT NULL,
					status VARCHAR(32) NOT NULL DEFAULT 'pending',
					progress DOUBLE PRECISION,
					output JSONB,
					failure JSONB,
					cancellation JSONB,
					idempotency_key TEXT NOT NULL UNIQUE,
					runtime_id VARCHAR(255) NOT NULL,
					created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
					acknowledged_at TIMESTAMPTZ,
					started_at TIMESTAMPTZ,
					finished_at TIMESTAMPTZ,
					updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
					version BIGINT NOT NULL,
					CONSTRAINT tasks_status_valid CHECK (status IN ('pending', 'acknowledged', 'in_progress', 'completed', 'failed', 'cancelled')),
					CONSTRAINT tasks_progress_valid CHECK (progress IS NULL OR (progress >= 0 AND progress <= 1)),
					CONSTRAINT tasks_version_positive CHECK (version > 0)
				)`,
				`CREATE INDEX idx_tasks_status ON tasks(status)`,
				`CREATE INDEX idx_tasks_asset_id ON tasks(asset_id)`,
				`CREATE INDEX idx_tasks_runtime_status ON tasks(runtime_id, status)`,
				`CREATE INDEX idx_tasks_created_cursor ON tasks(created_at DESC, task_id DESC)`,
				`CREATE INDEX idx_tasks_updated_cursor ON tasks(updated_at DESC, task_id DESC)`,
				`CREATE INDEX idx_tasks_asset_created_cursor ON tasks(asset_id, created_at DESC, task_id DESC)`,
				`CREATE INDEX idx_tasks_asset_updated_cursor ON tasks(asset_id, updated_at DESC, task_id DESC)`,
				`CREATE INDEX idx_tasks_version ON tasks(version DESC, task_id DESC)`,
			},
		},
	}
}

func migrationChecksum(migration schemaMigration) string {
	hash := sha256.New()
	_, _ = fmt.Fprintf(hash, "%d\x00%s\x00%d\x00", migration.version, migration.name, migration.fingerprintVersion)
	if migration.version == 1 {
		_, _ = fmt.Fprintf(hash, "%s\x00", strings.TrimSpace(migrationTableDDL))
	}
	for _, statement := range migration.statements {
		_, _ = fmt.Fprintf(hash, "%s\x00", strings.TrimSpace(statement))
	}
	return fmt.Sprintf("%x", hash.Sum(nil))
}

func validateMigrationDefinitions(migrations []schemaMigration) error {
	if len(migrations) == 0 {
		return fmt.Errorf("%w: no migrations are defined", ErrMigrationHistory)
	}
	for index, migration := range migrations {
		expectedVersion := index + 1
		if migration.version != expectedVersion || strings.TrimSpace(migration.name) == "" || migration.fingerprintVersion < 1 {
			return fmt.Errorf("%w: migration %d must have version %d, a name, and a fingerprint version", ErrMigrationHistory, index, expectedVersion)
		}
		actualChecksum := migrationChecksum(migration)
		if migration.checksum != actualChecksum {
			return fmt.Errorf("%w: migration %d definition checksum is %s, want %s", ErrMigrationHistory, migration.version, actualChecksum, migration.checksum)
		}
	}
	return nil
}

func migrateSchema(ctx context.Context, tx pgx.Tx, migrations []schemaMigration) error {
	if err := validateMigrationDefinitions(migrations); err != nil {
		return err
	}

	schema, err := currentSchema(ctx, tx)
	if err != nil {
		return err
	}
	migrationTablePresent, err := relationExists(ctx, tx, schema, migrationTableName)
	if err != nil {
		return err
	}
	legacySchemaPresent := false
	if !migrationTablePresent {
		legacySchemaPresent, err = legacyResourceSchemaPresent(ctx, tx, schema)
		if err != nil {
			return err
		}
		if legacySchemaPresent {
			if err := verifyUnversionedBaseline(ctx, tx, schema, migrations[0]); err != nil {
				return err
			}
		}
		if _, err := tx.Exec(ctx, migrationTableDDL); err != nil {
			return fmt.Errorf("failed to create schema migration table: %w", err)
		}
	}

	applied, err := loadAppliedMigrations(ctx, tx)
	if err != nil {
		return err
	}
	if err := verifyAppliedMigrations(applied, migrations); err != nil {
		return err
	}
	if migrationTablePresent && len(applied) == 0 {
		return fmt.Errorf("%w: migration table exists without an applied baseline", ErrMigrationHistory)
	}
	if len(applied) > 0 {
		fingerprint, err := schemaFingerprint(ctx, tx, schema, applied[len(applied)-1].fingerprintVersion)
		if err != nil {
			return err
		}
		if fingerprint != applied[len(applied)-1].schemaFingerprint {
			return fmt.Errorf("%w: current fingerprint %s does not match version %d fingerprint %s", ErrSchemaDrift, fingerprint, applied[len(applied)-1].version, applied[len(applied)-1].schemaFingerprint)
		}
	}

	for index := len(applied); index < len(migrations); index++ {
		migration := migrations[index]
		if !legacySchemaPresent || migration.version != 1 {
			for _, statement := range migration.statements {
				if _, err := tx.Exec(ctx, statement); err != nil {
					return fmt.Errorf("failed to apply schema migration %d (%s): %w", migration.version, migration.name, err)
				}
			}
		}

		fingerprint, err := schemaFingerprint(ctx, tx, schema, migration.fingerprintVersion)
		if err != nil {
			return err
		}
		if migration.version == 1 {
			expected, err := expectedBaselineFingerprint(ctx, tx, migration)
			if err != nil {
				return err
			}
			if fingerprint != expected {
				return fmt.Errorf("%w: baseline fingerprint %s does not match expected %s", ErrSchemaDrift, fingerprint, expected)
			}
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO atlas_schema_migrations (version, name, checksum, fingerprint_version, schema_fingerprint)
			VALUES ($1, $2, $3, $4, $5)`, migration.version, migration.name, migration.checksum, migration.fingerprintVersion, fingerprint); err != nil {
			return fmt.Errorf("failed to record schema migration %d: %w", migration.version, err)
		}
	}
	return nil
}

const migrationTableDDL = `CREATE TABLE atlas_schema_migrations (
	version INTEGER PRIMARY KEY CHECK (version > 0),
	name TEXT NOT NULL UNIQUE,
	checksum TEXT NOT NULL,
	fingerprint_version INTEGER NOT NULL CHECK (fingerprint_version > 0),
	schema_fingerprint TEXT NOT NULL,
	applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
)`

func currentSchema(ctx context.Context, tx pgx.Tx) (string, error) {
	var schema string
	if err := tx.QueryRow(ctx, `SELECT current_schema()`).Scan(&schema); err != nil {
		return "", fmt.Errorf("failed to read current database schema: %w", err)
	}
	if schema == "" {
		return "", fmt.Errorf("failed to read current database schema: search_path has no existing schema")
	}
	return schema, nil
}

func relationExists(ctx context.Context, tx pgx.Tx, schema, name string) (bool, error) {
	var exists bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1
			FROM pg_catalog.pg_class c
			JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
			WHERE n.nspname = $1 AND c.relname = $2
		)`, schema, name).Scan(&exists); err != nil {
		return false, fmt.Errorf("failed to inspect database relation %s: %w", name, err)
	}
	return exists, nil
}

func legacyResourceSchemaPresent(ctx context.Context, tx pgx.Tx, schema string) (bool, error) {
	resourceNames := []string{"entities", "tasks", "objects", "deletions", "storage_deletion_outbox", "atlas_change_version_seq"}
	var exists bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1
			FROM pg_catalog.pg_class c
			JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
			WHERE n.nspname = $1 AND c.relname = ANY($2::text[])
		)`, schema, resourceNames).Scan(&exists); err != nil {
		return false, fmt.Errorf("failed to inspect unversioned schema: %w", err)
	}
	return exists, nil
}

func loadAppliedMigrations(ctx context.Context, tx pgx.Tx) ([]appliedMigration, error) {
	rows, err := tx.Query(ctx, `
		SELECT version, name, checksum, fingerprint_version, schema_fingerprint
		FROM atlas_schema_migrations
		ORDER BY version`)
	if err != nil {
		return nil, fmt.Errorf("failed to read schema migration history: %w", err)
	}
	defer rows.Close()

	var applied []appliedMigration
	for rows.Next() {
		var migration appliedMigration
		if err := rows.Scan(&migration.version, &migration.name, &migration.checksum, &migration.fingerprintVersion, &migration.schemaFingerprint); err != nil {
			return nil, fmt.Errorf("failed to scan schema migration history: %w", err)
		}
		applied = append(applied, migration)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("failed to read schema migration history: %w", err)
	}
	return applied, nil
}

func verifyAppliedMigrations(applied []appliedMigration, known []schemaMigration) error {
	if len(applied) > len(known) {
		return fmt.Errorf("%w: database version %d is newer than this binary's version %d", ErrMigrationHistory, applied[len(applied)-1].version, known[len(known)-1].version)
	}
	for index, actual := range applied {
		expected := known[index]
		if actual.version != expected.version || actual.name != expected.name || actual.checksum != expected.checksum || actual.fingerprintVersion != expected.fingerprintVersion {
			return fmt.Errorf("%w: applied migration at position %d is %d/%s/%s/fingerprint-v%d, want %d/%s/%s/fingerprint-v%d", ErrMigrationHistory, index+1, actual.version, actual.name, actual.checksum, actual.fingerprintVersion, expected.version, expected.name, expected.checksum, expected.fingerprintVersion)
		}
		if strings.TrimSpace(actual.schemaFingerprint) == "" {
			return fmt.Errorf("%w: migration %d has no schema fingerprint", ErrMigrationHistory, actual.version)
		}
	}
	return nil
}

func verifyUnversionedBaseline(ctx context.Context, tx pgx.Tx, schema string, baseline schemaMigration) error {
	actual, err := schemaFingerprint(ctx, tx, schema, baseline.fingerprintVersion)
	if err != nil {
		return err
	}
	expected, err := expectedUnversionedBaselineFingerprint(ctx, tx, baseline)
	if err != nil {
		return err
	}
	if actual != expected {
		return fmt.Errorf("%w: unversioned schema fingerprint %s does not match the v1 baseline %s", ErrSchemaDrift, actual, expected)
	}
	return nil
}
