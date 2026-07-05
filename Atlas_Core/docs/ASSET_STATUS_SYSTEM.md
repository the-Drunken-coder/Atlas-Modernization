# Entity Status System

## Overview

ATLAS Core uses a unified entity model where assets, tracks, and geofeatures are all stored as entities in the `entities` table. Entity status and telemetry are tracked via the `components` field in the JSON blob and the `updated_at` timestamp.

The behaviour described here is implemented by:

- [`Entity` Go model](../internal/models/models.go)
- [Entity API handlers](../internal/api/)
- [Entity actions & validation](../internal/actions/)

## Entity Types

Entities are differentiated by their `type` and `subtype` columns:

| Type | Subtype Examples | Description |
| --- | --- | --- |
| `asset` | `drone`, `rover`, `camera`, `sensor` | Taskable agents that can receive commands |
| `track` | `person`, `vehicle`, `aircraft` | Observed entities detected by sensors |
| `geofeature` | `point`, `linestring`, `polygon` | Geographic features and zones |

## Entity Connectivity and Status

Entity connectivity is tracked via the `communications` component within the JSON blob:

```json
{
  "components": {
    "communications": {
      "link_state": "connected"
    }
  }
}
```

Valid `link_state` values:

- `connected` - Entity is actively communicating
- `disconnected` - Entity has cleanly disconnected
- `degraded` - Entity has intermittent connectivity
- `unknown` - Connection status is not determined

## Database Storage

Entities are stored in the disposable runtime `entities` table. On normal startup,
Atlas Core drops and recreates this schema from the DDL in `internal/database/db.go`;
do not treat existing rows as durable history.

```go
// Entity represents an entity in the system (asset, track, geofeature, etc.).
type Entity struct {
	EntityID  string          `json:"entity_id" db:"entity_id"`
	Type      string          `json:"type" db:"type"`
	Subtype   *string         `json:"subtype,omitempty" db:"subtype"`
	Alias     *string         `json:"alias,omitempty" db:"alias"`
	JSON      json.RawMessage `json:"-" db:"json"`
	CreatedAt time.Time       `json:"created_at" db:"created_at"`
	UpdatedAt time.Time       `json:"updated_at" db:"updated_at"`
	Version   int64           `json:"version" db:"version"`
}
```

## HTTP API

### Create Entity

```bash
POST /entities
Content-Type: application/json

{
  "entity_id": "asset-123",
  "entity_type": "asset",
  "subtype": "drone",
  "alias": "Raven-1",
  "components": {
    "telemetry": {
      "latitude": 40.7128,
      "longitude": -74.0060,
      "altitude_m": 120
    },
    "communications": {
      "link_state": "connected"
    }
  }
}
```

### Update Telemetry

```bash
PATCH /entities/{entity_id}/telemetry
Content-Type: application/json

{
  "latitude": 40.7128,
  "longitude": -74.0060,
  "altitude_m": 120,
  "speed_m_s": 8.2,
  "heading_deg": 165
}
```

### Entity Check-in

The check-in endpoint is the preferred way for agents/assets to regularly report in. It accepts telemetry, optional component updates, and an optional operational status string simultaneously, updates the heartbeat, and returns pending and acknowledged tasks for the asset (configurable via `status_filter`).

```bash
POST /entities/{entity_id}/checkin
Content-Type: application/json

{
  "latitude": 40.7128,
  "longitude": -74.0060,
  "altitude_m": 120,
  "components": {
    "communications": {
      "link_state": "connected"
    }
  }
}
```

**Connection status** belongs in `components.communications.link_state` (`connected`, `degraded`, `disconnected`, `unknown`).

**Operational status** (distinct from connection state) may be sent as a top-level `"status"` string; the handler maps it to `components.status.value` with a server-generated `last_update`. Prefer `components.communications.link_state` for connectivity and reserve top-level `status` for operational state when using the flat check-in shape.

You may also send a full `components` object (for example `communications.link_state`). Server-managed keys take precedence on conflict: `heartbeat` is always refreshed, and flat telemetry/status fields overwrite the corresponding component keys when both are present.

Response:

```json
{
  "entity": { "...": "full entity object with updated components" },
  "tasks": [ "...pending tasks for this entity" ],
  "task_count": 1,
  "task_limit": 10
}
```

Optional query parameters: `status_filter` (default `pending,acknowledged`), `limit` (1–20, default 10), `fields` (`minimal` for compact task payloads), `since` (RFC3339 timestamp to filter tasks).

### Get Entity

```bash
GET /entities/{entity_id}
```

## Telemetry Component

The `telemetry` component in the JSON blob tracks position and motion:

```json
{
  "components": {
    "telemetry": {
      "latitude": 40.7128,
      "longitude": -74.0060,
      "altitude_m": 120,
      "speed_m_s": 8.2,
      "heading_deg": 165
    }
  }
}
```

## Operational Guidance

- Create entities via `POST /entities` with required `entity_type` and optional `subtype`
- Update telemetry via `PATCH /entities/{entity_id}/telemetry` to refresh position data
- Use `POST /entities/{entity_id}/checkin` for regular asset reporting to update telemetry, status, and fetch pending tasks all at once
- The `updated_at` timestamp is automatically updated on any entity modification
- Use the `communications.link_state` component to track connection status

This unified entity model simplifies asset, track, and geofeature management while maintaining flexibility for different entity types.
