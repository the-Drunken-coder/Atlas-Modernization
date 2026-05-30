// Package database provides PostgreSQL database connectivity and operations.
package database

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/config"
)

// ErrNilDB is returned when Ping is called on a nil *DB receiver.
var ErrNilDB = errors.New("database: nil DB")

// ErrNilPool is returned when Ping is called but the connection pool was never initialized.
var ErrNilPool = errors.New("database: nil pool")

// ErrSchemaNotPresent is returned when DATABASE_RECREATE_ON_STARTUP is false and core tables are missing.
var ErrSchemaNotPresent = errors.New("database: core schema tables are missing; set DATABASE_RECREATE_ON_STARTUP=true or initialize the database")

// coreSchemaTables are required when destructive recreate is disabled.
var coreSchemaTables = []string{"entities", "tasks", "objects", "deletions"}

// DB wraps the connection pool and provides database operations.
type DB struct {
	Pool              *pgxpool.Pool
	recreateOnStartup bool
}

func buildPoolConfig(cfg *config.Config) (*pgxpool.Config, error) {
	if cfg == nil {
		return nil, fmt.Errorf("nil config")
	}
	poolConfig, err := pgxpool.ParseConfig(cfg.DatabaseURL)
	if err != nil {
		return nil, fmt.Errorf("failed to parse database URL: %w", err)
	}

	// Configure pool settings (capped to prevent int32 overflow); use int64 sums to avoid wraparound.
	maxConns64 := int64(cfg.DatabasePoolSize) + int64(cfg.DatabaseMaxOverflow)
	if maxConns64 < 0 {
		maxConns64 = 0
	}
	if maxConns64 > 1000 {
		maxConns64 = 1000
	}
	if maxConns64 < 1 {
		maxConns64 = 1
	}
	minConns64 := int64(cfg.DatabasePoolSize)
	if minConns64 < 0 {
		minConns64 = 0
	}
	if minConns64 > 1000 {
		minConns64 = 1000
	}
	if minConns64 > maxConns64 {
		minConns64 = maxConns64
	}
	if maxConns64 >= 1 && minConns64 < 1 {
		minConns64 = 1
	}
	poolConfig.MaxConns = int32(maxConns64) //nolint:gosec // capped above
	poolConfig.MinConns = int32(minConns64) //nolint:gosec // capped above

	recycleSec := cfg.DatabasePoolRecycle
	if recycleSec < 0 {
		recycleSec = 0
	}
	const maxDurSec = 86400 * 366 * 10 // ~10 years; avoids overflowed time.Duration from absurd env values
	if recycleSec > maxDurSec {
		recycleSec = maxDurSec
	}
	idleSec := cfg.DatabasePoolIdleTimeout
	if idleSec < 0 {
		idleSec = 0
	}
	if idleSec > maxDurSec {
		idleSec = maxDurSec
	}
	poolConfig.MaxConnLifetime = time.Duration(recycleSec) * time.Second
	poolConfig.MaxConnIdleTime = time.Duration(idleSec) * time.Second

	// Health check configuration
	if cfg.DatabasePoolPrePing {
		poolConfig.HealthCheckPeriod = 30 * time.Second
		prev := poolConfig.PrepareConn
		poolConfig.PrepareConn = func(ctx context.Context, c *pgx.Conn) (bool, error) {
			if err := c.Ping(ctx); err != nil {
				// Discard ping error: false,nil tells the pool to drop this conn and retry the query.
				return false, nil //nolint:nilerr
			}
			if prev != nil {
				return prev(ctx, c)
			}
			return true, nil
		}
	}

	return poolConfig, nil
}

// New creates a new database connection pool.
func New(cfg *config.Config) (*DB, error) {
	poolConfig, err := buildPoolConfig(cfg)
	if err != nil {
		return nil, err
	}

	poolTimeoutSec := cfg.DatabasePoolTimeout
	if poolTimeoutSec <= 0 {
		poolTimeoutSec = 10
	}
	if poolTimeoutSec > 300 {
		poolTimeoutSec = 300
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(poolTimeoutSec)*time.Second)
	defer cancel()

	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		return nil, fmt.Errorf("failed to create connection pool: %w", err)
	}

	// Verify connection
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("failed to ping database: %w", err)
	}

	return &DB{
		Pool:              pool,
		recreateOnStartup: cfg.DatabaseRecreateOnStartup,
	}, nil
}

// coreSchemaTablesPresent reports whether all core application tables exist.
func coreSchemaTablesPresent(ctx context.Context, q interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}) (bool, error) {
	const qSQL = `
		SELECT COUNT(*) = $1
		FROM information_schema.tables
		WHERE table_schema = 'public'
		  AND table_name = ANY($2::text[])`
	var ok bool
	if err := q.QueryRow(ctx, qSQL, len(coreSchemaTables), coreSchemaTables).Scan(&ok); err != nil {
		return false, fmt.Errorf("failed to check core schema tables: %w", err)
	}
	return ok, nil
}

// Close closes the database connection pool.
func (db *DB) Close() {
	if db == nil {
		return
	}
	if db.Pool != nil {
		db.Pool.Close()
	}
}

// Ping verifies database connectivity.
func (db *DB) Ping(ctx context.Context) error {
	if db == nil {
		return ErrNilDB
	}
	if db.Pool == nil {
		return ErrNilPool
	}
	return db.Pool.Ping(ctx)
}

// EnsureTables drops and recreates every table on every startup.
//
// Rationale (destroy-and-recreate, not IF NOT EXISTS):
//
//	CREATE TABLE IF NOT EXISTS is the worst of both worlds: it bootstraps
//	a fresh database cleanly, but it silently skips tables that already exist.
//	If you add a column to the Go model and the DDL, restart against an existing
//	DB, and the column simply never appears — no error, no warning, just a
//	runtime query failure later. That drift is hard to notice and harder to
//	debug.
//
//	We could add a schema-version hash to detect drift and only recreate when
//	tables are stale, but this project is greenfield with no real data.
//	Recreating every time adds zero complexity and makes drift structurally
//	impossible. When data persistence eventually matters, the hash approach
//	is a natural upgrade path (drop → recreate only if the schema hash changed).
//
//	DROP TABLE IF EXISTS … CASCADE handles foreign-key dependencies without
//	needing a manually maintained drop order. All DDL runs in a single
//	transaction so a mid-flight failure rolls back, leaving the database in
//	whatever state it had before EnsureTables started.
func (db *DB) EnsureTables(ctx context.Context) error {
	if db == nil {
		return ErrNilDB
	}
	if db.Pool == nil {
		return ErrNilPool
	}

	if !db.recreateOnStartup {
		present, err := coreSchemaTablesPresent(ctx, db.Pool)
		if err != nil {
			return err
		}
		if !present {
			return ErrSchemaNotPresent
		}
		return nil
	}

	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("failed to begin schema transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Drop order: tasks (depends on entities) first, then everything else.
	// CASCADE is a safety net — it severs any FK the explicit order misses
	// (e.g., a future table referencing tasks or entities).
	dropDDL := []string{
		`DROP TABLE IF EXISTS tasks CASCADE`,
		`DROP TABLE IF EXISTS entities CASCADE`,
		`DROP TABLE IF EXISTS objects CASCADE`,
		`DROP TABLE IF EXISTS deletions CASCADE`,
	}
	for _, stmt := range dropDDL {
		if _, err = tx.Exec(ctx, stmt); err != nil {
			return fmt.Errorf("failed to drop tables: %w", err)
		}
	}

	createDDL := []string{
		`CREATE TABLE entities (
			entity_id VARCHAR(50) PRIMARY KEY,
			type VARCHAR(50) NOT NULL,
			subtype VARCHAR(50),
			alias VARCHAR(255),
			json JSONB NOT NULL DEFAULT '{}',
			created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
			updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
		)`,
		`CREATE INDEX idx_entities_type ON entities(type)`,
		`CREATE INDEX idx_entities_subtype ON entities(subtype)`,
		`CREATE UNIQUE INDEX idx_entities_alias_unique ON entities(alias) WHERE alias IS NOT NULL`,

		`CREATE TABLE tasks (
			task_id VARCHAR(50) PRIMARY KEY,
			status VARCHAR(50) NOT NULL DEFAULT 'pending',
			entity_id VARCHAR(50) REFERENCES entities(entity_id) ON DELETE SET NULL,
			json JSONB NOT NULL DEFAULT '{}',
			created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
			updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
		)`,
		`CREATE INDEX idx_tasks_status ON tasks(status)`,
		`CREATE INDEX idx_tasks_entity_id ON tasks(entity_id)`,

		`CREATE TABLE objects (
			object_id VARCHAR(50) PRIMARY KEY,
			path VARCHAR(500) UNIQUE,
			content_type VARCHAR(100),
			type VARCHAR(50),
			json JSONB NOT NULL DEFAULT '{}',
			created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
			updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
		)`,
		`CREATE INDEX idx_objects_content_type ON objects(content_type)`,
		`CREATE INDEX idx_objects_type ON objects(type)`,
		`CREATE INDEX idx_objects_referenced_by ON objects USING GIN ((json->'referenced_by') jsonb_path_ops)`,

		// deletions table tracks hard-deleted resources so the changed-since
		// endpoint can return tombstones for client cache eviction.
		`CREATE TABLE deletions (
			id BIGSERIAL PRIMARY KEY,
			resource_type VARCHAR(20) NOT NULL,
			resource_id VARCHAR(50) NOT NULL,
			deleted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
		)`,
		`CREATE INDEX idx_deletions_deleted_at ON deletions(deleted_at)`,
		`CREATE INDEX idx_deletions_resource_type ON deletions(resource_type)`,
	}
	for _, stmt := range createDDL {
		if _, err = tx.Exec(ctx, stmt); err != nil {
			return fmt.Errorf("failed to create schema: %w", err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("failed to commit schema transaction: %w", err)
	}
	return nil
}
