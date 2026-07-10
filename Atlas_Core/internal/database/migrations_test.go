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

func TestAppliedMigrationHistoryMustMatchKnownPrefix(t *testing.T) {
	known := coreSchemaMigrations()
	valid := appliedMigration{
		version:            known[0].version,
		name:               known[0].name,
		checksum:           known[0].checksum,
		fingerprintVersion: known[0].fingerprintVersion,
		schemaFingerprint:  "fingerprint",
	}
	if err := verifyAppliedMigrations([]appliedMigration{valid}, known); err != nil {
		t.Fatalf("valid migration history: %v", err)
	}

	tests := []struct {
		name    string
		applied []appliedMigration
	}{
		{name: "future version", applied: []appliedMigration{valid, {version: 2, name: "future", checksum: "future", fingerprintVersion: fingerprintVersionV1, schemaFingerprint: "future"}}},
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
	assertCurrentMigration(t, ctx, db)

	var entityVersion int64
	if err := db.Pool.QueryRow(ctx, `
		INSERT INTO entities (entity_id, type) VALUES ('durable-entity', 'asset')
		RETURNING version`).Scan(&entityVersion); err != nil {
		t.Fatalf("insert durable entity: %v", err)
	}
	if _, err := db.Pool.Exec(ctx, `
		INSERT INTO admin_records (id, type, json)
		VALUES ('durable-admin', 'test', '{"preserved":true}')`); err != nil {
		t.Fatalf("insert durable admin record: %v", err)
	}
	db.Close()

	db = openMigrationTestDB(t, dbURL, false)
	defer db.Close()
	if err := db.EnsureTables(ctx); err != nil {
		t.Fatalf("production schema restart: %v", err)
	}
	assertCurrentMigration(t, ctx, db)

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
		version:            2,
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
	if version != 2 {
		t.Fatalf("migration version = %d, want 2", version)
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
	assertCurrentMigration(t, ctx, db)

	var sequenceAfter, persistedVersion int64
	if err := db.Pool.QueryRow(ctx, `SELECT last_value FROM atlas_change_version_seq`).Scan(&sequenceAfter); err != nil {
		t.Fatalf("read adopted change sequence: %v", err)
	}
	if err := db.Pool.QueryRow(ctx, `SELECT version FROM entities WHERE entity_id = 'legacy-entity'`).Scan(&persistedVersion); err != nil {
		t.Fatalf("read adopted entity: %v", err)
	}
	if sequenceAfter != sequenceBefore || persistedVersion != entityVersion {
		t.Fatalf("baseline adoption rewrote versions: sequence %d -> %d, entity %d -> %d", sequenceBefore, sequenceAfter, entityVersion, persistedVersion)
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
	if _, err := db.Pool.Exec(ctx, `INSERT INTO entities (entity_id, type) VALUES ('rollback-entity', 'asset')`); err != nil {
		t.Fatalf("insert rollback sentinel: %v", err)
	}

	migrations := coreSchemaMigrations()
	failing := schemaMigration{
		version:            2,
		name:               "deliberate_rollback_probe",
		fingerprintVersion: fingerprintVersionV1,
		statements:         []string{`ALTER TABLE entities ADD COLUMN rollback_probe TEXT`, `THIS IS NOT VALID SQL`},
	}
	failing.checksum = migrationChecksum(failing)
	migrations = append(migrations, failing)
	if err := db.ensureTables(ctx, migrations); err == nil || !strings.Contains(err.Error(), "failed to apply schema migration 2") {
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
	assertCurrentMigration(t, ctx, db)
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
	if _, err := db.Pool.Exec(ctx, `INSERT INTO entities (entity_id, type) VALUES ('scratch-entity', 'asset')`); err != nil {
		t.Fatalf("insert scratch entity: %v", err)
	}
	if _, err := db.Pool.Exec(ctx, `INSERT INTO admin_records (id, type, json) VALUES ('scratch-admin', 'test', '{}')`); err != nil {
		t.Fatalf("insert scratch admin record: %v", err)
	}
	if err := db.EnsureTables(ctx); err != nil {
		t.Fatalf("restart scratch schema: %v", err)
	}

	var resourceCount, adminCount int
	if err := db.Pool.QueryRow(ctx, `SELECT COUNT(*) FROM entities`).Scan(&resourceCount); err != nil {
		t.Fatalf("count scratch resources: %v", err)
	}
	if err := db.Pool.QueryRow(ctx, `SELECT COUNT(*) FROM admin_records WHERE id = 'scratch-admin'`).Scan(&adminCount); err != nil {
		t.Fatalf("count scratch admin records: %v", err)
	}
	if resourceCount != 0 || adminCount != 1 {
		t.Fatalf("scratch restart counts = resources:%d admin:%d, want 0 and 1", resourceCount, adminCount)
	}
	var resetVersion int64
	if err := db.Pool.QueryRow(ctx, `
		INSERT INTO entities (entity_id, type) VALUES ('scratch-after-reset', 'asset')
		RETURNING version`).Scan(&resetVersion); err != nil {
		t.Fatalf("insert resource after scratch reset: %v", err)
	}
	if resetVersion != 1 {
		t.Fatalf("first change version after scratch reset = %d, want 1", resetVersion)
	}
	assertCurrentMigration(t, ctx, db)
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
		version:            2,
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
	if adminCount != 1 || migrationVersion != 2 {
		t.Fatalf("scratch migration state = admin:%d version:%d, want 1 and 2", adminCount, migrationVersion)
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

func assertCurrentMigration(t *testing.T, ctx context.Context, db *DB) {
	t.Helper()
	var version int
	var name, checksum, fingerprint string
	var fingerprintVersion int
	if err := db.Pool.QueryRow(ctx, `
		SELECT version, name, checksum, fingerprint_version, schema_fingerprint
		FROM atlas_schema_migrations`).Scan(&version, &name, &checksum, &fingerprintVersion, &fingerprint); err != nil {
		t.Fatalf("read current schema migration: %v", err)
	}
	if version != 1 || name != baselineMigrationName || checksum != baselineMigrationChecksum || fingerprintVersion != fingerprintVersionV1 || strings.TrimSpace(fingerprint) == "" {
		t.Fatalf("migration row = %d/%s/%s/fingerprint-v%d/%s", version, name, checksum, fingerprintVersion, fingerprint)
	}
}
