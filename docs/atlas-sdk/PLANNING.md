# Atlas SDK Planning

Status: initial SDK implemented in `../../atlas_sdk/`: typed HTTP client, CLI entrypoint, polling sync cache, websocket feed transport, selective subscriptions, revision handshake, object-content LRU cache, and Node/browser test suites are in place. The package is still private in this repository; public npm publishing remains a later release step.

The Atlas SDK is the single client for Atlas Core. The goal is that **no service ever calls the API manually** — every UI, asset-side service, and tool talks to Atlas through the SDK or its bundled CLI. The one documented interim exception: non-TypeScript services without an SDK port may call the API directly (see "CLI and cross-language story"); the goal stands because the contract, not the package, is the source of truth. The SDK wraps the existing HTTP API. The one piece of new API work it depends on — the websocket change feed in Atlas Core — was planned separately in [`../atlas-change-feed/PLANNING.md`](../atlas-change-feed/PLANNING.md) and is now implemented before SDK consumption.

**Sole consumer:** the only user of Atlas and this SDK is its developer. Publishing to public npm is for convenience, not for external users — the package carries **no compatibility guarantees**. Breaking changes are preferred over compatibility shims (matching repo-wide policy in `AGENTS.md`), and all consumers upgrade in lockstep. To make lockstep safe, the SDK performs a cheap version handshake and fails loudly on SDK/API mismatch rather than degrading quietly — over HTTP at client startup in phases 1–2, and again at websocket connect once the feed transport exists (phase 3). The concrete revision token and where Core exposes it are open questions in the protocol plan ("Next Slice: TypeScript Outputs").

## Goals

- One TypeScript/JavaScript package that runs unmodified in browsers and Node ("isomorphic"): web-standard `fetch` and `WebSocket` only, no Node-only dependencies, tests run in both environments in CI.
- Identical function behavior whether the sync engine is running. Callers never branch on mode.
- Real-time data with minimal latency for UIs — no "reload the page" feel.
- Reduce API call volume by serving repeated reads from a continuously synced local cache.
- Usable beyond TypeScript via a bundled CLI and a documented, language-neutral sync contract (see "Cross-language story").

## Non-goals

- A polyglot runtime (sidecar/local server other languages talk to). If a Python SDK is needed later, it is a mechanical port of the documented contract, not shared machinery.
- Caching as an archive. The cache is a hot mirror of current state, never a history store.
- A speculative composite-function catalog. The extension point is designed now; functions are added when real use cases appear (none identified yet as of 2026-06-12).

## Architecture

Two components, not three modes:

1. **Typed HTTP client** — always present. Typed functions for every API endpoint: entity/task/object CRUD, task lifecycle (`acknowledge`/`complete`/`fail`/`status`), telemetry, check-in, object upload/download, queries.
2. **Sync engine** — optional. Local cache + change feed consumer + reconciliation loop.

The user-described modes are constructor presets over these components:

```ts
new AtlasClient({ baseUrl, apiKey });                    // manual: no sync engine
new AtlasClient({ baseUrl, apiKey, sync: "all" });       // automatic: subscribe to everything
new AtlasClient({ baseUrl, apiKey, sync: "selective" }); // hybrid: explicit subscriptions
```

Same cache, same feed consumer, same reconciliation logic in all presets. "Selective" adds `client.subscribe(filter)` calls (filters are the subscription primitives defined in the [change feed plan](../atlas-change-feed/PLANNING.md)).

### Unified read surface

Every read function resolves the same way, invisibly to the caller:

1. Sync engine running **and healthy** and the resource is covered by an active subscription → serve from cache.
2. Otherwise (cache miss, engine degraded, engine not running, or caller passed `{ fresh: true }`) → call the API; merge the response into the cache on the way back.

Rules that make this safe:

- **Always async.** Every read returns a Promise even when served from cache, so the two paths are indistinguishable to callers except in speed.
- **Degraded fallthrough.** The engine tracks connection state and its last confirmed global version. If the feed is disconnected or a version gap is unreconciled, the engine marks itself degraded and reads fall through to the API until it catches up. The cache only answers when it is entitled to.
- **`{ fresh: true }`** forces an API call for data-critical reads regardless of engine state.
- **Plain returns + debug hooks.** Functions return plain data (no metadata envelope). Observability comes from `client.on('read', info)` events (source: cache/api, resource version, cache age) and `client.sync.status()`.

### Watch API

`client.entities.watch(id, callback)` (and equivalents per resource type, plus collection-level watches) fires when the cached resource changes. This is the real-time path for UIs: the change-feed event arrives and the UI reacts immediately, with no polling loop. It is the same cache and the same surface — not a separate layer.

### Writes and read-your-writes

Write functions always call the API. The API returns the created/updated resource with its new version; the SDK applies it to the cache immediately, guarded by `version > cachedVersion` so a racing feed event cannot regress state. A client that creates a task and immediately reads it sees it.

The SDK surfaces the API's optimistic concurrency (ETag/`If-Match`) as a typed `ConflictError` plus an opt-in retry-with-refetch helper, rather than hiding it.

## Change feed (planned and built separately)

The websocket change feed — event shapes, tombstones, subscription primitives, task-routing rules, delivery mechanics, and its own testing plan — lives in [`../atlas-change-feed/PLANNING.md`](../atlas-change-feed/PLANNING.md). The feed was built and simulation-tested before the SDK, so the sync engine's websocket transport consumes a finished, demonstrated endpoint.

What the SDK relies on from that contract: fat events carrying the full serialized resource and a global version, tombstone events for deletes, object metadata (never content) on the feed, and the four subscription filters (`all`, by resource ID, by resource type, tasks-for-entity).

## Reconciliation (replaces the original 20-second hard refresh)

The consistency mechanism is `GET /queries/changed-since` with the global version cursor, not periodic full re-pulls. The endpoint returns creates, updates, and delete tombstones after the requested version. The gap-detection and reconnect rules below are the SDK's implementation of the consumption contract in the change feed plan.

- **Gap detection:** the cache tracks its last applied version N. If an event arrives with a version that skips past expected values, the SDK immediately calls `changed-since?since_version=N` to catch up. Recovery is event-driven, not timer-driven.
- **Reconnect:** after any websocket reconnect, one `changed-since` call from the last known version restores consistency; the engine is degraded (reads fall through to the API) until it completes.
- **Version-guarded application:** reconciliation applies returned events in ascending version order and updates cache entries only when `event.version > cachedVersion`. A tombstone is a versioned cache entry, so an older resource payload cannot restore a resource after a newer delete has been applied.
- **Safety-net poll:** a lazy periodic `changed-since` call (interval on the order of minutes, configurable) as a backstop; a no-change response is nearly free. This is a backstop, not the mechanism.
- **Hydration:** `GET /queries/full` on engine start. At expected scale (10–20 assets, low hundreds of tracks from ADS-B ingest, never thousands) this is one or a few pages and subscribe-`all` in a browser tab is trivially fine.

## Objects

An object is two things, treated differently:

- **Metadata** (small JSON: name, type, version, references) — flows over the change feed and lives in the cache like entities and tasks.
- **Content** (the blob, e.g. heat map data) — fetched on first use and cached keyed by `(object_id, version)`. A metadata event with a newer version makes the stored blob stale by construction; the next read re-downloads. Content is re-fetched exactly once per actual change. The content cache has a size cap with least-recently-used eviction so a long-running browser tab does not accumulate blobs without bound.

## Types: generated, not hand-written

Resource types come from `atlas_protocol` generated artifacts. The SDK must not hand-write resource shapes — protocol changes propagate by regeneration, keeping the SDK in lockstep. SDK-specific types (client config, sync status, event/debug shapes) are authored in the SDK.

TypeScript generation does not exist in `atlas_protocol` yet — the generator currently emits JSON Schema and Go validators only. Adding TypeScript outputs is the one prerequisite protocol slice for phase 1; it is planned in [`../atlas-protocol/PLANNING.md`](../atlas-protocol/PLANNING.md) ("Next Slice: TypeScript Outputs").

Update from 2026-06-12: TypeScript generation now exists in `../../atlas_protocol/generated/typescript/index.ts`, and the generated `ATLAS_PROTOCOL_REVISION` constant is the SDK/API mismatch token. Core exposes the same stamp via `GET /protocol/revision` and the websocket feed `hello` frame. The SDK imports those generated types directly rather than copying or hand-writing resource shapes.

## CLI and cross-language story

A TypeScript npm package cannot be imported by Python. The goal of being usable beyond TypeScript is met by:

1. **A CLI bundled with the SDK** (`atlas entities get <id>`, `atlas tasks create <json>`, JSON output). Any language can subprocess it. The CLI is also the first local testing tool and exercises the whole typed client. For *pushed* data (a Python asset service receiving its tasks), one-shot subprocess calls are not enough, so the CLI includes a long-running streaming mode — `atlas watch --subscribe <filter> --follow` — that runs the sync engine and emits one JSON line per change event for the parent process to read.
2. **A language-neutral contract:** resource shapes are already JSON Schema; the feed event shape, subscription messages, gap-detection rule, and changed-since reconciliation algorithm are specified in the [change feed plan](../atlas-change-feed/PLANNING.md) and authored in the protocol CUE schema, so a future Python SDK is a port, not a redesign.

Python services in the interim use the CLI or direct API calls; that does not violate the spirit of "everything through the SDK" because the contract, not the package, is the source of truth.

## Auth

Atlas Core has optional API-key auth (`X-API-Key` or `Authorization: Bearer`); it is **currently disabled** in this deployment. The SDK takes `apiKey` in client config and attaches it to every HTTP request and the websocket handshake. Keys are **never embedded in the package or its builds** — the host application supplies the key at runtime. The web UI keeps the key in app-managed client-side state for the current local-only deployment; services read it from their own config/env. This is not cookie-based auth and does not try to model browser sessions. A single shared key with full write access is acceptable only under the current posture: one user, local deployment. Per-client identity, scoped/read-only keys, and tasking audit are prerequisites for any internet-facing deployment (see "Known gaps"). No token refresh machinery until the API grows a richer auth model.

## Composite functions

Higher-level functions (multiple endpoints, or one endpoint with opinionated defaults) live in the SDK so the API layer stays thin. Design rule: composites only orchestrate public client methods — never private internals — so they stay testable and the basic layer remains the single source of API behavior. No concrete composites are specified yet; candidates will come from real usage (likely first: task-an-asset flows built on the command catalog).

## Build phases

1. **Typed HTTP client + CLI** (manual mode complete). Generated types, auth, ETag/conflict handling, errors. No API changes required.
2. **Sync engine over `changed-since` polling** (automatic mode works end-to-end). Cache, unified read resolution, watch API, hydration, reconciliation, read-your-writes, object content invalidation. Still no API changes — the poll interval is the latency floor.
3. **Websocket transport in the SDK** over the Atlas Core change feed (built and tested separately before SDK transport work). Latency drops from poll-interval to push. Same engine, new transport; SDK consumers upgrade transparently.
4. **Selective subscriptions** (hybrid mode): `client.subscribe(filter)` over the feed's subscription primitives, degraded fallthrough for uncovered resources.

Phases 1–2 have no dependency on new API work, so the SDK is not structurally blocked on the websocket; in this implementation, the feed landed first and the SDK websocket transport consumes it.

## Testing

Same philosophy as the [change feed plan](../atlas-change-feed/PLANNING.md): simulation against ground truth. A harness runs multiple simulated assets and clients through realistic traffic over a simulated minute, hour, or day — entity writes and deletes, task lifecycle and reassignment, telemetry, object changes — while the simulation driver keeps a ledger of every write: "reality." At checkpoints and at the end of the run, compare what the SDK *thinks* the world looks like against that reality: cache contents match the ledger, watch callbacks fired for every relevant change, reads served from cache return what a fresh API call would, and fault injection (dropped feed connections, forced version gaps) converges back to truth through reconciliation. Ideally this reuses the feed plan's harness, with the SDK attached as one more subscriber whose internal state is auditable.

Alongside the simulation: ordinary unit/integration tests run in both browser and Node environments in CI, per the isomorphic goal.

## Known gaps (explicitly deferred)

- **Offline/flaky-link writes from assets.** Writes always call the API; there is no SDK queueing or retry outbox for an asset that calls e.g., `completeTask()` while its link is down. Out of scope for v1 — asset software must handle write failures itself until a later phase designs durable retries. Add an SDK outbox only after client identity and idempotency keys exist, so retries can be attributed and safely de-duplicated.
- **Auth hardening.** Single shared API key with full write access, stored in app-managed client-side state for the web UI, is acceptable only for the current single-user local deployment. Per-client identity, scoped/read-only keys, and an audit trail of who tasked an asset are prerequisites before anything is internet-facing.

## Open questions

- Final npm package name/scope.
- First composite functions (deferred until real use cases exist).

(Feed-side open questions — endpoint shape, wire formats, slow-consumer policy, harness placement — live in the [change feed plan](../atlas-change-feed/PLANNING.md).)
