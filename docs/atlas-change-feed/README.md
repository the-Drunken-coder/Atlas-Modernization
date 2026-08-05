# Atlas Change Feed

The change feed is the push channel out of Atlas Core: a websocket endpoint (`/feed`) that streams change events to connected clients so they learn about writes without polling. It is implemented across all three packages: the wire contract is authored in `atlas_protocol/schema/jsonschema/atlas.schema.json`, Core serves the feed from `atlas_core/internal/feed/`, and the Atlas SDK ([`../atlas-sdk/README.md`](../atlas-sdk/README.md)) is the primary consumer.

This document is the behavioral contract. The durable rationale lives in the [design decision](../design-decisions/2026-06-12-change-feed-websocket-fat-events.md).

## Why this exists

The feed is a latency and traffic optimization over the same cursor contract that powers `changed-since`, not a second source of truth. Atlas keeps it because the operator UI needs a live view of asset, task, and object metadata changes while work is happening, and approximating that with few-second polling would create materially more API traffic as long-running UI and SDK clients are added.

If those product requirements go away, a poll-only `changed-since` client is the simpler valid design. Until then, websocket push is the fast path and `changed-since` remains the recovery and fallback path.

## Transport and placement

- Websocket endpoint: `/feed`.
- Served in-process by Atlas Core.
- Auth can happen during the websocket upgrade with an API key or a trusted browser session. Clients that cannot set websocket headers can still use first-message API-key auth when API auth is enabled.
- Server `hello` frame carries `protocol_revision`, matching `GET /protocol/revision`.
- Each connection has a bounded send buffer; slow consumers are disconnected and recover through `changed-since`.
- Keepalive uses websocket ping/pong.

## Event contract

- Events are fat: each frame carries event type, resource type, global `version`, resource ID, and the full serialized resource when present.
- Deletes are versioned events without a `resource` payload. Task delete events may carry `entity_id` so `tasks_for_entity` consumers can evict correctly.
- Object metadata flows over the feed; object content is never pushed.
- Shapes are authored in JSON Schema, structurally checked against the authored Go API, and generated into TypeScript and Go validators.
- The envelope is flat:

  ```json
  { "event": "update", "resource_type": "task", "id": "task-7", "version": 123, "resource": { "...": "full serialized task" } }
  ```

`event` is `create`, `update`, or `delete`; `resource` is omitted on `delete`.

## How Core emits events

- Every versioned write transaction locks `atlas_change_clock` before any per-object advisory lock, upload-intent row, or resource row. It later increments the already-locked clock, writes the resource mutation, and appends the complete validated event to `atlas_change_events` before commit.
- Object deletion fences live separately in the compact `object_deletion_fences` table, one row per object ID. Feed history is never used as permanent storage-integrity state.
- A rollback removes both the resource mutation and its version increment, so committed versions are contiguous and there are no burned-version gaps to compensate for.
- PostgreSQL `NOTIFY` only wakes the dispatcher. The dispatcher reads committed rows from the durable log in version order and publishes them through the in-memory subscription hub.
- `GET /queries/changed-since` pages over that same durable log with one global cursor, so websocket delivery and recovery share one source of truth.
- Recovery events are retained for seven days. Core prunes older rows hourly and stores the earliest accepted cursor in `atlas_change_clock.min_retained_version`. An older cursor receives HTTP `410` with `CURSOR_EXPIRED`; clients must perform paginated full hydration and resume recovery from that snapshot version.
- Changed-since pages default to 100 events and are always bounded by both event count and 8 MiB of serialized event JSON. A single event is still returned when it exceeds the byte budget so the cursor can make progress.

## Subscriptions

- Supported filters: `all`, resource `id`, resource `type`, and `tasks_for_entity`.
- Initial subscription state is empty; clients must subscribe before receiving events.
- Subscribe/unsubscribe messages are live commands over the existing connection.
- Valid commands change filters silently; malformed frames or invalid filters close the websocket with policy violation.
- A `tasks_for_entity` subscriber receives task events when the task matched the entity before or after the change. Reassignment therefore notifies both the losing and gaining entity subscriptions.

## What clients must do (consumption contract)

The feed only delivers correctness to cooperating clients. Any consumer — the SDK, the CLI's watch mode, a future Python port — must:

- On initialization, consume every `GET /queries/full` continuation page while retaining the response's repeated `version` as the pre-hydration baseline. Do not advance the global cursor from hydrated resources' individual versions; drain `changed-since` from the baseline before declaring synchronization current.
- Track its last applied version and apply events in version order, updating local state only when `event.version` is greater than what it holds. Delete events count as versioned state, so a stale resource payload can never resurrect a newer delete.
- On a version gap in the stream: call `GET /queries/changed-since?since_version=N` to catch up. Recovery is event-driven, not timer-driven.
- On reconnect: drain `changed-since` from the last known version. Apply and persist each page before requesting the next; remain degraded until the final page succeeds. If Core returns `CURSOR_EXPIRED`, perform full hydration and resume from its version watermark.

The current subscription protocol has no server acknowledgment. A client that disables safety polling can therefore miss an event in the narrow connect/subscribe/recover window. This is tracked in [`../problems/2026-08-05-feed-subscription-readiness.md`](../problems/2026-08-05-feed-subscription-readiness.md); until it is resolved, reconnect recovery is eventually consistent only when safety polling remains enabled.

These rules are the language-neutral half of the contract that makes a non-TypeScript client a port rather than a redesign; the shapes are authored in the protocol, and this document is the normative home of the behavioral rules.

## Testing

Three layers cover the feed from routing through end-to-end recovery:

- `atlas_core/internal/feed/simulation_test.go` — focused subscription-routing and slow-consumer tests for the fanout hub.
- `atlas_core/internal/api/handlers/handler_feed_integration_test.go` — the full chain against real Postgres: HTTP write → transactional event row → durable dispatcher → websocket client, including proof that rejected writes do not advance the change clock.
- `atlas_sdk/test/` — a sibling ledger-style harness around the TypeScript client with a fake Core/feed transport, running identically in Node and browser.
