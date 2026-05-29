# Database Workflow - ATLAS Core System

## Overview

The ATLAS Core System uses a **migration-free workflow**. Database tables are automatically created via `CREATE TABLE IF NOT EXISTS` statements executed by the Go application during startup. The system **never uses migration tools like Alembic or golang-migrate** — instead, it generates DDL directly in `internal/database/db.go` and executes it via the pgx connection pool.

This approach prioritizes development speed and simplicity over versioned schema migrations, making it ideal for rapid prototyping and development environments.

## Database Architecture

- **Database**: PostgreSQL 15+ with TimescaleDB extension
- **Driver**: pgx v5 (`github.com/jackc/pgx/v5/pgxpool`)
- **Models**: Located in `internal/models/models.go`
- **Schema Creation**: Automatic via `EnsureTables()` in `internal/database/db.go` (no migrations)

## Database Schema

Atlas Core persists operational data in PostgreSQL. Go structs in `internal/models/models.go` define the canonical schema; the DDL in `internal/database/db.go` matches them.

### Core Tables

#### `entities`

- Primary key: `entity_id` (`VARCHAR(50)`)
- Columns: `type` (NOT NULL, indexed), `subtype` (nullable, indexed), `alias` (nullable, indexed)
- Stores JSONB blob with components and metadata (telemetry, geometry, task_catalog, media_refs, etc.)
- Represents assets, tracks, geofeatures, and other map entities

#### `tasks`

- Primary key: `task_id` (`VARCHAR(50)`)
- Columns: `status` (NOT NULL, indexed, default: `pending`), `entity_id` (nullable, indexed, foreign key → `entities.entity_id` ON DELETE SET NULL)
- Stores JSONB blob with task specification, parameters, and progress
- Status values: `pending`, `acknowledged`, `completed`, `failed`, `cancelled`

#### `objects`

- Primary key: `object_id` (`VARCHAR(50)`)
- Promoted columns: `path` (unique, indexed), `content_type` (indexed), `type` (indexed)
- Stores JSONB blob with additional metadata (bucket, size_bytes, usage_hints, referenced_by, checksum, expiry_time, etc.)
- Catalogs binary objects (media files, models, etc.) referenced by entities and tasks via MinIO or other object storage

#### `deletions`

- Primary key: `id` (`BIGSERIAL`)
- Columns: `resource_type` (`VARCHAR(20)`, indexed), `resource_id` (`VARCHAR(50)`), `deleted_at` (`TIMESTAMPTZ`, indexed)
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

# 3. Rebuild and restart services — new *tables* are created on startup; existing tables are not altered
go build -o atlas_core ./cmd/atlas_core
docker compose -f docker/docker-compose.yml up -d
```

**Note**: `EnsureTables()` runs `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS`. That creates missing tables but **does not add columns** to tables that already exist. For new columns on an existing database, run an explicit `ALTER TABLE` (or a one-off reviewed SQL script) against PostgreSQL, then keep `db.go` in sync so new environments get the full definition.

### 2. What Happens on Startup

When the application starts (via `go run ./cmd/atlas_core` or as a Docker container):

1. **Database Connection**: pgx pool connects to PostgreSQL
2. **Table Creation**: `EnsureTables()` executes `CREATE TABLE IF NOT EXISTS` for entities, tasks, objects, and deletions, and creates indexes with `CREATE INDEX IF NOT EXISTS`
3. **Health Check**: Executes `pool.Ping()` to verify database connectivity
4. **Service Ready**: Application begins serving traffic

This automatic table creation ensures the database schema is always present without manual intervention.

### How Tables Are Created

The `internal/database/db.go` file contains `EnsureTables()` which:

1. Executes raw SQL `CREATE TABLE IF NOT EXISTS` statements for each table
2. Creates indexes with `CREATE INDEX IF NOT EXISTS`
3. Runs inside the application process via the pgx connection pool

This means:

- **No migration files needed** — DDL in `db.go` is the single source of truth
- **Safe to run multiple times** — Uses `IF NOT EXISTS`
- **Automatic on startup** — Runs every time the application starts

### 3. Example: Adding a New Column

1. **Existing databases:** apply a manual SQL schema change (no migration framework in-repo):

```sql
ALTER TABLE entities ADD COLUMN IF NOT EXISTS priority INTEGER;
```

1. **Keep `EnsureTables()` aligned** so fresh installs get the column inside `CREATE TABLE`:

```go
// In internal/database/db.go, inside EnsureTables():
_, err := db.Pool.Exec(ctx, `
    CREATE TABLE IF NOT EXISTS entities (
        entity_id VARCHAR(50) PRIMARY KEY,
        type VARCHAR(50) NOT NULL,
        subtype VARCHAR(50),
        alias VARCHAR(255),
        priority INTEGER,
        json JSONB NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
`)
```

1. Update the Go struct in `internal/models/models.go`:

```go
type Entity struct {
    // ... existing fields ...
    Priority  *int  `json:"priority,omitempty" db:"priority"`
}
```

1. Rebuild and restart:

```bash
# Run from Atlas_Core/
go build -o atlas_core ./cmd/atlas_core && docker compose -f docker/docker-compose.yml up -d
```

### 4. Example: Adding a New Table

```go
// In internal/database/db.go, add to EnsureTables():
_, err = db.Pool.Exec(ctx, `
    CREATE TABLE IF NOT EXISTS audit_logs (
        id SERIAL PRIMARY KEY,
        entity_id VARCHAR(50) REFERENCES entities(entity_id),
        action VARCHAR(100) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
`)
if err != nil {
    return fmt.Errorf("failed to create audit_logs table: %w", err)
}
```

Then add the corresponding Go struct in `internal/models/models.go` and rebuild.

## Development Guidelines

### ✅ **Advantages of the Migration-Free Approach**

- **Simplicity**: No migration files to manage or version control
- **Speed**: Instant schema updates just by editing DDL and models
- **Consistency**: Go structs + DDL in `db.go` are the single source of truth
- **Safety**: `CREATE TABLE IF NOT EXISTS` prevents errors on restart

### ⚠️ **Important Notes**

- **Schema changes on restart**: Changes to DDL require an application restart to take effect
- **Development data**: Use disposable databases when testing breaking changes (e.g., column renames)
- **Column modifications**: `CREATE TABLE IF NOT EXISTS` only creates missing tables; it doesn't modify existing ones
- **For production**: This repository does not use migration tooling. Use reviewed, versioned SQL changes and explicit manual schema-change procedures instead.

### 🔄 **Daily Workflow**

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

- ✅ Creating new tables
- ✅ Creating indexes and constraints
- ✅ Idempotent execution (safe to run repeatedly)

### What It Doesn't Handle

- ❌ Renaming columns on existing tables: `CREATE TABLE IF NOT EXISTS` does not re-apply the table definition to an existing table, so it will not “rename by adding” a column — use `ALTER TABLE ... RENAME COLUMN` (or equivalent manual SQL)
- ❌ Changing column types (requires manual ALTER TABLE)
- ❌ Removing columns (old columns remain in database)
- ❌ Data migrations or transformations
- ❌ Adding columns to existing tables (CREATE TABLE IF NOT EXISTS skips existing tables)

### When You Need Manual Intervention

If you need to:

- Rename a column: Write manual SQL to rename it
- Change a column type: Write manual ALTER TABLE statement
- Remove old columns: Write manual DROP COLUMN statement
- Migrate existing data: Apply a one-off, reviewed SQL/data backfill (no migration framework)

Execute manual SQL via:

```bash
# Run from Atlas_Core/. Use the Compose *service* name
# (here: postgres) — not a specific container name — so it survives container renames.
docker compose -f docker/docker-compose.yml exec -T postgres psql -U atlas -d atlas_core << EOF
ALTER TABLE entities RENAME COLUMN old_name TO new_name;
EOF
```

## Production Considerations

For production deployments with existing data, this migration-free approach has limitations. Use manual, versioned SQL changes and explicit rollback plans rather than migration tools.

- **Manual schema changes**: For breaking changes, write and test SQL scripts manually
- **Database backups**: Always backup before schema changes
- **Downtime**: Some schema changes may require brief downtime

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

**Remember**: This migration-free approach keeps fresh installs simple: `EnsureTables()` creates missing tables for new databases. For **existing** databases, schema changes are **not** applied automatically—use a reviewed `ALTER TABLE` or one-off SQL, then update `db.go` and the Go models so new environments stay consistent.
