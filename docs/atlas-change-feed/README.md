# Atlas Change Feed

The change feed is the push channel out of Atlas Core: a websocket endpoint (`/feed`) that streams change events to connected clients so they learn about writes without polling. It is implemented across all three packages: the wire contract is authored in `atlas_protocol/schema/feed.cue`, Core serves the feed from `Atlas_Core/internal/feed/`, and the Atlas SDK ([`../atlas-sdk/README.md`](../atlas-sdk/README.md)) is the primary consumer.

This document records the design as built and the reasoning behind it. It began as a plan split out of the SDK plan (2026-06-12) so the feed could be specced, built, and simulation-tested **before** the SDK existed. The durable architectural choice is also recorded as a [design decision](../design-decisions/2026-06-12-change-feed-websocket-fat-events.md); this doc carries the full detail.

## Transport and placement

- **Websocket, not webhooks.** Core calling back URLs that clients register does not work for browser UIs or assets behind flaky links.
- **In-process in Atlas Core.** One deployable, no separate fanout service; the existing advisory write lock already serializes the versions the feed needs ([global write version decision](../design-decisions/2026-06-10-global-write-version-lock.md)). The exit criteria for moving the feed out of Core's process — fanout load, deployment coupling, operational isolation — are deliberately undefined until the pain is real (see "Open questions").

## Event contract

- **Fat events.** Each event carries the event type, resource type, the global `version`, and the full serialized resource (or a tombstone for deletes) — effectively a streaming form of one `GET /queries/changed-since` row. Thin "something changed" notifications were rejected: they force follow-up GETs and reintroduce ordering races.
- **Flat envelope, one event per frame.** Every field in its own slot:

  ```json
  { "event": "update", "resource_type": "task", "id": "task-7", "version": 123, "resource": { "...": "full serialized task" } }
  ```

  `event` is `create`, `update`, or `delete`; `resource` carries the full serialized resource and is omitted on `delete` — the tombstone is the envelope itself.
- **A version on every event**, so clients can detect gaps.
- **Deletes are events.** Tombstones carry the resource ID, resource type, and global version. Task tombstones also carry the last known `entity_id` when available so `tasks_for_entity` consumers can evict tasks after recovery. A subscriber to a deleted resource hears about the deletion; it does not just go silent. (`changed-since` also returns tombstones from the deletions table, so clients that miss the live feed still evict deleted resources on recovery.)
- **Object content is never pushed.** Object *metadata* events flow like entity/task events; binary content is fetched lazily by clients.
- **Protocol-owned shapes.** The envelope and client messages are authored in CUE (`atlas_protocol/schema/feed.cue`) and generated into JSON Schema, Go, and TypeScript artifacts, so the types Core emits and the types the SDK parses come from one source.

## How Core emits events

- **In-process post-commit hooks.** Core's write path hands each committed change to the feed hub directly, including before-and-after state — which the task-routing rule needs and which the rejected alternatives (Postgres LISTEN/NOTIFY, internally tailing `changed-since`) could not provide without extra bookkeeping. Events are emitted only for committed transactions.
- **Ordered fanout.** The hub delivers events in global version order even though hooks fire after the advisory lock releases; out-of-order arrivals are buffered until the missing version shows up.
- **Burned version gaps are skipped after a short wait.** PostgreSQL sequence values are not transactional, so a failed write (e.g. a duplicate-ID create returning 409) can consume a global version that will never produce a feed event. The hub waits briefly for ordinary post-commit hook reordering, then skips the missing version and emits later events. Clients already treat version gaps as a `changed-since` recovery trigger, so this preserves liveness without hiding the gap. (Found as a feed-freeze bug in review; the end-to-end regression test deliberately burns a version through a real 409.)
- **Slow consumers are disconnected.** Each connection gets a bounded in-process send buffer (256 events by default). If the buffer fills, Core closes the connection; the client recovers by reconnecting and calling `changed-since` from its last applied version.
- **Keepalive is websocket ping/pong.** Core sends pings every 30 seconds and closes dead connections through the websocket library's failed ping/read/write paths.

## Subscriptions

- **Filters, not a query engine:** `all`; by resource ID; by resource type; and one relational filter, **tasks for entity X**, which matches *future* tasks (a server-side filter, not expressible as an ID list).
- **Task routing rule:** a task event is delivered to a relational subscriber if the task matched the filter **before or after** the change — on reassignment from asset A to asset B, A sees the task leave and B sees it arrive. Task update events include `previous_entity_id` when known, and task delete events include the last known `entity_id` when known, so clients can preserve the same routing behavior during `changed-since` recovery. `all` subscribers receive every task event regardless.
- **Initial subscription state is empty.** A fresh connection delivers nothing until the client subscribes; automatic mode sends subscribe-`all` as its first message after authenticating.
- **Live re-subscription:** subscribe/unsubscribe over an open connection, no reconnect required. Messages use flat frames matching the event envelope style: `{"action":"subscribe","filter":"all"}`, `{"action":"subscribe","filter":"id","resource_type":"task","id":"task-7"}`, `{"action":"subscribe","filter":"type","resource_type":"entity"}`, `{"action":"subscribe","filter":"tasks_for_entity","entity_id":"asset-1"}`; unsubscribe uses the same fields with `action:"unsubscribe"`.
- **No subscription acknowledgements.** Subscribe/unsubscribe frames are commands. Valid frames change the connection's filter set silently; malformed JSON, invalid filters, or wrong first-message auth close the websocket with a policy-violation status. The SDK can layer local command bookkeeping if it needs UI feedback.

## Endpoint and auth

The endpoint is `/feed` with **first-message auth**: the client connects, then its first frame carries the API key; the server closes the connection if the key is wrong or does not arrive within a timeout. This gives browsers, Node, and the CLI one identical flow (browsers cannot set custom headers on websockets) and keeps keys out of URLs and access logs. While API auth is disabled — the current deployment — the auth frame is not required.

After auth succeeds (or immediately when auth is disabled), Core sends a server `hello` frame containing `protocol_revision` — the generated protocol revision stamp the SDK compares against its own generated types, failing loudly on mismatch. The same stamp is exposed over `GET /protocol/revision` (see the [protocol doc](../atlas-protocol/README.md)).

## What clients must do (consumption contract)

The feed only delivers correctness to cooperating clients. Any consumer — the SDK, the CLI's watch mode, a future Python port — must:

- Track its last applied version and apply events in version order, updating local state only when `event.version` is greater than what it holds. Tombstones count as versioned state, so a stale resource payload can never resurrect a newer delete.
- On a version gap in the stream: call `GET /queries/changed-since?since_version=N` to catch up. Recovery is event-driven, not timer-driven.
- On reconnect: one `changed-since` call from the last known version restores consistency.

These rules are the language-neutral half of the contract that makes a non-TypeScript client a port rather than a redesign; the shapes are authored in the protocol, and this document is the normative home of the behavioral rules.

## Testing

The feed is validated by simulation against ground truth, not just unit tests. The harness runs simulated assets and clients reading and writing concurrently while the simulation driver keeps a ledger of every write — that ledger is "reality." At the end of the run, and at checkpoints during it, the feed is audited against the ledger: every subscriber must receive every event its filters entitled it to, in version order, with correct payloads and tombstones, and with reassignments delivered to both the losing and gaining side. Missed events are failures; duplicates are tolerable by contract (version-guarded application makes them harmless) but worth counting. Fault injection lives in the same harness: dropped connections mid-stream, forced version gaps, reconnects — asserting that the `changed-since` recovery path converges every client back to ground truth.

Three layers implement this philosophy:

- `Atlas_Core/internal/feed/simulation_test.go` — a faked Core ledger driving the real feed hub: realistic entity/task/object traffic, deliberately out-of-order publishes, dropped connections, forced gaps, ledger audits. Fast and deterministic.
- `Atlas_Core/internal/api/handlers/handler_feed_integration_test.go` — the full chain against real Postgres: HTTP write → post-commit hook → hub → websocket client, including the burned-version regression (a real 409 burning a sequence value, with the feed expected to keep flowing).
- `atlas_sdk/test/` — a sibling ledger-style harness around the TypeScript client with a fake Core/feed transport, running identically in Node and browser.

## Open questions

- **Exit criteria for in-process.** What concrete pain — fanout load, deployment coupling, operational isolation — would justify moving the feed out of Core's process.
