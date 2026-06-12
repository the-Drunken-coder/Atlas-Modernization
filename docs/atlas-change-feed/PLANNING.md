# Atlas Change Feed Planning

Status: planned, not yet implemented. Split out of [`../atlas-sdk/PLANNING.md`](../atlas-sdk/PLANNING.md) on 2026-06-12 so the feed can be specced, built, and tested as its own deliverable **before** the SDK exists. This document is deliberately light on wire-format and implementation detail — the open questions at the bottom are waiting to be answered, not forgotten.

The change feed is the push channel out of Atlas Core: an endpoint that streams change events to connected clients so they learn about writes without polling. The transport is **decided: websocket** — not webhooks (Core calling back URLs that clients register does not work for browser UIs or assets behind flaky links). The Atlas SDK is the eventual primary consumer; until it exists, the feed's real exercising consumer is its tests (see "Testing").

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

The same philosophy extends to the SDK later: attach an SDK instance to the simulation as one more subscriber and compare what the SDK *thinks* the world looks like against the ledger (see the SDK plan's "Testing" section). Ideally both reuse one harness.

## Open questions

- **How the feed learns about committed writes.** Candidates: an in-process post-commit hook in the actions layer; Postgres LISTEN/NOTIFY; the feed internally tailing `changed-since`. Hard constraint regardless of mechanism: events are emitted only for committed transactions, in version order.
- **Endpoint and handshake.** The path (e.g. `/feed`), and how the API key rides the handshake **from a browser** — the browser WebSocket API cannot set custom headers, so it has to be a query parameter, a first-message auth exchange, or a cookie.
- **Wire formats.** Exact JSON shapes for the event envelope and the subscribe/unsubscribe messages; whether subscriptions are acknowledged; error behavior for invalid filters.
- **Where the envelope is authored.** Leaning: protocol CUE, so the Go types Core emits and the TypeScript types the SDK parses are generated from one source, like resource shapes.
- **Initial subscription state.** Does a fresh connection start subscribed to `all` or to nothing?
- **Slow consumers.** Per-connection buffer cap, then disconnect and let the client recover via `changed-since`? Something gentler?
- **Keepalive.** Ping/pong interval and dead-connection detection.
- **Version handshake.** Whether connect-time SDK/API compatibility checking uses the protocol revision stamp (see protocol plan).
- **Simulation harness placement and shape.** Where it lives (Core integration tests vs. a top-level testing package), how simulated time is driven (compressed real time vs. a controlled clock), which fault cases are in scope for v1, and whether the same harness later drives SDK testing.
- **Exit criteria for in-process.** What concrete pain — fanout load, deployment coupling, operational isolation — would justify moving the feed out of Core's process.
