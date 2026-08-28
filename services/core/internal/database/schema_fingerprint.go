package database

import (
	"context"
	"crypto/sha256"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
)

func schemaFingerprint(ctx context.Context, tx pgx.Tx, schema string, version int) (string, error) {
	switch version {
	case fingerprintVersionV1:
		return schemaFingerprintV1(ctx, tx, schema)
	case fingerprintVersionV2:
		return schemaFingerprintV2(ctx, tx, schema)
	default:
		return "", fmt.Errorf("%w: unsupported schema fingerprint version %d", ErrMigrationHistory, version)
	}
}

// schemaFingerprintV1 is immutable so older migration rows remain verifiable.
func schemaFingerprintV1(ctx context.Context, tx pgx.Tx, schema string) (string, error) {
	return schemaFingerprintWithQuery(ctx, tx, schema, schemaFingerprintV1SQL)
}

func schemaFingerprintV2(ctx context.Context, tx pgx.Tx, schema string) (string, error) {
	return schemaFingerprintWithQuery(ctx, tx, schema, schemaFingerprintV2SQL)
}

func schemaFingerprintWithQuery(ctx context.Context, tx pgx.Tx, schema, query string) (string, error) {
	rows, err := tx.Query(ctx, query, schema)
	if err != nil {
		return "", fmt.Errorf("failed to inspect schema fingerprint: %w", err)
	}
	defer rows.Close()

	hash := sha256.New()
	for rows.Next() {
		var kind, name, detail string
		if err := rows.Scan(&kind, &name, &detail); err != nil {
			return "", fmt.Errorf("failed to scan schema fingerprint: %w", err)
		}
		detail = normalizeSchemaReferenceV1(detail, schema)
		_, _ = fmt.Fprintf(hash, "%s\x00%s\x00%s\n", kind, name, detail)
	}
	if err := rows.Err(); err != nil {
		return "", fmt.Errorf("failed to inspect schema fingerprint: %w", err)
	}
	return fmt.Sprintf("%x", hash.Sum(nil)), nil
}

func normalizeSchemaReferenceV1(value, schema string) string {
	return strings.NewReplacer(
		`"`+schema+`".`, "",
		schema+`.`, "",
	).Replace(value)
}

const schemaFingerprintV1SQL = schemaFingerprintSQLHead + `cols.ordinal_position::text` + schemaFingerprintSQLTail

// PostgreSQL preserves dropped-column attribute numbers until a dump and
// restore rebuilds the table. V2 fingerprints the dense order of live columns
// so that storage history is not mistaken for a schema change.
const schemaFingerprintV2SQL = schemaFingerprintSQLHead + `dense_rank() OVER (
					PARTITION BY cols.table_name ORDER BY cols.ordinal_position
				)::text` + schemaFingerprintSQLTail

const schemaFingerprintSQLHead = `
	SELECT kind, object_name, detail
	FROM (
		SELECT
			'relation'::text AS kind,
			c.relname::text AS object_name,
			concat_ws('|',
				c.relkind::text,
				c.relpersistence::text,
				c.relrowsecurity::text,
				c.relforcerowsecurity::text,
				c.relreplident::text,
				c.relispartition::text,
				COALESCE(array_to_string(c.reloptions, ','), ''),
				CASE WHEN c.relkind IN ('v', 'm') THEN pg_get_viewdef(c.oid, true) ELSE '' END,
				CASE WHEN c.relispartition THEN pg_get_expr(c.relpartbound, c.oid) ELSE '' END
			) AS detail
		FROM pg_catalog.pg_class c
		JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
		WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'S', 'v', 'm', 'f')

		UNION ALL

		SELECT
			'column'::text,
			cols.table_name || '.' || cols.column_name,
			concat_ws('|',
`

const schemaFingerprintSQLTail = `,
				cols.data_type,
				cols.udt_name,
				cols.is_nullable,
				COALESCE(cols.character_maximum_length::text, ''),
				COALESCE(cols.numeric_precision::text, ''),
				COALESCE(cols.numeric_scale::text, ''),
				COALESCE(cols.datetime_precision::text, ''),
				COALESCE(cols.collation_name, ''),
				COALESCE(cols.column_default, ''),
				cols.is_identity,
				cols.is_generated
			)
		FROM information_schema.columns cols
		WHERE cols.table_schema = $1

		UNION ALL

		SELECT
			'index'::text,
			t.relname || '.' || i.relname,
			concat_ws('|', ix.indisvalid::text, ix.indisready::text, pg_get_indexdef(i.oid))
		FROM pg_catalog.pg_index ix
		JOIN pg_catalog.pg_class i ON i.oid = ix.indexrelid
		JOIN pg_catalog.pg_class t ON t.oid = ix.indrelid
		JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
		WHERE n.nspname = $1

		UNION ALL

		SELECT
			'constraint'::text,
			t.relname || '.' || con.conname,
			concat_ws('|', con.contype::text, con.convalidated::text, pg_get_constraintdef(con.oid, true))
		FROM pg_catalog.pg_constraint con
		JOIN pg_catalog.pg_class t ON t.oid = con.conrelid
		JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
		WHERE n.nspname = $1

		UNION ALL

		SELECT
			'trigger'::text,
			t.relname || '.' || trg.tgname,
			trg.tgenabled::text || '|' || pg_get_triggerdef(trg.oid, true)
		FROM pg_catalog.pg_trigger trg
		JOIN pg_catalog.pg_class t ON t.oid = trg.tgrelid
		JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
		WHERE n.nspname = $1 AND NOT trg.tgisinternal

		UNION ALL

		SELECT
			'internal_trigger'::text,
			concat_ws('.', t.relname, COALESCE(con.conname, ''), trg.tgfoid::regproc::text, trg.tgtype::text),
			concat_ws('|', trg.tgenabled::text, trg.tgdeferrable::text, trg.tginitdeferred::text)
		FROM pg_catalog.pg_trigger trg
		JOIN pg_catalog.pg_class t ON t.oid = trg.tgrelid
		JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
		LEFT JOIN pg_catalog.pg_constraint con ON con.oid = trg.tgconstraint
		WHERE n.nspname = $1 AND trg.tgisinternal

		UNION ALL

		SELECT
			'policy'::text,
			t.relname || '.' || policy.polname,
			concat_ws('|',
				policy.polcmd::text,
				policy.polpermissive::text,
				COALESCE((
					SELECT string_agg(pg_get_userbyid(role_id), ',' ORDER BY pg_get_userbyid(role_id))
					FROM unnest(policy.polroles) AS roles(role_id)
				), ''),
				COALESCE(pg_get_expr(policy.polqual, policy.polrelid), ''),
				COALESCE(pg_get_expr(policy.polwithcheck, policy.polrelid), '')
			)
		FROM pg_catalog.pg_policy policy
		JOIN pg_catalog.pg_class t ON t.oid = policy.polrelid
		JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
		WHERE n.nspname = $1

		UNION ALL

		SELECT
			'sequence'::text,
			c.relname,
			concat_ws('|', seq.seqtypid::regtype::text, seq.seqstart::text, seq.seqincrement::text, seq.seqmax::text, seq.seqmin::text, seq.seqcache::text, seq.seqcycle::text)
		FROM pg_catalog.pg_sequence seq
		JOIN pg_catalog.pg_class c ON c.oid = seq.seqrelid
		JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
		WHERE n.nspname = $1
	) fingerprint_parts
	ORDER BY kind, object_name, detail`

func expectedUnversionedBaselineFingerprint(ctx context.Context, tx pgx.Tx, baseline schemaMigration) (string, error) {
	return expectedBaselineSchemaFingerprint(ctx, tx, baseline, false)
}

func expectedBaselineFingerprint(ctx context.Context, tx pgx.Tx, baseline schemaMigration) (string, error) {
	return expectedBaselineSchemaFingerprint(ctx, tx, baseline, true)
}

func expectedBaselineSchemaFingerprint(ctx context.Context, tx pgx.Tx, baseline schemaMigration, includeMigrationTable bool) (string, error) {
	var originalSearchPath string
	if err := tx.QueryRow(ctx, `SHOW search_path`).Scan(&originalSearchPath); err != nil {
		return "", fmt.Errorf("failed to read database search path: %w", err)
	}
	var expectedSchema string
	if err := tx.QueryRow(ctx, `SELECT format('atlas_schema_check_%s_%s', pg_backend_pid(), txid_current())`).Scan(&expectedSchema); err != nil {
		return "", fmt.Errorf("failed to allocate baseline verification schema: %w", err)
	}
	expectedIdentifier := pgx.Identifier{expectedSchema}.Sanitize()
	if _, err := tx.Exec(ctx, "CREATE SCHEMA "+expectedIdentifier); err != nil {
		return "", fmt.Errorf("failed to create baseline verification schema: %w", err)
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('search_path', $1, true)`, expectedIdentifier); err != nil {
		return "", fmt.Errorf("failed to select baseline verification schema: %w", err)
	}
	if includeMigrationTable {
		if _, err := tx.Exec(ctx, migrationTableDDL); err != nil {
			return "", fmt.Errorf("failed to build expected migration table: %w", err)
		}
	}
	for _, statement := range baseline.statements {
		if _, err := tx.Exec(ctx, statement); err != nil {
			return "", fmt.Errorf("failed to build expected baseline schema: %w", err)
		}
	}
	fingerprint, err := schemaFingerprint(ctx, tx, expectedSchema, baseline.fingerprintVersion)
	if err != nil {
		return "", err
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('search_path', $1, true)`, originalSearchPath); err != nil {
		return "", fmt.Errorf("failed to restore database search path: %w", err)
	}
	if _, err := tx.Exec(ctx, "DROP SCHEMA "+expectedIdentifier+" CASCADE"); err != nil {
		return "", fmt.Errorf("failed to remove baseline verification schema: %w", err)
	}
	return fingerprint, nil
}
