# Database Structure Examples

This directory contains JSON example files for database entities, tasks, and objects supported by Atlas Core. Examples are organized by database table and can be used as templates or reference implementations.

## Directory Structure

```text
docs/database-structure/examples/
├── entities/          # Entity examples (stored in `entities` table)
│   ├── asset-entity-example.json
│   ├── track-entity-example.json
│   ├── geofeature-point-example.json
│   ├── geofeature-linestring-example.json
│   └── geofeature-polygon-example.json
├── tasks/             # Task examples (stored in `tasks` table)
│   └── task-example.json
├── objects/           # Object examples (stored in `objects` table)
│   └── object-example.json
└── README.md          # This file
```

## Available Examples

### Entity Examples (`entities/`)

Entities are stored in the `entities` table and represent things that appear on the map:

- **asset-entity-example.json**: Example asset entity (taskable agents like drones, rovers, etc.)
- **track-entity-example.json**: Example track entity (observed entities detected by sensors)
- **geofeature-point-example.json**: Example point geofeature (single coordinate)
- **geofeature-linestring-example.json**: Example linestring geofeature (route/path)
- **geofeature-polygon-example.json**: Example polygon geofeature (area/zone)

**Important:** The JSON examples show only the contents of the `json` column. Promoted fields — values stored as dedicated database columns — are **not** included in these JSON blobs. When creating entities via the API, provide promoted fields as separate request parameters.

**Promoted fields by table:**

- **Entities**: `entity_id`, `entity_type` (API) / `type` (column), `subtype`, `alias` are columns — do **not** put them in the JSON blob.
- **Tasks**: `task_id`, `status`, `entity_id` are columns — do **not** put them in the JSON blob.
- **Objects**: `object_id`, `path`, `content_type`, `type` are columns — do **not** put them in the JSON blob.

**API vs storage:** HTTP create/update uses `entity_type` in the request body; the database column is `type`. API responses expose `entity_type`, with timestamps under `metadata.created_at` / `metadata.updated_at`.

### Task Examples (`tasks/`)

Tasks are stored in the `tasks` table and represent work items dispatched to assets:

- **task-example.json**: Example task with command, parameters, and progress tracking (blob-only fields; no promoted `task_id` / `status` / timestamps)

### Object Examples (`objects/`)

Objects are stored in the `objects` table and represent binary files in MinIO:

- **object-example.json**: Example object metadata with references and usage hints

## How to Use

1. Navigate to the appropriate table folder (`entities/`, `tasks/`, or `objects/`)
2. Copy the relevant example JSON file
3. Modify the values to match your use case
4. Use as a reference when creating new entities, tasks, or objects
5. Validate JSON syntax before submitting to the API

## Example Structure

All examples follow the structure defined in the main database documentation:
- **entities.md**: Documents the entity JSON structure and component catalog
- **tasks.md**: Documents the task JSON structure and lifecycle
- **objects.md**: Documents the object JSON structure and metadata

## Notes

- We aim to keep example JSON files parseable; please open an issue if you find invalid files
- Timestamps use ISO 8601 format (UTC)
- Coordinate arrays use [longitude, latitude] format (GeoJSON standard)
- Custom components are prefixed with `custom_` for namespacing
- Required fields are always present; optional fields may be omitted
- **Promoted fields are database columns, not part of the JSON structure** (see note above for complete list per table)
