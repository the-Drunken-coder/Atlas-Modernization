# Atlas Change Feed Planning

Status: protocol feed envelope, Atlas Core websocket feed, and SDK consumption are implemented. Split out of [`../atlas-sdk/PLANNING.md`](../atlas-sdk/PLANNING.md) on 2026-06-12 so the feed can be specced, built, and tested as its own deliverable **before** the SDK exists. A first decision pass on 2026-06-12 settled the emission mechanism, event envelope, endpoint and auth, and initial subscription state (see "Decisions from the first open-questions pass"). A protocol implementation pass on 2026-06-12 authored the envelope, resource shapes, and client messages in `../../atlas_protocol/`. A Core implementation pass on 2026-06-12 added `/feed`, post-commit action hooks, in-process ordered fanout, and the simulation harness. The SDK implementation in `../../atlas_sdk/` now consumes the same feed contract, including selective subscriptions, protocol revision handshakes, gap recovery through `changed-since`, and ledger-style Node/browser tests.

The change feed is the push channel out of Atlas Core: an endpoint that streams change events to connected clients so they learn about writes without polling. The transport is **decided: websocket** — not webhooks (Core calling back URLs that clients register does not work for browser UIs or assets behind flaky links). The Atlas SDK is now the primary TypeScript consumer; the feed's first correctness consumer remains its Core simulation tests (see "Testing"), with SDK tests covering the same consumer contract from the client side.

## Decided constraints

Carried over from SDK planning, where they already survived review; these are not open:

- **In-process in Atlas Core for v1.** One deployable, no separate fanout service; the existing advisory write lock already serializes the versions the feed needs ([global write version decision](../design-decisions/2026-06-10-global-write-version-lock.md)).
- **Fat events.** Each event carries the event type, resource type, the global `version`, and the full serialized resource (or a tombstone for deletes) — effectively a streaming form of one `GET /queries/changed-since` row. Thin "something changed" notifications are rejected: they force follow-up GETs and reintroduce ordering races.
- **A version on every event**, so clients can detect gaps.
- **Deletes are events.** Tombstones carry the resource ID, resource type, and global version. A subscriber to a deleted resource hears about the deletion; it does not just go silent. (`changed-since` already returns tombstones from the deletions table, so clients that miss the live feed still evict deleted resources on recovery.)
- **Object content is never pushed.** Object *metadata* events flow like entity/task events; binary content is fetched lazily by clients.
- **Subscriptions are filters, not a query engine:** `all`; by resource ID; by resource type; and one relational filter, **tasks for entity X**, which must match *future* tasks (a server-side filter, not expressible as an ID list).
- **Task routing rule:** a task event is delivered to a relational subscriber if the task matched the filter **before or after** the change — on reassignment from asset A to asset B, A sees the task leave and B sees it arrive. `all` subscribers receive every task event regardless.
- **Live re-subscription:** subscribe/unsubscribe over an open connection, no reconnect required.

## Decisions from the first open-questions pass (2026-06-12)

- **Emission mechanism: in-process post-commit hook.** Core's write path hands each committed change to the feed hub directly, including before-and-after state — which the task-routing rule needs and which the other candidate mechanisms (Postgres LISTEN/NOTIFY, internally tailing `changed-since`) cannot provide without extra bookkeeping. The hub is responsible for emitting in global version order even though hooks fire after the advisory lock releases; the simulation harness exists to catch exactly this class of bug, and the `changed-since` backstop covers anything that slips past.
- **Event envelope: flat, one event per frame.** Every field in its own slot:

  ```json
  { "event": "update", "resource_type": "task", "id": "task-7", "version": 123, "resource": { "...": "full serialized task" } }
  ```

  `event` is `create`, `update`, or `delete`; `resource` carries the full serialized resource and is omitted on `delete` — the tombstone is the envelope itself. Subscribe/unsubscribe messages follow the same flat style (exact shapes still open, below).
- **Endpoint and auth: `/feed`, first-message auth.** The client connects, then its first frame carries the API key; the server closes the connection if the key is wrong or does not arrive within a timeout. Identical flow for browsers, Node, and the CLI (browsers cannot set custom headers on websockets), and no keys in URLs or access logs. While API auth is disabled — the current deployment — the auth frame is not required.
- **Initial subscription state: empty.** A fresh connection delivers nothing until the client subscribes; automatic mode sends subscribe-`all` as its first message after authenticating.
- **Protocol-owned feed messages.** The envelope and client messages are authored in CUE under `../../atlas_protocol/schema/feed.cue` and generated into JSON Schema plus Go artifacts. Subscribe/unsubscribe messages use flat frames: `{"action":"subscribe","filter":"all"}`, `{"action":"subscribe","filter":"id","resource_type":"task","id":"task-7"}`, `{"action":"subscribe","filter":"type","resource_type":"entity"}`, and `{"action":"subscribe","filter":"tasks_for_entity","entity_id":"asset-1"}`; unsubscribe uses the same fields with `action:"unsubscribe"`.
- **No subscription acknowledgements in v1.** Subscribe/unsubscribe frames are commands. Valid frames change the connection's filter set silently; malformed JSON, invalid filters, or wrong first-message auth close the websocket with a policy-violation status. The SDK can layer its own local command bookkeeping if it needs UI feedback.
- **Slow consumers are disconnected.** Each connection gets a bounded in-process send buffer (currently 256 events by default). If the buffer fills, Core closes the connection; the client recovers by reconnecting and calling `changed-since` from its last applied version.
- **Keepalive is websocket ping/pong.** Core sends pings every 30 seconds and closes dead connections through the websocket library's failed ping/read/write paths.
- **Burned version gaps are skipped after a short wait.** PostgreSQL sequence values are not transactional, so a failed write can consume a global version that will never produce a feed event. The hub waits briefly for ordinary post-commit hook reordering, then skips the missing version and emits later events. Clients already treat version gaps as a `changed-since` recovery trigger, so this preserves liveness without hiding the gap.
- **Protocol revision handshake.** After first-message auth succeeds (or immediately when auth is disabled), Core sends a server `hello` frame containing `protocol_revision`. This is not a subscription event and does not opt the client into any filters.
- **Simulation harness placement.** The v1 harness lives in `../../Atlas_Core/internal/feed/` and uses a faked Core ledger with the real feed hub. It publishes realistic entity/task/object traffic, deliberately publishes some events out of order, injects dropped connections and forced gaps, and audits subscribers against the ledger. This keeps feed correctness fast and deterministic; the SDK adds a sibling ledger-style harness around the generated TypeScript client and a fake Core/feed transport.

## What clients must do (consumption contract)

The feed only delivers correctness to cooperating clients. Any consumer — the SDK, the CLI's watch mode, a future Python port — must:

- Track its last applied version and apply events in version order, updating local state only when `event.version` is greater than what it holds. Tombstones count as versioned state, so a stale resource payload can never resurrect a newer delete.
- On a version gap in the stream: call `GET /queries/changed-since?since_version=N` to catch up. Recovery is event-driven, not timer-driven.
- On reconnect: one `changed-since` call from the last known version restores consistency.

These rules are the language-neutral half of the contract that makes a non-TypeScript client a port rather than a redesign. Their final normative home is a protocol-level document (see [`../atlas-protocol/PLANNING.md`](../atlas-protocol/PLANNING.md)); this plan is where they get worked out.

## Testing (the feed's first real consumer)

The feed is validated by simulation against ground truth, not just unit tests.

Spin up the system — real Core with Postgres, or a faked Core where that is faster — and run **multiple simulated assets and clients reading and writing concurrently over a simulated stretch of time**: a minute, an hour, a day of traffic. Entity creates, updates, and deletes; task lifecycle and reassignment; telemetry; object metadata changes. The simulation driver keeps its own ledger of every write it performed — that ledger is "reality."

At the end of the run, and at checkpoints during it, audit the feed against the ledger: did every subscriber receive every event its filters entitled it to, in version order, with correct payloads and tombstones, and with reassignments delivered to both the losing and gaining side? Missed events are failures. Duplicates are tolerable by contract (version-guarded application makes them harmless) but worth counting.

Fault injection belongs in the same harness: dropped connections mid-stream, forced version gaps, reconnects — asserting that the `changed-since` recovery path converges every client back to ground truth.

The same philosophy now extends to the SDK: attach an SDK instance to a feed-compatible simulation as one more subscriber and compare what the SDK *thinks* the world looks like against the ledger (see the SDK plan's "Testing" section). The current implementation uses a TypeScript fake Core/feed transport for the SDK harness so the same tests run in both Node and browser environments.

## Open questions

- **Exit criteria for in-process.** What concrete pain — fanout load, deployment coupling, operational isolation — would justify moving the feed out of Core's process.
