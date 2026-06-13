# Atlas SDK

The Atlas SDK (`atlas_sdk/`) is the single client for Atlas Core: a TypeScript/JavaScript package with a typed HTTP client, an optional sync engine (local cache + change feed consumer + reconciliation), a bundled `atlas` CLI, and Node/browser test suites. Public npm publishing is a convenience release step for this greenfield repo, not a compatibility promise.

The SDK is the preferred client path: UI code, asset-side services, and tools should generally talk to Atlas through the SDK or its bundled CLI rather than hand-writing API calls. Direct API use remains acceptable for tooling and non-TypeScript services without an SDK port (see "CLI and cross-language story"), but it is not the recommended default. The one piece of new API work the SDK depends on — the websocket change feed in Atlas Core — was designed and built separately, before the SDK ([change feed doc](../atlas-change-feed/README.md)).

**Sole consumer:** the only user of Atlas and this SDK is its developer. Publishing to public npm is for convenience, not for external users — the package carries **no compatibility guarantees**. Breaking changes are preferred over compatibility shims (matching repo-wide policy in `AGENTS.md`), and all consumers upgrade in lockstep. To make lockstep safe, the SDK performs a cheap version handshake and fails loudly on SDK/API mismatch rather than degrading quietly — over HTTP at client startup and again at websocket connect. The revision token is the generated `ATLAS_PROTOCOL_REVISION`; Core exposes it through `GET /protocol/revision` and the feed `hello` frame.

## Design goals

- One TypeScript/JavaScript package that runs unmodified in browsers and Node ("isomorphic"): web-standard `fetch` and `WebSocket` only, no Node-only dependencies, tests run in both environments in CI.
- Identical function behavior whether the sync engine is running. Callers never branch on mode.
- Real-time data with minimal latency for UIs — no "reload the page" feel.
- Reduce API call volume by serving repeated reads from a continuously synced local cache.
- Usable beyond TypeScript via a bundled CLI and a documented, language-neutral sync contract (see "CLI and cross-language story").

## Non-goals

- A polyglot runtime (sidecar/local server other languages talk to). If a Python SDK is needed later, it is a mechanical port of the documented contract, not shared machinery.
- Caching as an archive. The cache is a hot mirror of current state, never a history store.
- A speculative composite-function catalog. The extension point is designed; functions are added when real use cases appear (none identified yet as of 2026-06-12).

## Architecture

Two components, not three modes:

1. **Typed HTTP client** — always present. The implemented surface covers entity/task/object CRUD, object content download, optimistic-concurrency errors, protocol handshake checks, and cache-aware reads. Task lifecycle helpers, telemetry, check-in, object upload, and general query helpers are still direct API calls until they are added to the SDK.
2. **Sync engine** — optional. Local cache + change feed consumer + reconciliation loop.

The user-facing modes are constructor presets over these components:

```ts
new AtlasClient({ baseUrl, apiKey });                    // manual: no sync engine
new AtlasClient({ baseUrl, apiKey, sync: "all" });       // automatic: subscribe to everything
new AtlasClient({ baseUrl, apiKey, sync: "selective" }); // hybrid: explicit subscriptions
```

Same cache, same feed consumer, same reconciliation logic in all presets. "Selective" adds `client.subscribe(filter)` calls (filters are the subscription primitives defined in the [change feed doc](../atlas-change-feed/README.md)).

### Unified read surface

Every read function resolves the same way, invisibly to the caller:

1. Sync engine running **and healthy** and the resource is covered by an active subscription → serve from cache.
2. Otherwise (cache miss, engine degraded, engine not running, or caller passed `{ fresh: true }`) → call the API; merge the response into the cache on the way back.

Rules that make this safe:

- **Always async.** Every read returns a Promise even when served from cache, so the two paths are indistinguishable to callers except in speed.
- **Degraded fallthrough.** The engine tracks connection state and its last confirmed global version. If the feed is disconnected or a version gap is unreconciled, the engine marks itself degraded and reads fall through to the API until it catches up. The cache only answers when it is entitled to.
- **`{ fresh: true }`** forces an API call for data-critical reads regardless of engine state.
- **Plain returns + sync status.** Functions return plain data (no metadata envelope). Observability currently comes from `client.sync.status()`; read-source debug hooks are deferred until a real caller needs them.

### Watch API

`client.entities.watch(id, callback)` (and equivalents per resource type, plus collection-level watches) fires when the cached resource changes. This is the real-time path for UIs: the change-feed event arrives and the UI reacts immediately, with no polling loop. It is the same cache and the same surface — not a separate layer.

Watcher callbacks receive protocol feed events for server-published changes. They can also receive SDK-local events that are not wire feed frames: `recovered` when `changed-since` reconciliation applies a live resource row, and `local_delete` when a successful local DELETE removes a resource from the cache before Core's versioned tombstone arrives.

### Writes and read-your-writes

Write functions always call the API. The API returns the created/updated resource with its new version; the SDK applies it to the cache immediately, guarded by `version > cachedVersion` so a racing feed event cannot regress state. A client that creates a task and immediately reads it sees it.

The SDK surfaces the API's optimistic concurrency (ETag/`If-Match`) as a typed `ConflictError`, rather than hiding it. Callers that want retry behavior refetch and resubmit explicitly for now; no shared retry helper exists yet.

## Change feed consumption

The websocket change feed — event shapes, tombstones, subscription primitives, task-routing rules, delivery mechanics, and its testing approach — is documented in the [change feed doc](../atlas-change-feed/README.md). The feed was built and simulation-tested before the SDK, so the sync engine's websocket transport consumes a finished, demonstrated endpoint.

What the SDK relies on from that contract: fat events carrying the full serialized resource and a global version, tombstone events for deletes, object metadata (never content) on the feed, and the four subscription filters (`all`, by resource ID, by resource type, tasks-for-entity).

## Reconciliation (replaces the original 20-second hard refresh)

The consistency mechanism is `GET /queries/changed-since` with the global version cursor, not periodic full re-pulls. The endpoint returns creates, updates, and delete tombstones after the requested version. The gap-detection and reconnect rules below are the SDK's implementation of the consumption contract in the change feed doc.

- **Gap detection:** the cache tracks its last applied version N. If an event arrives with a version that skips past expected values, the SDK immediately calls `changed-since?since_version=N` to catch up. Recovery is event-driven, not timer-driven.
- **Reconnect:** after any websocket reconnect, one `changed-since` call from the last known version restores consistency; the engine is degraded (reads fall through to the API) until it completes.
- **Version-guarded application:** reconciliation applies returned events in ascending version order and updates cache entries only when `event.version > cachedVersion`. A tombstone is a versioned cache entry, so an older resource payload cannot restore a resource after a newer delete has been applied.
- **Safety-net poll:** a lazy periodic `changed-since` call (interval on the order of minutes, configurable) as a backstop; a no-change response is nearly free. This is a backstop, not the mechanism.
- **Hydration:** `GET /queries/full` on engine start. At expected scale (10–20 assets, low hundreds of tracks from ADS-B ingest, never thousands) this is one or a few pages and subscribe-`all` in a browser tab is trivially fine.

## Objects

An object is two things, treated differently:

- **Metadata** (small JSON: name, type, version, references) — flows over the change feed and lives in the cache like entities and tasks.
- **Content** (the blob, e.g. heat map data) — fetched on first use and cached keyed by `(object_id, version)`. A metadata event with a newer version makes the stored blob stale by construction; the next read re-downloads. The content cache has a size cap with least-recently-used eviction so a long-running browser tab does not accumulate blobs without bound. Because Core has no versioned download endpoint, the SDK verifies metadata after each download and retries once if the version moved mid-flight — correctness over an extra metadata round-trip.

Object `referenced_by` entries are normalized to the protocol `ObjectReference` shape: only `entity_id` and `task_id` are emitted. Extra keys in stored object metadata are intentionally not part of the public API response.

## Types: generated, not hand-written

Resource types come from `atlas_protocol` generated artifacts: the SDK imports `atlas_protocol/generated/typescript/index.ts` directly (by path) rather than copying or hand-writing resource shapes, so protocol changes propagate by regeneration and the SDK stays in lockstep with Core. The generated `ATLAS_PROTOCOL_REVISION` constant is the SDK/API mismatch token (see the [protocol doc](../atlas-protocol/README.md)). SDK-specific types (client config, sync status, event/debug shapes) are authored in the SDK.

The TypeScript compiler intentionally uses the repository root as `rootDir` so the built package contains both `dist/atlas_sdk/src/*` and the generated `dist/atlas_protocol/generated/typescript/*` module that the SDK imports. Package metadata points `main`, `exports`, and `types` at the built SDK entrypoint.

## CLI and cross-language story

A TypeScript npm package cannot be imported by Python. The goal of being usable beyond TypeScript is met by:

1. **A CLI bundled with the SDK** (`atlas entities get <id>`, `atlas tasks create <json>`, JSON output). Any language can subprocess it. The CLI is also the first local testing tool and exercises the whole typed client. For *pushed* data (a Python asset service receiving its tasks), one-shot subprocess calls are not enough, so the CLI includes a long-running streaming mode — `atlas watch --subscribe <filter> --follow` — that runs the sync engine and emits one JSON line per change event for the parent process to read. CI smoke-tests the compiled binary so the published entrypoint always runs.
2. **A language-neutral contract:** resource shapes are JSON Schema; the feed event shape, subscription messages, gap-detection rule, and changed-since reconciliation algorithm are specified in the [change feed doc](../atlas-change-feed/README.md) and authored in the protocol CUE schema, so a future Python SDK is a port, not a redesign.

Python services in the interim may use the CLI or direct API calls; direct calls are a special-case escape hatch, not the default client path. The contract, not the package, remains the source of truth.

## Auth

Atlas Core has optional API-key auth (`X-API-Key` or `Authorization: Bearer`); it is **currently disabled** in this deployment. The SDK takes `apiKey` in client config and attaches it to every HTTP request and the websocket handshake. Keys are **never embedded in the package or its builds** — the host application supplies the key at runtime. The web UI keeps the key in app-managed client-side state for the current local-only deployment; services read it from their own config/env. This is not cookie-based auth and does not try to model browser sessions. A single shared key with full write access is acceptable only under the current posture: one user, local deployment. Per-client identity, scoped/read-only keys, and tasking audit are prerequisites for any internet-facing deployment (see "Known gaps"). No token refresh machinery until the API grows a richer auth model.

## Composite functions

Higher-level functions (multiple endpoints, or one endpoint with opinionated defaults) live in the SDK so the API layer stays thin. Design rule: composites only orchestrate public client methods — never private internals — so they stay testable and the basic layer remains the single source of API behavior. No concrete composites exist yet; candidates will come from real usage (likely first: task-an-asset flows built on the command catalog).

## Build history

The SDK was planned in four phases and built in that order on 2026-06-12, after the change feed landed first:

1. **Typed HTTP client + CLI** (manual mode): generated types, auth, ETag/conflict handling, errors. No API changes required.
2. **Sync engine over `changed-since` polling** (automatic mode): cache, unified read resolution, watch API, hydration, reconciliation, read-your-writes, object content invalidation.
3. **Websocket transport** over the Atlas Core change feed: latency drops from poll-interval to push; same engine, new transport.
4. **Selective subscriptions** (hybrid mode): `client.subscribe(filter)` over the feed's subscription primitives, degraded fallthrough for uncovered resources.

The phasing meant the SDK was never structurally blocked on new API work — phases 1–2 ran against the API as it already existed.

## Testing

Same philosophy as the [change feed doc](../atlas-change-feed/README.md): simulation against ground truth. The test harness (`atlas_sdk/test/`) drives a fake Core/feed transport through realistic mixed traffic — entity, task, and object writes, reassignments, dropped feed events, forced version gaps — while keeping a ledger of every write. At checkpoints and at the end of the run, the SDK's view is compared to that reality: cache contents match the ledger, watch callbacks fired for every relevant change, and fault injection converges back to truth through reconciliation. The same suite runs in both Node and a real browser (Playwright) in CI, per the isomorphic goal, alongside ordinary unit tests and a CLI binary smoke test.

## Known gaps (explicitly deferred)

- **Offline/flaky-link writes from assets.** Writes always call the API; there is no SDK queueing or retry outbox for an asset that calls e.g., `completeTask()` while its link is down. Out of scope for v1 — asset software must handle write failures itself until a later phase designs durable retries. Add an SDK outbox only after client identity and idempotency keys exist, so retries can be attributed and safely de-duplicated.
- **Auth hardening.** Single shared API key with full write access, stored in app-managed client-side state for the web UI, is acceptable only for the current single-user local deployment. Per-client identity, scoped/read-only keys, and an audit trail of who tasked an asset are prerequisites before anything is internet-facing.

## Remaining release questions

- Final npm package name/scope.
- First composite functions (deferred until real use cases exist).

Feed-side decisions — endpoint shape, wire formats, slow-consumer policy, keepalive, missing-version skips, and harness placement — are recorded in the [change feed doc](../atlas-change-feed/README.md).
