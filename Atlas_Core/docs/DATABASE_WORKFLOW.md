# Database Workflow - ATLAS Core System

## Overview

The ATLAS Core System uses a **destroy-and-recreate workflow** by default. On startup, when `DATABASE_RECREATE_ON_STARTUP=true` (the default), `EnsureTables()` drops all tables and recreates them from the DDL defined in `internal/database/db.go`; after storage initialization, Atlas Core also empties the configured MinIO bucket. Set `DATABASE_RECREATE_ON_STARTUP=false` when pointing at a shared or persistent database: startup skips drops and does not clear object storage. The system **never uses migration tools like Alembic or golang-migrate**.

**Why destroy-and-recreate instead of `CREATE TABLE IF NOT EXISTS`?** The old `IF NOT EXISTS` approach created missing tables but silently skipped existing ones. If you added a column to the Go model and DDL, restarted against an existing DB, the column simply never appeared — no error, no warning, just a runtime query failure later. Destroy-and-recreate makes that class of bug impossible. The Go models and DDL are the single source of truth; the database is always an exact reflection of them.

**Why no migrations or schema-version table?** Atlas Core does not treat PostgreSQL or its configured MinIO bucket as long-lived systems of record. Ephemeral storage on restart is intentional for the life of the project — not a stepping stone to Alembic, golang-migrate, or hash-gated recreate. Clients that need history must retain it outside Atlas Core runtime storage.

`DATABASE_RECREATE_ON_STARTUP=false` skips drops and only verifies that core tables exist; it does not evolve schema and is not a production configuration.

## Database Architecture

- **Database**: PostgreSQL 15+ (Docker Compose uses TimescaleDB-enabled Postgres)
- **TimescaleDB**: The extension is created at cluster init in `docker/postgres/init.sql` (`CREATE EXTENSION IF NOT EXISTS timescaledb`). Go `EnsureTables()` does not create extensions or hypertables — only plain tables and indexes.
- **Driver**: pgx v5 (`github.com/jackc/pgx/v5/pgxpool`)
- **Models**: Located in `internal/models/models.go`
- **Schema Creation**: `EnsureTables()` in `internal/database/db.go` — by default drops all tables then recreates them; with `DATABASE_RECREATE_ON_STARTUP=false`, verifies existing core tables only
- **Object Storage Lifecycle**: `storage.Client.EmptyBucket()` in `internal/storage/storage.go` — by default clears the configured MinIO bucket after the bucket is ensured

## Database Schema

Atlas Core persists operational data in PostgreSQL. Go structs in `internal/models/models.go` define the canonical schema; the DDL in `internal/database/db.go` matches them.

### Core Tables

#### `entities`

- Primary key: `entity_id` (`VARCHAR(50)`)
- Columns: `type` (NOT NULL, indexed), `subtype` (nullable, indexed), `alias` (nullable, indexed)
- Cursor indexes: `(created_at DESC, entity_id DESC)`, `(updated_at DESC, entity_id DESC)`
- Stores JSONB blob with components and metadata (telemetry, geometry, task_catalog, media_refs, etc.)
- Represents assets, tracks, geofeatures, and other map entities

#### `tasks`

- Primary key: `task_id` (`VARCHAR(50)`)
- Columns: `status` (NOT NULL, indexed, default: `pending`), `entity_id` (nullable, indexed, foreign key → `entities.entity_id` ON DELETE SET NULL)
- Cursor indexes: `(created_at DESC, task_id DESC)`, `(updated_at DESC, task_id DESC)`, plus entity-scoped variants with leading `entity_id`
- Stores JSONB blob with task specification, parameters, and progress
- Status values: `pending`, `acknowledged`, `completed`, `failed`, `cancelled`

#### `objects`

- Primary key: `object_id` (`VARCHAR(50)`)
- Promoted columns: `path` (unique, indexed), `content_type` (indexed), `type` (indexed)
- Cursor indexes: `(created_at DESC, object_id DESC)`, `(updated_at DESC, object_id DESC)`
- Stores JSONB blob with additional metadata (bucket, size_bytes, usage_hints, referenced_by, checksum, expiry_time, etc.)
- Catalogs binary objects (media files, models, etc.) referenced by entities and tasks via MinIO or other object storage

#### `deletions`

- Primary key: `id` (`BIGSERIAL`)
- Columns: `resource_type` (`VARCHAR(20)`, indexed), `resource_id` (`VARCHAR(50)`), `deleted_at` (`TIMESTAMPTZ`, indexed)
- Cursor index: `(resource_type, deleted_at DESC, resource_id DESC)`
- Records hard-deleted entity/task/object ids so `GET /queries/changed-since` can return tombstones for client cache eviction
- Created by `EnsureTables()` alongside the core tables

### Relationships

- `Task.entity_id` references `Entity.entity_id` for associating tasks with entities
- Objects reference entities and tasks via the `referenced_by` field in the JSON blob

## Current Models

- **Entity** (`entities` table) — Unified entity storage for assets, tracks, geofeatures, etc.
- **Task** (`tasks` table) — Work items dispatched to entities
- **MediaObject** (`objects` table) — Binary objects referenced by entities and tasks

## Schema Change Workflow

### 1. Making Changes

To modify the database schema:

```bash
# Run from Atlas_Core/
# 1. Stop all services (compose file lives under docker/)
docker compose -f docker/docker-compose.yml down

# 2. Edit the DDL in internal/database/db.go (EnsureTables function)
#    and update Go structs in internal/models/models.go as needed

# 3. Rebuild and restart — all tables are dropped and recreated on startup
go build -o atlas_core ./cmd/atlas_core
docker compose -f docker/docker-compose.yml up -d
```

**Note**: `EnsureTables()` drops all tables with `DROP TABLE IF EXISTS ... CASCADE` then recreates them with fresh `CREATE TABLE` statements. All existing data is lost on every restart. This is intentional — add any seed data you need to `docker/postgres/init.sql`.

### 2. What Happens on Startup

When the application starts (via `go run ./cmd/atlas_core` or as a Docker container):

1. **Database Connection**: pgx pool connects to PostgreSQL
2. **Table Drop**: `EnsureTables()` drops all existing tables with `DROP TABLE IF EXISTS ... CASCADE`
3. **Table Creation**: `EnsureTables()` recreates all tables and indexes from the DDL in `db.go`
4. **Storage Initialization**: Atlas Core initializes MinIO, ensures the configured bucket exists, then clears every object in that bucket when recreate mode is enabled
5. **Service Ready**: Application begins serving traffic

All DDL runs in a single transaction — a mid-flight failure rolls back, leaving the database in its prior state.
Bucket clearing failures are startup-fatal in recreate mode; serving with a fresh database and stale blobs is invalid.

### How Tables Are Created

The `internal/database/db.go` file contains `EnsureTables()` which:

1. Drops tables in reverse-dependency order (tasks first, then entities, objects, deletions)
2. Recreates tables and indexes with fresh `CREATE TABLE` / `CREATE INDEX` statements
3. Runs inside the application process via the pgx connection pool

This means:

- **No migration files needed** — DDL in `db.go` is the single source of truth
- **Every startup gets a clean database and bucket** — no schema/blob drift possible under recreate mode
- **All runtime data is ephemeral** — add seed data to `docker/postgres/init.sql` if needed

### 3. Example: Adding a New Column

1. Add the column to the `CREATE TABLE` DDL in `db.go`:

```go
// In internal/database/db.go, inside EnsureTables() createDDL:
`CREATE TABLE entities (
    entity_id VARCHAR(50) PRIMARY KEY,
    type VARCHAR(50) NOT NULL,
    subtype VARCHAR(50),
    alias VARCHAR(255),
    priority INTEGER,
    json JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
)`,
```

2. Update the Go struct in `internal/models/models.go`:

```go
type Entity struct {
    // ... existing fields ...
    Priority  *int  `json:"priority,omitempty" db:"priority"`
}
```

3. Rebuild and restart:

```bash
# Run from Atlas_Core/
go build -o atlas_core ./cmd/atlas_core && docker compose -f docker/docker-compose.yml up -d
```

### 4. Example: Adding a New Table

```go
// In internal/database/db.go, add to EnsureTables() createDDL:
`CREATE TABLE audit_logs (
    id SERIAL PRIMARY KEY,
    entity_id VARCHAR(50) REFERENCES entities(entity_id),
    action VARCHAR(100) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
)`,
```

Then add the corresponding Go struct in `internal/models/models.go` and rebuild.

## Development Guidelines

### Advantages of the Destroy-and-Recreate Approach

- **Simplicity**: No migration files to manage or version control
- **Speed**: Instant schema updates just by editing DDL and models
- **Consistency**: Go structs + DDL in `db.go` are the single source of truth
- **No schema drift**: Database is always an exact match for the current models

### Important Notes

- **Data is ephemeral**: PostgreSQL rows and MinIO blobs are lost on every recreate-mode restart. Seed data goes in `docker/postgres/init.sql`.
- **Schema changes on restart**: Changes to DDL require an application restart to take effect
- **Single-developer workflow**: Not suitable for shared databases or environments where data persistence matters

### Daily Workflow

```bash
# Run from Atlas_Core/
# Morning routine - get latest code and fresh database
git pull
docker compose -f docker/docker-compose.yml down
docker compose -f docker/docker-compose.yml up -d

# During development - after DDL or model changes
go build -o atlas_core ./cmd/atlas_core
docker compose -f docker/docker-compose.yml restart api

# End of day - optional cleanup
docker compose -f docker/docker-compose.yml down
```

## Limitations and Considerations

### What the Auto-Creation Handles

- Creating all tables and indexes fresh on every startup
- Schema is always an exact match for the current DDL
- All operations run in a single transaction

### What It Doesn't Handle

- Data persistence — all rows are lost on every restart
- Selective schema changes — the entire schema is replaced, not evolved

## Troubleshooting

### Windows + Docker Desktop + WSL2 Connection Issues

On Windows systems running Docker Desktop with WSL2 backend, `localhost` port forwarding to Docker containers often doesn't work reliably. This manifests as connection timeouts when trying to connect to `localhost:5432` even though the PostgreSQL container is running and healthy.

**Symptoms:**

- `Connection to localhost:5432 refused` or `Connection timed out`
- `docker exec` commands to the container work fine
- Container shows as healthy in Docker Desktop

**Root Cause:**

Docker Desktop uses WSL2 for container networking. The port forwarding from Windows `localhost` to the WSL2 VM can be unreliable, especially when:
- Multiple WSL distributions are running
- The system has been sleeping/hibernating
- Network configuration has changed

**Solution - Use WSL IP Address:**

Instead of `localhost`, use the WSL IP address to connect to Docker containers:

```bash
# Run from Windows (PowerShell/cmd); not specific to Atlas_Core/
# Get the WSL IP address
wsl -d Ubuntu -- hostname -I
# Example output: 172.26.39.116

# Use this IP in your connection string
postgresql://atlas:atlas@172.26.39.116:5432/atlas_core
```

**For DBeaver/Database Tools:**

- Host: Use the WSL IP (e.g., `172.26.39.116`) instead of `localhost`
- Port: `5432`
- Database: `atlas_core`
- User: `atlas`
- Password: `atlas` (matches Compose default `POSTGRES_PASSWORD`)

### Database Connection Issues

```bash
# Run from Atlas_Core/ (compose file path below is relative to that directory)
# Check if database is running
docker compose -f docker/docker-compose.yml ps

# View database logs
docker compose -f docker/docker-compose.yml logs postgres

# Restart database only
docker compose -f docker/docker-compose.yml restart postgres
```

### Schema Issues

```bash
# Run from Atlas_Core/
# Force recreate with fresh volumes
docker compose -f docker/docker-compose.yml down -v
docker compose -f docker/docker-compose.yml up -d
```

## File Locations

- **Models**: `internal/models/models.go`
- **Database Pool & Schema DDL**: `internal/database/db.go`
- **Configuration**: `internal/config/config.go`
- **API Handlers**: `internal/api/handlers/handler_http.go`, `handler_entity.go`, `handler_task.go`, `handler_object.go`, `handler_object_transfer.go`, `handler_query.go`
- **Application Entry Point**: `cmd/atlas_core/main.go`
- **Docker Config**: `docker/docker-compose.yml`

---

**Remember**: `EnsureTables()` drops and recreates everything on every startup. Edit `db.go` and the Go models, rebuild, restart — the database will match. No migrations, no drift, no stale columns.
