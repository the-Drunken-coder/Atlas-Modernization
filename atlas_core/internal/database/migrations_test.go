package database

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/config"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/testenv"
)

func TestBaselineMigrationDefinitionIsFrozen(t *testing.T) {
	migration := coreSchemaMigrations()[0]
	actual := migrationChecksum(migration)
	if actual != baselineMigrationChecksum {
		t.Fatalf("baseline migration checksum = %s, update only by adding a new migration; frozen checksum is %s", actual, baselineMigrationChecksum)
	}
}

func TestUploadIntentMigrationDefinitionIsFrozen(t *testing.T) {
	migration := coreSchemaMigrations()[1]
	if actual := migrationChecksum(migration); actual != uploadIntentsMigrationChecksum {
		t.Fatalf("upload-intent migration checksum = %s, want %s", actual, uploadIntentsMigrationChecksum)
	}
	ddl := strings.Join(migration.statements, "\n")
	for _, required := range []string{
		"CREATE TABLE storage_upload_intents",
		"PRIMARY KEY (bucket, path)",
		"CREATE INDEX idx_storage_upload_intents_recovery",
	} {
		if !strings.Contains(ddl, required) {
			t.Fatalf("upload-intent migration is missing %q", required)
		}
	}
}

func TestPathTombstoneMigrationDefinitionIsFrozen(t *testing.T) {
	migration := coreSchemaMigrations()[2]
	if actual := migrationChecksum(migration); actual != pathTombstonesMigrationChecksum {
		t.Fatalf("path-tombstone migration checksum = %s, want %s", actual, pathTombstonesMigrationChecksum)
	}
	if len(migration.statements) != 1 || migration.statements[0] != `CREATE INDEX idx_storage_deletion_outbox_path ON storage_deletion_outbox(path)` {
		t.Fatalf("path-tombstone migration statements = %#v", migration.statements)
	}
}

func TestTransactionalChangeStreamMigrationDefinitionIsFrozen(t *testing.T) {
	migration := coreSchemaMigrations()[3]
	if actual := migrationChecksum(migration); actual != changeStreamMigrationChecksum {
		t.Fatalf("transactional change-stream migration checksum = %s, want %s", actual, changeStreamMigrationChecksum)
	}
	ddl := strings.Join(migration.statements, "\n")
	for _, required := range []string{
		"CREATE TABLE atlas_change_clock",
		"COALESCE((SELECT MAX(version) FROM entities), 0)",
		"COALESCE((SELECT MAX(version) FROM tasks), 0)",
		"COALESCE((SELECT MAX(version) FROM objects), 0)",
		"COALESCE((SELECT MAX(version) FROM deletions), 0)",
		"CASE WHEN is_called THEN last_value ELSE 0 END FROM atlas_change_version_seq",
		"CREATE TABLE atlas_change_events",
		"CREATE INDEX idx_atlas_change_events_object_deletes",
		"ALTER TABLE entities ALTER COLUMN version DROP DEFAULT",
		"ALTER TABLE tasks ALTER COLUMN version DROP DEFAULT",
		"ALTER TABLE objects ALTER COLUMN version DROP DEFAULT",
		"DROP TABLE deletions",
		"DROP SEQUENCE atlas_change_version_seq",
	} {
		if !strings.Contains(ddl, required) {
			t.Fatalf("transactional change-stream migration is missing %q", required)
		}
	}
}

func TestMigrationDefinitionsAreValid(t *testing.T) {
	if err := validateMigrationDefinitions(coreSchemaMigrations()); err != nil {
		t.Fatalf("migration definitions: %v", err)
	}
}

func TestAppliedMigrationHistoryMustMatchKnownPrefix(t *testing.T) {
	known := coreSchemaMigrations()
	validPrefix := make([]appliedMigration, len(known))
	for index, migration := range known {
		validPrefix[index] = appliedMigration{
			version:            migration.version,
			name:               migration.name,
			checksum:           migration.checksum,
			fingerprintVersion: migration.fingerprintVersion,
			schemaFingerprint:  "fingerprint",
		}
	}
	if err := verifyAppliedMigrations(validPrefix, known); err != nil {
		t.Fatalf("valid migration history: %v", err)
	}
	valid := validPrefix[0]
	futureApplied := append([]appliedMigration(nil), validPrefix...)
	futureApplied = append(futureApplied, appliedMigration{
		version:            known[len(known)-1].version + 1,
		name:               "future",
		checksum:           "future",
		fingerprintVersion: fingerprintVersionV1,
		schemaFingerprint:  "future",
	})

	tests := []struct {
		name    string
		applied []appliedMigration
	}{
		{name: "future version", applied: futureApplied},
		{name: "wrong version", applied: []appliedMigration{{version: 2, name: valid.name, checksum: valid.checksum, fingerprintVersion: valid.fingerprintVersion, schemaFingerprint: valid.schemaFingerprint}}},
		{name: "changed checksum", applied: []appliedMigration{{version: valid.version, name: valid.name, checksum: "changed", fingerprintVersion: valid.fingerprintVersion, schemaFingerprint: valid.schemaFingerprint}}},
		{name: "changed fingerprint version", applied: []appliedMigration{{version: valid.version, name: valid.name, checksum: valid.checksum, fingerprintVersion: 2, schemaFingerprint: valid.schemaFingerprint}}},
		{name: "missing fingerprint", applied: []appliedMigration{{version: valid.version, name: valid.name, checksum: valid.checksum, fingerprintVersion: valid.fingerprintVersion}}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if err := verifyAppliedMigrations(tt.applied, known); !errors.Is(err, ErrMigrationHistory) {
				t.Fatalf("history error = %v, want ErrMigrationHistory", err)
			}
		})
	}
}

func TestProductionSchemaCleanInstallAndRestartPreserveData(t *testing.T) {
	dbURL := migrationTestSchema(t)
	db := openMigrationTestDB(t, dbURL, false)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if err := db.EnsureTables(ctx); err != nil {
		t.Fatalf("clean production schema install: %v", err)
	}
	assertCurrentMigration(ctx, t, db)

	var entityVersion int64
	if err := db.Pool.QueryRow(ctx, `
		WITH next AS (
			UPDATE atlas_change_clock SET version = version + 1 WHERE singleton RETURNING version
		)
		INSERT INTO entities (entity_id, type, version) SELECT 'durable-entity', 'asset', version FROM next
		RETURNING version`).Scan(&entityVersion); err != nil {
		t.Fatalf("insert durable entity: %v", err)
	}
	if _, err := db.Pool.Exec(ctx, `
		INSERT INTO admin_records (id, type, json)
		VALUES ('durable-admin', 'test', '{"preserved":true}')`); err != nil {
		t.Fatalf("insert durable admin record: %v", err)
	}
	if _, err := db.Pool.Exec(ctx, `
		INSERT INTO storage_upload_intents (bucket, path, object_id, owner_id, expires_at)
		VALUES ('atlas-media', 'objects/durable-upload/blob', 'durable-upload', '00000000-0000-0000-0000-000000000001', clock_timestamp() + interval '5 minutes')`); err != nil {
		t.Fatalf("insert durable upload intent: %v", err)
	}
	db.Close()

	db = openMigrationTestDB(t, dbURL, false)
	defer db.Close()
	if err := db.EnsureTables(ctx); err != nil {
		t.Fatalf("production schema restart: %v", err)
	}
	assertCurrentMigration(ctx, t, db)

	var restartedVersion int64
	if err := db.Pool.QueryRow(ctx, `SELECT version FROM entities WHERE entity_id = 'durable-entity'`).Scan(&restartedVersion); err != nil {
		t.Fatalf("read durable entity after restart: %v", err)
	}
	if restartedVersion != entityVersion {
		t.Fatalf("entity version after restart = %d, want %d", restartedVersion, entityVersion)
	}
	var adminCount int
	if err := db.Pool.QueryRow(ctx, `SELECT COUNT(*) FROM admin_records WHERE id = 'durable-admin'`).Scan(&adminCount); err != nil {
		t.Fatalf("read durable admin record after restart: %v", err)
	}
	if adminCount != 1 {
		t.Fatalf("durable admin record count = %d, want 1", adminCount)
	}
	var intentCount int
	if err := db.Pool.QueryRow(ctx, `SELECT COUNT(*) FROM storage_upload_intents WHERE object_id = 'durable-upload'`).Scan(&intentCount); err != nil {
		t.Fatalf("read durable upload intent after restart: %v", err)
	}
	if intentCount != 1 {
		t.Fatalf("durable upload intent count = %d, want 1", intentCount)
	}
}

func TestProductionSchemaUpgradesFromVersionOne(t *testing.T) {
	dbURL := migrationTestSchema(t)
	db := openMigrationTestDB(t, dbURL, false)
	defer db.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	migrations := coreSchemaMigrations()
	if err := db.ensureTables(ctx, migrations[:1]); err != nil {
		t.Fatalf("install version-one schema: %v", err)
	}
	var version, fingerprintVersion int
	var name, checksum, fingerprint string
	if err := db.Pool.QueryRow(ctx, `
		SELECT version, name, checksum, fingerprint_version, schema_fingerprint
		FROM atlas_schema_migrations
	`).Scan(&version, &name, &checksum, &fingerprintVersion, &fingerprint); err != nil {
		t.Fatalf("read version-one migration: %v", err)
	}
	if version != 1 || name != baselineMigrationName || checksum != baselineMigrationChecksum || fingerprintVersion != fingerprintVersionV1 || strings.TrimSpace(fingerprint) == "" {
		t.Fatalf("version-one migration row = %d/%s/%s/fingerprint-v%d/%s", version, name, checksum, fingerprintVersion, fingerprint)
	}
	if _, err := db.Pool.Exec(ctx, `INSERT INTO objects (object_id, path) VALUES ('version-one-object', 'objects/version-one-object/blob')`); err != nil {
		t.Fatalf("insert version-one object: %v", err)
	}

	if err := db.EnsureTables(ctx); err != nil {
		t.Fatalf("upgrade version-one schema: %v", err)
	}
	assertCurrentMigration(ctx, t, db)

	var intentTableExists bool
	if err := db.Pool.QueryRow(ctx, `SELECT to_regclass('storage_upload_intents') IS NOT NULL`).Scan(&intentTableExists); err != nil {
		t.Fatalf("check upload-intent table: %v", err)
	}
	var preservedPath string
	if err := db.Pool.QueryRow(ctx, `SELECT path FROM objects WHERE object_id = 'version-one-object'`).Scan(&preservedPath); err != nil {
		t.Fatalf("check version-one object: %v", err)
	}
	if !intentTableExists || preservedPath != "objects/version-one-object/blob" {
		t.Fatalf("upgrade state = upload-intents:%t object-path:%q", intentTableExists, preservedPath)
	}

	rows, err := db.Pool.Query(ctx, `
		SELECT version, name, checksum, fingerprint_version, schema_fingerprint
		FROM atlas_schema_migrations ORDER BY version
	`)
	if err != nil {
		t.Fatalf("read upgraded migration history: %v", err)
	}
	defer rows.Close()
	var applied []appliedMigration
	for rows.Next() {
		var migration appliedMigration
		if err := rows.Scan(&migration.version, &migration.name, &migration.checksum, &migration.fingerprintVersion, &migration.schemaFingerprint); err != nil {
			t.Fatalf("scan upgraded migration history: %v", err)
		}
		applied = append(applied, migration)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate upgraded migration history: %v", err)
	}
	if len(applied) != len(migrations) {
		t.Fatalf("applied migrations = %d, want %d", len(applied), len(migrations))
	}
	for index, expected := range migrations {
		actual := applied[index]
		if actual.version != expected.version || actual.name != expected.name || actual.checksum != expected.checksum || actual.fingerprintVersion != expected.fingerprintVersion || strings.TrimSpace(actual.schemaFingerprint) == "" {
			t.Fatalf("migration %d = %d/%s/%s/fingerprint-v%d/%s", index+1, actual.version, actual.name, actual.checksum, actual.fingerprintVersion, actual.schemaFingerprint)
		}
	}
	if applied[0].schemaFingerprint != fingerprint {
		t.Fatalf("version-one fingerprint changed from %s to %s", fingerprint, applied[0].schemaFingerprint)
	}
}

func TestCleanInstallRestoresSearchPathBeforeLaterMigration(t *testing.T) {
	dbURL := migrationTestSchema(t)
	parsed, err := url.Parse(dbURL)
	if err != nil {
		t.Fatalf("parse migration test URL: %v", err)
	}
	query := parsed.Query()
	query.Set("search_path", query.Get("search_path")+",public")
	parsed.RawQuery = query.Encode()

	db := openMigrationTestDB(t, parsed.String(), false)
	defer db.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	migrations := coreSchemaMigrations()
	searchPathMigration := schemaMigration{
		version:            5,
		name:               "verify_search_path_restoration",
		fingerprintVersion: fingerprintVersionV1,
		statements: []string{`DO $$
		BEGIN
			IF position('public' in current_setting('search_path')) = 0 THEN
				RAISE EXCEPTION 'secondary search_path entry was not restored';
			END IF;
		END $$`},
	}
	searchPathMigration.checksum = migrationChecksum(searchPathMigration)
	migrations = append(migrations, searchPathMigration)
	if err := db.ensureTables(ctx, migrations); err != nil {
		t.Fatalf("clean install with later search-path migration: %v", err)
	}
	var version int
	if err := db.Pool.QueryRow(ctx, `SELECT max(version) FROM atlas_schema_migrations`).Scan(&version); err != nil {
		t.Fatalf("read migration version: %v", err)
	}
	if version != 5 {
		t.Fatalf("migration version = %d, want 5", version)
	}
}

func TestProductionSchemaAdoptsExactUnversionedBaseline(t *testing.T) {
	dbURL := migrationTestSchema(t)
	db := openMigrationTestDB(t, dbURL, false)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	for _, statement := range baselineSchemaDDL() {
		if _, err := db.Pool.Exec(ctx, statement); err != nil {
			t.Fatalf("create unversioned baseline with %q: %v", statement, err)
		}
	}
	var entityVersion, sequenceBefore int64
	if err := db.Pool.QueryRow(ctx, `
		INSERT INTO entities (entity_id, type) VALUES ('legacy-entity', 'asset')
		RETURNING version`).Scan(&entityVersion); err != nil {
		t.Fatalf("insert legacy entity: %v", err)
	}
	if _, err := db.Pool.Exec(ctx, `
		INSERT INTO admin_records (id, type, json)
		VALUES ('legacy-admin', 'test', '{"preserved":true}')`); err != nil {
		t.Fatalf("insert legacy admin record: %v", err)
	}
	if err := db.Pool.QueryRow(ctx, `SELECT last_value FROM atlas_change_version_seq`).Scan(&sequenceBefore); err != nil {
		t.Fatalf("read legacy change sequence: %v", err)
	}

	if err := db.EnsureTables(ctx); err != nil {
		t.Fatalf("adopt exact unversioned baseline: %v", err)
	}
	assertCurrentMigration(ctx, t, db)

	var clockAfter, persistedVersion int64
	if err := db.Pool.QueryRow(ctx, `SELECT version FROM atlas_change_clock WHERE singleton`).Scan(&clockAfter); err != nil {
		t.Fatalf("read adopted change clock: %v", err)
	}
	if err := db.Pool.QueryRow(ctx, `SELECT version FROM entities WHERE entity_id = 'legacy-entity'`).Scan(&persistedVersion); err != nil {
		t.Fatalf("read adopted entity: %v", err)
	}
	if clockAfter != sequenceBefore || persistedVersion != entityVersion {
		t.Fatalf("baseline adoption rewrote versions: sequence %d -> clock %d, entity %d -> %d", sequenceBefore, clockAfter, entityVersion, persistedVersion)
	}
	var legacySequenceExists bool
	if err := db.Pool.QueryRow(ctx, `SELECT to_regclass('atlas_change_version_seq') IS NOT NULL`).Scan(&legacySequenceExists); err != nil {
		t.Fatalf("check legacy change sequence: %v", err)
	}
	if legacySequenceExists {
		t.Fatal("legacy change sequence still exists after transactional stream migration")
	}
	var adminCount int
	if err := db.Pool.QueryRow(ctx, `SELECT COUNT(*) FROM admin_records WHERE id = 'legacy-admin'`).Scan(&adminCount); err != nil || adminCount != 1 {
		t.Fatalf("legacy admin record was not preserved: count=%d err=%v", adminCount, err)
	}
	db.Close()
}

func TestProductionSchemaRejectsDriftAndPartialLegacySchema(t *testing.T) {
	t.Run("versioned drift", func(t *testing.T) {
		dbURL := migrationTestSchema(t)
		db := openMigrationTestDB(t, dbURL, false)
		defer db.Close()
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if err := db.EnsureTables(ctx); err != nil {
			t.Fatalf("install schema: %v", err)
		}
		if _, err := db.Pool.Exec(ctx, `DROP INDEX idx_entities_type`); err != nil {
			t.Fatalf("introduce index drift: %v", err)
		}
		if err := db.EnsureTables(ctx); !errors.Is(err, ErrSchemaDrift) {
			t.Fatalf("drifted restart error = %v, want ErrSchemaDrift", err)
		}
	})

	t.Run("partial unversioned schema", func(t *testing.T) {
		dbURL := migrationTestSchema(t)
		db := openMigrationTestDB(t, dbURL, false)
		defer db.Close()
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if _, err := db.Pool.Exec(ctx, `CREATE TABLE entities (entity_id TEXT PRIMARY KEY)`); err != nil {
			t.Fatalf("create partial legacy schema: %v", err)
		}
		if err := db.EnsureTables(ctx); !errors.Is(err, ErrSchemaDrift) {
			t.Fatalf("partial legacy restart error = %v, want ErrSchemaDrift", err)
		}
		var migrationTablePresent bool
		if err := db.Pool.QueryRow(ctx, `SELECT to_regclass('atlas_schema_migrations') IS NOT NULL`).Scan(&migrationTablePresent); err != nil {
			t.Fatalf("check rolled-back migration metadata: %v", err)
		}
		if migrationTablePresent {
			t.Fatal("partial legacy failure left atlas_schema_migrations behind")
		}
	})

	t.Run("unversioned row security drift", func(t *testing.T) {
		dbURL := migrationTestSchema(t)
		db := openMigrationTestDB(t, dbURL, false)
		defer db.Close()
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		for _, statement := range baselineSchemaDDL() {
			if _, err := db.Pool.Exec(ctx, statement); err != nil {
				t.Fatalf("create unversioned baseline: %v", err)
			}
		}
		if _, err := db.Pool.Exec(ctx, `ALTER TABLE entities ENABLE ROW LEVEL SECURITY`); err != nil {
			t.Fatalf("enable legacy row security drift: %v", err)
		}
		if _, err := db.Pool.Exec(ctx, `ALTER TABLE entities FORCE ROW LEVEL SECURITY`); err != nil {
			t.Fatalf("force legacy row security drift: %v", err)
		}
		if err := db.EnsureTables(ctx); !errors.Is(err, ErrSchemaDrift) {
			t.Fatalf("unversioned row security error = %v, want ErrSchemaDrift", err)
		}
	})

	t.Run("unversioned disabled foreign key trigger", func(t *testing.T) {
		dbURL := migrationTestSchema(t)
		db := openMigrationTestDB(t, dbURL, false)
		defer db.Close()
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		for _, statement := range baselineSchemaDDL() {
			if _, err := db.Pool.Exec(ctx, statement); err != nil {
				t.Fatalf("create unversioned baseline: %v", err)
			}
		}
		if _, err := db.Pool.Exec(ctx, `ALTER TABLE tasks DISABLE TRIGGER ALL`); err != nil {
			var pgErr *pgconn.PgError
			if errors.As(err, &pgErr) && pgErr.Code == "42501" {
				t.Skip("test database role cannot disable internal constraint triggers")
			}
			t.Fatalf("disable legacy foreign key triggers: %v", err)
		}
		if err := db.EnsureTables(ctx); !errors.Is(err, ErrSchemaDrift) {
			t.Fatalf("disabled legacy trigger error = %v, want ErrSchemaDrift", err)
		}
	})

	t.Run("unexpected relation", func(t *testing.T) {
		dbURL := migrationTestSchema(t)
		db := openMigrationTestDB(t, dbURL, false)
		defer db.Close()
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if err := db.EnsureTables(ctx); err != nil {
			t.Fatalf("install schema: %v", err)
		}
		if _, err := db.Pool.Exec(ctx, `CREATE TABLE out_of_band_table (id INTEGER)`); err != nil {
			t.Fatalf("introduce unexpected relation: %v", err)
		}
		if err := db.EnsureTables(ctx); !errors.Is(err, ErrSchemaDrift) {
			t.Fatalf("unexpected relation restart error = %v, want ErrSchemaDrift", err)
		}
	})

	t.Run("row security policy", func(t *testing.T) {
		dbURL := migrationTestSchema(t)
		db := openMigrationTestDB(t, dbURL, false)
		defer db.Close()
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if err := db.EnsureTables(ctx); err != nil {
			t.Fatalf("install schema: %v", err)
		}
		if _, err := db.Pool.Exec(ctx, `ALTER TABLE entities ENABLE ROW LEVEL SECURITY`); err != nil {
			t.Fatalf("enable row security drift: %v", err)
		}
		if _, err := db.Pool.Exec(ctx, `CREATE POLICY atlas_test_policy ON entities USING (true)`); err != nil {
			t.Fatalf("create row security policy drift: %v", err)
		}
		if err := db.EnsureTables(ctx); !errors.Is(err, ErrSchemaDrift) {
			t.Fatalf("row security restart error = %v, want ErrSchemaDrift", err)
		}
	})
}

func TestFailedMigrationRollsBack(t *testing.T) {
	dbURL := migrationTestSchema(t)
	db := openMigrationTestDB(t, dbURL, false)
	defer db.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := db.EnsureTables(ctx); err != nil {
		t.Fatalf("install schema: %v", err)
	}
	if _, err := db.Pool.Exec(ctx, `
		WITH next AS (UPDATE atlas_change_clock SET version = version + 1 WHERE singleton RETURNING version)
		INSERT INTO entities (entity_id, type, version) SELECT 'rollback-entity', 'asset', version FROM next
	`); err != nil {
		t.Fatalf("insert rollback sentinel: %v", err)
	}

	migrations := coreSchemaMigrations()
	failing := schemaMigration{
		version:            5,
		name:               "deliberate_rollback_probe",
		fingerprintVersion: fingerprintVersionV1,
		statements:         []string{`ALTER TABLE entities ADD COLUMN rollback_probe TEXT`, `THIS IS NOT VALID SQL`},
	}
	failing.checksum = migrationChecksum(failing)
	migrations = append(migrations, failing)
	if err := db.ensureTables(ctx, migrations); err == nil || !strings.Contains(err.Error(), "failed to apply schema migration 5") {
		t.Fatalf("failing migration error = %v", err)
	}

	var probeColumnPresent bool
	if err := db.Pool.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM information_schema.columns
			WHERE table_schema = current_schema()
			  AND table_name = 'entities'
			  AND column_name = 'rollback_probe'
		)`).Scan(&probeColumnPresent); err != nil {
		t.Fatalf("check rollback probe column: %v", err)
	}
	if probeColumnPresent {
		t.Fatal("failed migration left rollback_probe column behind")
	}
	assertCurrentMigration(ctx, t, db)
	var entityCount int
	if err := db.Pool.QueryRow(ctx, `SELECT COUNT(*) FROM entities WHERE entity_id = 'rollback-entity'`).Scan(&entityCount); err != nil || entityCount != 1 {
		t.Fatalf("failed migration lost existing data: count=%d err=%v", entityCount, err)
	}
}

func TestScratchSchemaRestartDropsResourcesButPreservesAdminRecords(t *testing.T) {
	dbURL := migrationTestSchema(t)
	db := openMigrationTestDB(t, dbURL, true)
	defer db.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := db.EnsureTables(ctx); err != nil {
		t.Fatalf("install scratch schema: %v", err)
	}
	if _, err := db.Pool.Exec(ctx, `
		WITH next AS (UPDATE atlas_change_clock SET version = version + 1 WHERE singleton RETURNING version)
		INSERT INTO entities (entity_id, type, version) SELECT 'scratch-entity', 'asset', version FROM next
	`); err != nil {
		t.Fatalf("insert scratch entity: %v", err)
	}
	if _, err := db.Pool.Exec(ctx, `INSERT INTO admin_records (id, type, json) VALUES ('scratch-admin', 'test', '{}')`); err != nil {
		t.Fatalf("insert scratch admin record: %v", err)
	}
	if _, err := db.Pool.Exec(ctx, `
		INSERT INTO storage_upload_intents (bucket, path, object_id, owner_id, expires_at)
		VALUES ('atlas-media', 'objects/scratch-upload/blob', 'scratch-upload', '00000000-0000-0000-0000-000000000002', clock_timestamp() + interval '5 minutes')`); err != nil {
		t.Fatalf("insert scratch upload intent: %v", err)
	}
	if err := db.EnsureTables(ctx); err != nil {
		t.Fatalf("restart scratch schema: %v", err)
	}

	var resourceCount, adminCount, intentCount int
	if err := db.Pool.QueryRow(ctx, `SELECT COUNT(*) FROM entities`).Scan(&resourceCount); err != nil {
		t.Fatalf("count scratch resources: %v", err)
	}
	if err := db.Pool.QueryRow(ctx, `SELECT COUNT(*) FROM admin_records WHERE id = 'scratch-admin'`).Scan(&adminCount); err != nil {
		t.Fatalf("count scratch admin records: %v", err)
	}
	if err := db.Pool.QueryRow(ctx, `SELECT COUNT(*) FROM storage_upload_intents`).Scan(&intentCount); err != nil {
		t.Fatalf("count scratch upload intents: %v", err)
	}
	if resourceCount != 0 || adminCount != 1 || intentCount != 0 {
		t.Fatalf("scratch restart counts = resources:%d admin:%d intents:%d, want 0, 1, and 0", resourceCount, adminCount, intentCount)
	}
	var resetVersion int64
	if err := db.Pool.QueryRow(ctx, `
		WITH next AS (UPDATE atlas_change_clock SET version = version + 1 WHERE singleton RETURNING version)
		INSERT INTO entities (entity_id, type, version) SELECT 'scratch-after-reset', 'asset', version FROM next
		RETURNING version`).Scan(&resetVersion); err != nil {
		t.Fatalf("insert resource after scratch reset: %v", err)
	}
	if resetVersion != 1 {
		t.Fatalf("first change version after scratch reset = %d, want 1", resetVersion)
	}
	assertCurrentMigration(ctx, t, db)
}

func TestScratchSchemaKeepsLedgerAcrossAdminMigration(t *testing.T) {
	dbURL := migrationTestSchema(t)
	db := openMigrationTestDB(t, dbURL, true)
	defer db.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := db.EnsureTables(ctx); err != nil {
		t.Fatalf("install scratch schema: %v", err)
	}
	if _, err := db.Pool.Exec(ctx, `INSERT INTO admin_records (id, type, json) VALUES ('migrated-admin', 'test', '{}')`); err != nil {
		t.Fatalf("insert admin record: %v", err)
	}

	migrations := coreSchemaMigrations()
	adminMigration := schemaMigration{
		version:            5,
		name:               "add_admin_migration_probe",
		fingerprintVersion: fingerprintVersionV1,
		statements:         []string{`ALTER TABLE admin_records ADD COLUMN migration_probe TEXT`},
	}
	adminMigration.checksum = migrationChecksum(adminMigration)
	migrations = append(migrations, adminMigration)
	for restart := 1; restart <= 2; restart++ {
		if err := db.ensureTables(ctx, migrations); err != nil {
			t.Fatalf("scratch startup %d with admin migration: %v", restart, err)
		}
	}

	var adminCount, migrationVersion int
	if err := db.Pool.QueryRow(ctx, `SELECT COUNT(*) FROM admin_records WHERE id = 'migrated-admin'`).Scan(&adminCount); err != nil {
		t.Fatalf("count migrated admin record: %v", err)
	}
	if err := db.Pool.QueryRow(ctx, `SELECT max(version) FROM atlas_schema_migrations`).Scan(&migrationVersion); err != nil {
		t.Fatalf("read scratch migration version: %v", err)
	}
	if adminCount != 1 || migrationVersion != 5 {
		t.Fatalf("scratch migration state = admin:%d version:%d, want 1 and 5", adminCount, migrationVersion)
	}
}

func migrationTestSchema(t *testing.T) string {
	t.Helper()
	dbURL, explicitDBURL := databaseTestURL()
	if dbURL == "" {
		testenv.SkipOrFatal(t, "set ATLAS_DATABASE_TEST_URL, DATABASE_URL, or POSTGRES_PASSWORD to run migration integration tests")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	conn, err := pgx.Connect(ctx, dbURL)
	if err != nil {
		if explicitDBURL {
			t.Fatalf("connect migration test database: %v", err)
		}
		testenv.SkipOrFatal(t, "migration test database unavailable: %v", err)
	}
	schema := fmt.Sprintf("atlas_migration_test_%d", time.Now().UTC().UnixNano())
	identifier := pgx.Identifier{schema}.Sanitize()
	if _, err := conn.Exec(ctx, "CREATE SCHEMA "+identifier); err != nil {
		_ = conn.Close(context.Background())
		if explicitDBURL {
			t.Fatalf("create migration test schema: %v", err)
		}
		testenv.SkipOrFatal(t, "migration test database unavailable: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		if _, err := conn.Exec(cleanupCtx, "DROP SCHEMA IF EXISTS "+identifier+" CASCADE"); err != nil {
			t.Errorf("drop migration test schema %s: %v", schema, err)
		}
		if err := conn.Close(cleanupCtx); err != nil {
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
	return parsed.String()
}

func openMigrationTestDB(t *testing.T, dbURL string, recreate bool) *DB {
	t.Helper()
	db, err := New(&config.Config{
		DatabaseURL:               dbURL,
		DatabaseRecreateOnStartup: recreate,
		DatabasePoolSize:          1,
		DatabaseMaxOverflow:       1,
		DatabasePoolRecycle:       3600,
		DatabasePoolTimeout:       10,
		DatabasePoolIdleTimeout:   30,
		DatabasePoolPrePing:       false,
	})
	if err != nil {
		t.Fatalf("open migration test database: %v", err)
	}
	return db
}

func assertCurrentMigration(ctx context.Context, t *testing.T, db *DB) {
	t.Helper()
	migrations := coreSchemaMigrations()
	expected := migrations[len(migrations)-1]
	var version int
	var name, checksum, fingerprint string
	var fingerprintVersion int
	if err := db.Pool.QueryRow(ctx, `
		SELECT version, name, checksum, fingerprint_version, schema_fingerprint
		FROM atlas_schema_migrations
		ORDER BY version DESC
		LIMIT 1`).Scan(&version, &name, &checksum, &fingerprintVersion, &fingerprint); err != nil {
		t.Fatalf("read current schema migration: %v", err)
	}
	if version != expected.version || name != expected.name || checksum != expected.checksum || fingerprintVersion != expected.fingerprintVersion || strings.TrimSpace(fingerprint) == "" {
		t.Fatalf("migration row = %d/%s/%s/fingerprint-v%d/%s", version, name, checksum, fingerprintVersion, fingerprint)
	}
}
