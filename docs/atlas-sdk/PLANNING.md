# Atlas SDK Planning

Status: planned, not yet implemented. The package will live at `atlas_sdk/` in this repository and be published to public npm under a scoped name (bare `atlas` is taken on npm; final name TBD, e.g. `@the-drunken-coder/atlas-sdk`).

The Atlas SDK is the single client for Atlas Core. The goal is that **no service ever calls the API manually** — every UI, asset-side service, and tool talks to Atlas through the SDK. The SDK wraps the existing HTTP API, and this plan also defines the one piece of new API work it depends on: a websocket change feed in Atlas Core.

**Sole consumer:** the only user of Atlas and this SDK is its developer. Publishing to public npm is for convenience, not for external users — the package carries **no compatibility guarantees**. Breaking changes are preferred over compatibility shims (matching repo-wide policy in `AGENTS.md`), and all consumers upgrade in lockstep. To make lockstep safe, the SDK performs a cheap version handshake on connect and fails loudly on SDK/API mismatch rather than degrading quietly.

## Goals

- One TypeScript/JavaScript package that runs unmodified in browsers and Node ("isomorphic"): web-standard `fetch` and `WebSocket` only, no Node-only dependencies, tests run in both environments in CI.
- Identical function behavior whether or not the sync engine is running. Callers never branch on mode.
- Real-time data with minimal latency for UIs — no "reload the page" feel.
- Reduce API call volume by serving repeated reads from a continuously synced local cache.
- Usable beyond TypeScript via a bundled CLI and a documented, language-neutral sync contract (see "Cross-language story").

## Non-goals

- A polyglot runtime (sidecar/local server other languages talk to). If a Python SDK is needed later, it is a mechanical port of the documented contract, not shared machinery.
- Caching as an archive. The cache is a hot mirror of current state, never a history store.
- A speculative composite-function catalog. The extension point is designed now; functions are added when real use cases appear (none identified yet as of 2026-06-12).

## Architecture

Two components, not three modes:

1. **Typed HTTP client** — always present. Typed functions for every API endpoint: entity/task/object CRUD, task lifecycle (`acknowledge`/`complete`/`fail`/`status`), telemetry, checkin, object upload/download, queries.
2. **Sync engine** — optional. Local cache + change feed consumer + reconciliation loop.

The user-described modes are constructor presets over these components:

```ts
new AtlasClient({ baseUrl, apiKey });                    // manual: no sync engine
new AtlasClient({ baseUrl, apiKey, sync: "all" });       // automatic: subscribe to everything
new AtlasClient({ baseUrl, apiKey, sync: "selective" }); // hybrid: explicit subscriptions
```

Same cache, same feed consumer, same reconciliation logic in all presets. "Selective" adds `client.subscribe(...)` calls (see "Subscription primitives").

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

## Change feed contract (new Atlas Core work)

A websocket endpoint in Atlas Core pushing change events. Design constraints, all leaning on the existing global write version (`docs/design-decisions/2026-06-10-global-write-version-lock.md`):

- **Fat events:** each event carries the event type, resource type, the global `version`, and the full serialized resource (or a tombstone for deletes) — effectively a streaming form of the `GET /queries/changed-since` response, one resource per event. Thin "something changed" notifications are rejected: they force follow-up GETs and reintroduce ordering races.
- **Version on every event** enables client-side gap detection (below).
- **Deletes flow to subscribers** as tombstone events. A subscriber to a deleted track hears about the deletion; it does not just go silent.
- **Object content is never pushed.** Object *metadata* events flow like entity/task events; the binary content is fetched lazily by clients (see "Objects").

### Subscription primitives

Kept deliberately small — filters, not a query engine:

- `all` — everything (automatic mode).
- By resource ID — e.g. an asset subscribes to itself, or to a track it is following.
- By resource type — e.g. all entities.
- **Tasks for entity X** — the one relational filter, required for "asset subscribes to itself and gets new tasks pushed." It must match *future* tasks, so it is a server-side filter, not expressible as an ID list.

Task routing rule: the feed determines the target from the task's entity assignment (`entity_id`). A task event is delivered to a relational subscriber if the task matched the filter **before or after** the change — so when a task is reassigned from asset A to asset B, A sees the update (the task leaving it) and B sees it arrive. `all` subscribers receive every task creation, update, and deletion regardless.

Subscriptions can change over a live connection (subscribe/unsubscribe messages) without reconnecting.

## Reconciliation (replaces the original 20-second hard refresh)

The consistency mechanism is `GET /queries/changed-since` with the global version cursor, not periodic full re-pulls:

- **Gap detection:** the cache tracks its last applied version N. If an event arrives with a version that skips past expected values, the SDK immediately calls `changed-since?since_version=N` to catch up. Recovery is event-driven, not timer-driven.
- **Reconnect:** after any websocket reconnect, one `changed-since` call from the last known version restores consistency; the engine is degraded (reads fall through to the API) until it completes.
- **Safety-net poll:** a lazy periodic `changed-since` call (interval on the order of minutes, configurable) as a backstop; a no-change response is nearly free. This is a backstop, not the mechanism.
- **Hydration:** `GET /queries/full` on engine start. At expected scale (10–20 assets, low hundreds of tracks from ADS-B ingest, never thousands) this is one or a few pages and subscribe-`all` in a browser tab is trivially fine.

## Objects

An object is two things, treated differently:

- **Metadata** (small JSON: name, type, version, references) — flows over the change feed and lives in the cache like entities and tasks.
- **Content** (the blob, e.g. heat map data) — fetched on first use and cached keyed by `(object_id, version)`. A metadata event with a newer version makes the stored blob stale by construction; the next read re-downloads. Content is re-fetched exactly once per actual change. The content cache has a size cap with least-recently-used eviction so a long-running browser tab does not accumulate blobs without bound.

## Types: generated, not hand-written

Resource types come from `atlas_protocol` generated artifacts (JSON Schema today; TypeScript types are already a planned protocol output per `docs/atlas-protocol/PLANNING.md`). The SDK must not hand-write resource shapes — protocol changes propagate by regeneration, keeping the SDK in lockstep. SDK-specific types (client config, sync status, event/debug shapes) are authored in the SDK.

## CLI and cross-language story

A TypeScript npm package cannot be imported by Python. The goal behind "usable from a variety of languages" is met by:

1. **A CLI bundled with the SDK** (`atlas entities get <id>`, `atlas tasks create ...`, JSON output). Any language can subprocess it. The CLI is also the first local testing tool and exercises the whole typed client. For *pushed* data (a Python asset service receiving its tasks), one-shot subprocess calls are not enough, so the CLI includes a long-running streaming mode — `atlas watch --subscribe <filter> --follow` — that runs the sync engine and emits one JSON line per change event for the parent process to read.
2. **A language-neutral contract:** resource shapes are already JSON Schema; this plan adds a protocol-level document specifying the feed event shape, subscription messages, gap-detection rule, and changed-since reconciliation algorithm, so a future Python SDK is a port, not a redesign.

Python services in the interim use the CLI or direct API calls; that does not violate the spirit of "everything through the SDK" because the contract, not the package, is the source of truth.

## Auth

Atlas Core has optional API-key auth (`X-API-Key` or `Authorization: Bearer`); it is **currently disabled** in this deployment. The SDK takes `apiKey` in client config and attaches it to every HTTP request and the websocket handshake. Keys are **never embedded in the package or its builds** — the host application supplies the key at runtime (the web UI keeps it in browser-local storage such as a cookie; services read it from their own config/env). A single shared key with full write access is acceptable only under the current posture: one user, local deployment. Per-client identity, scoped/read-only keys, and tasking audit are prerequisites for any internet-facing deployment (see "Known gaps"). No token refresh machinery until the API grows a richer auth model.

## Composite functions

Higher-level functions (multiple endpoints, or one endpoint with opinionated defaults) live in the SDK so the API layer stays thin. Design rule: composites only orchestrate public client methods — never private internals — so they stay testable and the basic layer remains the single source of API behavior. No concrete composites are specified yet; candidates will come from real usage (likely first: task-an-asset flows built on the command catalog).

## Build phases

1. **Typed HTTP client + CLI** (manual mode complete). Generated types, auth, ETag/conflict handling, errors. No API changes required.
2. **Sync engine over `changed-since` polling** (automatic mode works end-to-end). Cache, unified read resolution, watch API, hydration, reconciliation, read-your-writes, object content invalidation. Still no API changes — the poll interval is the latency floor.
3. **Websocket change feed in Atlas Core + WS transport in the SDK.** Latency drops from poll-interval to push. Same engine, new transport; SDK consumers upgrade transparently.
4. **Selective subscriptions** (hybrid mode): subscription primitives server-side, `client.subscribe(...)` client-side, degraded fallthrough for uncovered resources.

Phases 1–2 have no dependency on new API work, so the SDK is never blocked on the websocket.

## Known gaps (explicitly deferred)

- **Offline/flaky-link writes from assets.** Writes always call the API; there is no queueing or retry (outbox) for an asset that calls e.g. `completeTask()` while its link is down. Out of scope for v1 — asset software must handle write failures itself until a later phase designs this. It is the largest known gap for the asset-side use case and is deferred deliberately, not forgotten.
- **Auth hardening.** Single shared API key with full write access, stored client-side, is acceptable only for the current single-user local deployment. Per-client identity, scoped/read-only keys, and an audit trail of who tasked an asset are prerequisites before anything is internet-facing.

## Open questions

- Final npm package name/scope.
- First composite functions (deferred until real use cases exist).
- Whether the websocket lives in Atlas Core's process permanently or eventually moves to a dedicated feed service. Starting in-process in Core: one deployable, and the advisory write lock already serializes the versions the feed needs.
