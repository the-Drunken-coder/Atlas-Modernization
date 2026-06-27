# Entities JSON Guide

Atlas Core keeps entity records as single JSON blobs so integrations can add or remove components without migrating columns. Each entity has a `type`, optional `subtype`, and optional `alias` stored as database columns (for efficient querying and indexing), while the JSON blob contains the components map. The `entity_id` is stored as a table column (primary key), along with `type` (required, indexed), `subtype` (optional, indexed), and `alias` (optional, indexed). The JSON blob in the `json` column contains only the components and any additional metadata. Downstream consumers can read each component when needed.

> **Implementation reference:** Go structs live in `internal/models/models.go`; component validation in `internal/actions/component_validation.go`; schema DDL in `internal/database/db.go`.

## Database Structure

- **entity_id** (VARCHAR(50), primary key): Unique identifier for the entity
- **type** (VARCHAR(50), NOT NULL, indexed): Entity type (e.g., "asset", "track", "geofeature")
- **subtype** (VARCHAR(50), nullable, indexed): Entity subtype for granular classification (e.g., "rover", "drone", "camera", "sensor" for assets; "person", "vehicle", "aircraft" for tracks; "polygon", "point", "linestring" for geofeatures)
- **alias** (VARCHAR(255), nullable, indexed): Human-readable name for the entity
- **json** (JSONB, NOT NULL, default `{}`): Contains components and metadata (does NOT include `type`, `subtype`, or `alias`)
- **created_at** (TIMESTAMPTZ, NOT NULL): Timestamp when entity was created
- **updated_at** (TIMESTAMPTZ, NOT NULL): Timestamp when entity was last updated
- **version** (BIGINT, NOT NULL): Monotonic change version used for sync ordering and `metadata.version`

## Example Payload (JSON Blob Structure)

The JSON blob stored in the `json` column should NOT include `type`, `subtype`, or `alias` (these are database columns):

```json
{
  "components": {
    "telemetry": {
      "latitude": 40.7128,
      "longitude": -74.0060,
      "altitude_m": 120,
      "speed_m_s": 8.2,
      "heading_deg": 165
    },
    "geometry": {
      "type": "Point",
      "coordinates": [-74.0060, 40.7128]
    },
    "task_catalog": {
      "supported_tasks": ["move_to_location", "survey_grid"]
    },
    "media_refs": [
      { "object_id": "obj-123", "role": "camera_feed" },
      { "object_id": "obj-456", "role": "thumbnail" },
      { "object_id": "obj-789", "role": "heatmap_data" }
    ],
    "mil_view": {
      "classification": "friendly",
      "last_seen": "2026-05-29T10:05:00Z"
    },
    "health": {
      "battery_percent": 76
    },
    "sensor_refs": [
      {
        "sensor_id": "radar-1",
        "type": "radar",
        "horizontal_fov": 90,
        "vertical_fov": 60,
        "horizontal_orientation": 45,
        "vertical_orientation": 10
      }
    ],
    "communications": {
      "link_state": "connected"
    },
    "task_queue": {
      "current_task_id": "task-abc",
      "queued_task_ids": ["task-def", "task-ghi"]
    },
    "status": {
      "value": "active",
      "last_update": "2026-05-29T10:05:00Z"
    },
    "heartbeat": {
      "last_seen": "2026-05-29T10:05:00Z"
    },
    "custom_weather": {
      "wind_speed": 12,
      "gusts": 18
    }
  },
  "published_at": "2026-05-29T10:00:00Z"
}
```

**Note:** When creating or updating entities via the API, `entity_type`, `subtype`, and `alias` should be provided as separate parameters/fields, not within the JSON blob. The JSON blob only contains `components` and any additional metadata fields. The database column for type is `type`; the HTTP API field is `entity_type`.

## API vs Storage

| Concern | HTTP API | Database / blob |
| --- | --- | --- |
| Entity type | `entity_type` on POST/PATCH | Column `type` |
| Metadata | `metadata.created_at`, `metadata.updated_at`, `metadata.version` | Columns `created_at`, `updated_at`, `version` |
| Extra blob fields | `extra` map on POST/PATCH | Keys in `json` outside `components` |
| Response | `entity_type` | — |

### Additional entity endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `PATCH` | `/entities/{entity_id}/telemetry` | Flat telemetry update |
| `POST` | `/entities/{entity_id}/checkin` | Telemetry, components, heartbeat, fetch tasks |
| `GET` | `/entities/alias/{alias}` | Lookup by alias |
| `GET` | `/entities/{entity_id}/tasks` | Paginated tasks for entity |
| `GET` | `/entities/{entity_id}/objects` | Paginated objects referencing entity |

### Extra Fields

The JSON blob may contain fields outside `components`:

- **published_at** (ISO 8601 string, optional): Timestamp indicating when this entity data was originally published or observed. Useful for recording the source timestamp independently of `updated_at`.

## Component Catalog

- **telemetry**: Position/motion data. Units are meters, meters-per-second, and degrees (WGS84). Fields: `latitude`, `longitude`, `altitude_m`, `speed_m_s`, `heading_deg`.
- **geometry**: Spatial footprint for geofeatures. Supports GeoJSON geometries and the Atlas circle Feature convention (see [Geometry Formats](#geometry-formats) below).
- **task_catalog**: Lists `supported_tasks` identifiers so controllers know which work packages the asset can accept.
- **media_refs**: Array of references to objects in MinIO. Each entry has `object_id` (required) and `role` (required). Valid roles: `camera_feed`, `thumbnail`, `heatmap_data`.
- **mil_view**: Tacsight classification plus the last observed timestamp. `classification` must be one of: `friendly`, `hostile`, `neutral`, `unknown`, `civilian`.
- **health**: Vitals such as `battery_percent` (0–100).
- **sensor_refs**: Array of upstream sensors with canonical FOV/orientation metadata. See [Sensor Refs Fields](#sensor-refs-fields) below.
- **communications**: Network link hints. `link_state` must be one of: `connected`, `disconnected`, `degraded`, `unknown`.
- **task_queue**: Current and queued work items.
  - `current_task_id` (string \| null): must be `null` or a non-blank string (reject empty or whitespace-only values; no additional canonical-format validation is performed).
  - `queued_task_ids` (array of strings): each element must be non-blank (reject empty or whitespace-only entries; no canonical-format validation).
- **status**: Operational status metadata. When present, must be an object with non-empty string `value`; optional `last_update` (RFC3339).
- **heartbeat**: Heartbeat timing metadata. When present, must be an object with required RFC3339 `last_seen`.
- **custom_\* components**: Namespaced extensions (prefixed with `custom_`) contain integration-defined payloads.

Keep the blob as the canonical entity record; stable fields can be extracted into relational columns once they no longer change frequently. The `type`, `subtype`, and `alias` fields have already been promoted to database columns for better query performance and indexing.

## Geometry Formats

The `geometry` component is validated through the generated Atlas Protocol validators used by `internal/actions/component_validation.go`.

### GeoJSON Format

Standard GeoJSON `Point`, `LineString`, and `Polygon` geometries with `type` and `coordinates`:

```json
{
  "type": "Point",
  "coordinates": [-74.0060, 40.7128]
}
```

Coordinates use `[longitude, latitude]` order.

### Circle Feature Format

Circular geofences use a strict GeoJSON Feature with Point geometry and Atlas circle properties:

```json
{
  "type": "Feature",
  "geometry": {
    "type": "Point",
    "coordinates": [-74.0060, 40.7128]
  },
  "properties": {
    "shape": "circle",
    "radius_m": 500
  }
}
```

The circle Feature properties are strict: `shape` must be `"circle"` and `radius_m` must be a positive finite number.

## Sensor Refs Fields

The validation layer accepts canonical sensor FOV and orientation field names:

| Field | Description |
| --- | --- |
| `horizontal_fov` | Horizontal field-of-view (degrees) |
| `vertical_fov` | Vertical field-of-view (degrees) |
| `horizontal_orientation` | Yaw / horizontal orientation (degrees) |
| `vertical_orientation` | Pitch / vertical orientation (degrees) |

Legacy aliases such as `fov_horizontal` and `orientation_yaw` are not part of Atlas Protocol. All numeric fields must be finite.

## Component Applicability Matrix

Not all components are meaningful for every entity type. The table below shows typical applicability:

| Component | Asset | Track | Geofeature |
| --- | --- | --- | --- |
| telemetry | ✔ | ✔ | — |
| geometry | — | — | ✔ |
| task_catalog | ✔ | — | — |
| media_refs | ✔ | ✔ | ✔ |
| mil_view | ✔ | ✔ | ✔ |
| health | ✔ | — | — |
| sensor_refs | ✔ | ✔ | — |
| communications | ✔ | — | — |
| task_queue | ✔ | — | — |
| status | ✔ | ✔ | ✔ |
| heartbeat | ✔ | — | — |
| custom_* | ✔ | ✔ | ✔ |

> The server does not enforce per-type restrictions — any known component key is accepted on any entity type. This table documents the intended usage patterns.

## Validation Constraints

Validation is performed in `internal/actions/component_validation.go` and related files. Key constraints:

| Field / Component | Constraint |
| --- | --- |
| `telemetry.latitude` | −90 to 90 |
| `telemetry.longitude` | −180 to 180 |
| `telemetry.altitude_m` | Any finite number |
| `telemetry.speed_m_s` | ≥ 0 |
| `telemetry.heading_deg` | 0 to < 360 |
| `health.battery_percent` | 0 to 100 |
| `mil_view.classification` | `friendly` / `hostile` / `neutral` / `unknown` / `civilian` |
| `mil_view.last_seen` | RFC 3339 timestamp |
| `communications.link_state` | `connected` / `disconnected` / `degraded` / `unknown` |
| `task_queue.current_task_id` | `null` or a non-blank string (reject empty / whitespace-only; no canonical-format validation) |
| `task_queue.queued_task_ids[]` | Each entry: non-blank string (reject empty / whitespace-only; no canonical-format validation) |
| `media_refs[].object_id` | Required, non-empty string |
| `media_refs[].role` | `camera_feed` / `thumbnail` / `heatmap_data` |
| `sensor_refs[].sensor_id` | Required, non-empty string |
| `sensor_refs[].type` | Required, non-empty string |
| Geometry coordinates | Lat −90–90, Lon −180–180; max 10,000 points per geometry |
| Circle Feature `properties.radius_m` | > 0 |
| Entity ID pattern | Max 50 chars; `^[a-zA-Z0-9][a-zA-Z0-9._-]*$` |
| Request body (create/update) | Max 1 MB |
| Telemetry update body | Max 256 KB |
| Checkin body | Max 256 KB |
| Component keys | Must be in the known set or prefixed with `custom_` |
