# Atlas Change Feed

The change feed is the push channel out of Atlas Core: a websocket endpoint (`/feed`) that streams change events to connected clients so they learn about writes without polling. It is implemented across all three packages: the wire contract is authored in `atlas_protocol/schema/jsonschema/atlas.schema.json`, Core serves the feed from `Atlas_Core/internal/feed/`, and the Atlas SDK ([`../atlas-sdk/README.md`](../atlas-sdk/README.md)) is the primary consumer.

This document is the behavioral contract. The durable rationale lives in the [design decision](../design-decisions/2026-06-12-change-feed-websocket-fat-events.md).

## Transport and placement

- Websocket endpoint: `/feed`.
- Served in-process by Atlas Core.
- First-message auth when API auth is enabled, so browsers, Node, and CLI clients use the same flow.
- Server `hello` frame carries `protocol_revision`, matching `GET /protocol/revision`.
- Each connection has a bounded send buffer; slow consumers are disconnected and recover through `changed-since`.
- Keepalive uses websocket ping/pong.

## Event contract

- Events are fat: each frame carries event type, resource type, global `version`, resource ID, and the full serialized resource when present.
- Deletes are tombstones. Task delete tombstones may carry `entity_id` so `tasks_for_entity` consumers can evict correctly.
- Object metadata flows over the feed; object content is never pushed.
- Shapes are authored in JSON Schema and generated into Go and TypeScript.
- The envelope is flat:

  ```json
  { "event": "update", "resource_type": "task", "id": "task-7", "version": 123, "resource": { "...": "full serialized task" } }
  ```

`event` is `create`, `update`, or `delete`; `resource` is omitted on `delete`.

## How Core emits events

- Write paths publish only after transaction commit.
- The hub buffers out-of-order post-commit arrivals and fanouts in global version order.
- A burned version, such as a failed create that consumed a sequence value, is skipped after a short wait so later events are not blocked forever.
- Clients treat any version gap as a recovery trigger, so skipped versions preserve liveness without hiding the gap.

## Subscriptions

- Supported filters: `all`, resource `id`, resource `type`, and `tasks_for_entity`.
- Initial subscription state is empty; clients must subscribe before receiving events.
- Subscribe/unsubscribe messages are live commands over the existing connection.
- Valid commands change filters silently; malformed frames or invalid filters close the websocket with policy violation.
- A `tasks_for_entity` subscriber receives task events when the task matched the entity before or after the change. Reassignment therefore notifies both the losing and gaining entity subscriptions.

## What clients must do (consumption contract)

The feed only delivers correctness to cooperating clients. Any consumer — the SDK, the CLI's watch mode, a future Python port — must:

- Track its last applied version and apply events in version order, updating local state only when `event.version` is greater than what it holds. Tombstones count as versioned state, so a stale resource payload can never resurrect a newer delete.
- On a version gap in the stream: call `GET /queries/changed-since?since_version=N` to catch up. Recovery is event-driven, not timer-driven.
- On reconnect: one `changed-since` call from the last known version restores consistency.

These rules are the language-neutral half of the contract that makes a non-TypeScript client a port rather than a redesign; the shapes are authored in the protocol, and this document is the normative home of the behavioral rules.

## Testing

The feed is validated by simulation against ground truth, not just unit tests. The harness keeps a ledger of every write and audits that subscribers receive every entitled event in version order. Fault injection covers dropped connections, forced gaps, reconnects, and convergence through `changed-since`.

Three layers implement this philosophy:

- `Atlas_Core/internal/feed/simulation_test.go` — a faked Core ledger driving the real feed hub: realistic entity/task/object traffic, deliberately out-of-order publishes, dropped connections, forced gaps, ledger audits. Fast and deterministic.
- `Atlas_Core/internal/api/handlers/handler_feed_integration_test.go` — the full chain against real Postgres: HTTP write → post-commit hook → hub → websocket client, including the burned-version regression (a real 409 burning a sequence value, with the feed expected to keep flowing).
- `atlas_sdk/test/` — a sibling ledger-style harness around the TypeScript client with a fake Core/feed transport, running identically in Node and browser.
