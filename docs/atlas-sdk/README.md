# Atlas SDK

The Atlas SDK (`packages/sdk/`) is the single client for Atlas Core: the `@the-drunken-coder/atlas-sdk` TypeScript/JavaScript package with a typed HTTP client, an optional started sync engine (local cache + change feed consumer + reconciliation), a bundled `atlas` CLI, and Node/browser test suites. It targets Node `>=24` and browser runtimes with web-standard `fetch` and `WebSocket`. Public npm publishing is a convenience release step for this greenfield repo, not a compatibility promise.

The SDK is the preferred client path for UI code, asset-side services, and tools. Direct API calls remain acceptable for small tools and non-TypeScript services, but the SDK/CLI should be the default integration surface.

**Sole consumer:** Atlas currently has one developer/operator. The package carries no compatibility promise; breaking changes are preferred over shims. The SDK checks its generated `ATLAS_PROTOCOL_REVISION` against Core over `GET /protocol/revision` and the feed `hello` frame, then validates inbound resource and feed payloads before they can reach cache state.

## Design goals

- One TypeScript/JavaScript package that runs unmodified in browsers and Node ("isomorphic"): web-standard `fetch` and `WebSocket` only, no Node-only dependencies, tests run in both environments in CI.
- Identical function behavior whether the sync engine is running. Callers never branch on mode.
- Real-time data with minimal latency for UIs — no "reload the page" feel.
- Reduce API call volume by serving repeated reads from a continuously synced local cache.
- Usable beyond TypeScript via a bundled CLI and a documented, language-neutral sync contract (see "CLI and cross-language story").

## Non-goals

- A sidecar runtime for other languages.
- A historical cache or offline archive.
- Speculative composite functions before real callers need them.

## Architecture

Two components, not three modes:

1. **Typed HTTP client** — always present. The implemented surface covers entity/object CRUD, immutable Task creation and explicit lifecycle operations, Asset runtime registration and delivery, entity check-in, one-page query helpers, `client.commandCatalog()`, object content download, optimistic-concurrency errors, protocol handshake checks, and cache-aware reads. The command catalog type and validator are generated from Atlas Protocol; the method reads Core's direct `/command-catalog` endpoint rather than an Atlas object. Object upload remains a direct API call for now; use entity check-in for telemetry and status reporting.
2. **Sync engine** — optional. Local cache + change feed consumer + reconciliation loop.

The constructor can optionally seed the all-resources subscription:

```ts
new AtlasClient({ baseUrl, apiKey });              // no initial subscription
new AtlasClient({ baseUrl, apiKey, sync: false }); // no initial subscription
new AtlasClient({ baseUrl, apiKey, sync: "all" }); // seed the all-resources subscription
```

Omitted `sync` and `sync: false` start with no subscription; `sync: "all"` seeds an all-resources subscription. Call `client.subscribe(filter)` and `client.unsubscribe(filter)` to manage explicit filters (the subscription primitives are defined in the [change feed doc](../atlas-change-feed/README.md)). `await client.sync.start()` still performs the existing full-dataset hydration from `GET /queries/full` before it connects the websocket feed and begins the changed-since safety-net poll, regardless of the initial subscription setting.

`client.sync.snapshot()` synchronously projects the live cache into frozen records keyed by resource ID for entities, tasks, and objects. It performs no request or sync transition and omits deleted-entry markers and other internal bookkeeping. Snapshot references stay stable until the cache changes; each accepted change creates one canonical frozen resource shared by cache reads, snapshots, and watcher values, replaces only its resource-type record, and preserves the other records by reference. Mutating an API or write response cannot mutate that owned cache value.

### Unified read surface

Every read function resolves the same way, invisibly to the caller:

1. Sync engine running **and healthy** and the resource is covered by an active subscription → serve from cache.
2. Otherwise (cache miss, engine degraded, engine not running, or caller passed `{ fresh: true }`) → call the API; merge the response into the cache on the way back.

Rules that make this safe:

- **Always async.** Every read returns a Promise even when served from cache, so the two paths are indistinguishable to callers except in speed.
- **Degraded fallthrough.** The engine tracks connection state and its last confirmed global version. If the feed is disconnected or a version gap is unreconciled, the engine marks itself degraded and reads fall through to the API until it catches up. The cache only answers when it is entitled to.
- **Validated inbound state.** HTTP resources, full and changed-since pages, feed handshakes, and feed events pass generated Atlas Protocol predicates plus narrow envelope and ID/version-coherence checks before cache mutation. A malformed sync/feed payload leaves cached state untouched and marks a running sync degraded.
- **An update path is required.** A runtime with neither a WebSocket implementation nor a positive polling interval remains degraded after hydration, so covered point reads continue to call Core instead of trusting a frozen cache.
- **`{ fresh: true }`** forces an API call for data-critical reads regardless of engine state. Pass `signal` in the same options object when the read belongs to a cancellable lifecycle.
- **Plain returns + sync status.** Functions return plain data (no metadata envelope). Observability currently comes from `client.sync.status()`; read-source debug hooks are deferred until a real caller needs them.

### Watch API

`client.entities.watch(id, callback)` (and equivalents per resource type) reports accepted resource events. Collection-level event watches use the generic `client.watch(filter, callback)` surface, such as `client.watch({ filter: "type", resource_type: "entity" }, callback)` or `client.watch({ filter: "all" }, callback)`.

Watcher callbacks receive the same Protocol feed events whether they arrive over the websocket or through changed-since recovery. Entity and Object watchers can also receive the SDK-local `local_delete` event when a successful local DELETE removes the resource from the cache before Core's versioned delete event arrives. Tasks are retained permanently and never produce this event.

Snapshot consumers such as UIs use `client.sync.watchSnapshot(callback)`. It fires with the current immutable snapshot after cache changes and after an expired-cursor recovery atomically replaces the cache through full hydration. This keeps snapshot-driven views observable even when no individual recovery event exists for the replacement.

### Writes and read-your-writes

Write functions always call the API. The API returns the created/updated resource with its new version; the SDK applies it to the cache immediately, guarded by `version > cachedVersion` so a racing feed event cannot regress state. A client that creates a task and immediately reads it sees it.

The SDK surfaces the API's optimistic concurrency (ETag/`If-Match`) as a typed `ConflictError`, rather than hiding it. Callers that want retry behavior refetch and resubmit explicitly for now; no shared retry helper exists yet.

## Change feed consumption

The websocket change feed — event shapes, delete events, subscription primitives, task-routing rules, delivery mechanics, and its testing approach — is documented in the [change feed doc](../atlas-change-feed/README.md). The sync engine's websocket transport and recovery path consume the same Protocol events.

What the SDK relies on from that contract: fat events carrying the full serialized resource and a global version, versioned Entity and Object delete events, object metadata (never content) on the feed, and the four subscription filters (`all`, by resource ID, by resource type, and `tasks_for_asset`).

## Reconciliation (replaces the original 20-second hard refresh)

The consistency mechanism is `GET /queries/changed-since` with one global version cursor, not periodic full re-pulls. The endpoint returns the same ordered create, update, and delete events used by the websocket after the requested version. The gap-detection and reconnect rules below are the SDK's implementation of the consumption contract in the change feed doc.

- **Gap detection:** the cache tracks its last applied version N. If an event arrives with a version that skips past expected values, the SDK immediately calls `changed-since?since_version=N` to catch up. Recovery is event-driven, not timer-driven.
- **Reconnect:** the SDK captures its cursor before connecting, installs the event listener, sends its initial subscriptions plus a barrier, and waits for Core's `subscriptions_ready` acknowledgement before starting recovery. It drains `changed-since` from that captured cursor one page at a time and buffers live events until recovery completes; buffered versions already covered by recovery are discarded, and later versions are applied in order. The transport's pending-consumer queue and the separate recovery handoff buffer are each limited to 100 events or 8 MiB in aggregate; exceeding either backlog budget drops the connection so durable recovery can resume from the last safely applied cursor. An otherwise-empty queue accepts one event larger than the byte budget so the cursor can advance. The engine remains degraded (reads fall through to the API) until both recovery and the buffer complete. If the cursor has expired, the SDK automatically performs paginated full hydration, publishes the replacement snapshot, and resumes from that watermark.
- **Version-guarded application:** reconciliation applies returned events in ascending version order and updates cache entries only when `event.version > cachedVersion`. A delete is a versioned cache entry, so an older resource payload cannot restore a resource after a newer delete has been applied.
- **Safety-net poll:** a lazy periodic `changed-since` call (interval on the order of minutes, configurable) is an optional backstop for operational resilience; a no-change response is nearly free. The acknowledged reconnect handoff remains correct when polling is disabled.
- **Hydration:** `GET /queries/full` on engine start. The engine retains the response's stable `version` across every continuation page, caches hydrated resources without advancing the global cursor from their individual versions, then drains `changed-since` from that pre-hydration baseline before synchronization is current. A later full-dataset page may legitimately contain a resource newer than the baseline; reconciliation still starts from the baseline so an earlier-page concurrent update cannot be skipped. At expected scale (10–20 assets, low hundreds of tracks from ADS-B ingest, never thousands) hydration is one or a few pages and subscribe-`all` in a browser tab is trivially fine.

## Objects

An object is two things, treated differently:

- **Metadata** (small JSON: identity, type, references, and usage hints) — created and updated through the object API, flows over the change feed, and lives in the cache like entities and tasks. Blob facts (`path`, `content_type`, `size_bytes`, and `bucket`) are read-only response data populated by Core's upload path.
- **Content** (the blob, e.g. heat map data) — fetched on first use and cached keyed by `(object_id, version)`. A metadata event with a newer version makes the stored blob stale by construction; the next read re-downloads. The content cache owns a copy of each buffer and returns a fresh copy to each caller, so caller mutation cannot corrupt later reads. It also has a size cap with least-recently-used eviction so a long-running browser tab does not accumulate blobs without bound. Because Core has no versioned download endpoint, the SDK verifies metadata after each download and retries once if the version moved mid-flight — correctness over an extra metadata round-trip.

Object `referenced_by` entries are normalized to the protocol `ObjectReference` shape: only `entity_id` and `task_id` are emitted. Extra keys in stored object metadata are intentionally not part of the public API response.

## Types: generated, not hand-written

Resource, request, and response types come from generated artifacts under `packages/protocol`: the SDK compiles the generated TypeScript source into the package and imports it through ESM `.js` specifiers, rather than copying or hand-writing wire shapes. The generated `RESOURCE_TYPE_VALUES` list and predicates are also the source used by subscriptions, the CLI, and downstream workspaces. Protocol changes propagate by regeneration, while the generated `ATLAS_PROTOCOL_REVISION` constant detects SDK/API mismatches across independently built or deployed versions (see the [protocol doc](../atlas-protocol/README.md)). SDK-specific types (client config, sync status, event/debug shapes) are authored in the SDK.

The TypeScript compiler intentionally uses the repository root as `rootDir` so the built package contains both `dist/packages/sdk/src/*` and the generated `dist/packages/protocol/generated/typescript/*` modules that the SDK imports. Package metadata points the root export at the built SDK entrypoint, exposes `@the-drunken-coder/atlas-sdk/admin` for browser admin/session and managed API-key calls, and provides focused `config`, `errors`, and `spatial` entries for browser code that does not need the resource client or generated predicates. The generated revision constant lives in its own module so those focused imports do not pull the validator runtime into the initial browser bundle. The package also installs the `atlas` CLI binary. The command interface and simulations declare the SDK through the root npm workspace and use public package exports; no source alias bypasses the package boundary.

## CLI and cross-language story

The SDK ships a CLI (`atlas entities get <id>`, `atlas tasks create <json>`, JSON output) so non-TypeScript callers can subprocess the typed client. For pushed data, `atlas watch --subscribe <filter> --follow` runs the sync engine and emits one JSON line per change event.

The language-neutral contract remains Atlas Protocol plus the change-feed consumption rules. A future Python SDK should be a port of that contract, not a new design.

Install JavaScript dependencies once from the repository root with `npm ci`. Focused SDK commands are `npm run build:sdk`, `npm run lint --workspace @the-drunken-coder/atlas-sdk`, `npm run format:check --workspace @the-drunken-coder/atlas-sdk`, `npm test --workspace @the-drunken-coder/atlas-sdk`, and `npm run test:package --workspace @the-drunken-coder/atlas-sdk`. The package smoke starts with deliberately stale `dist/` output, creates a clean tarball, installs it into a temporary consumer, compiles its public declarations, and exercises the root, focused browser entries, CLI, and generated protocol paths. CI also runs `npm audit --audit-level=high` against the complete workspace dependency tree.

## Auth

Atlas Core has optional API-key auth (`X-API-Key` or `Authorization: Bearer`). The default `atlas.py --dev` launcher enables it and stores a generated local bootstrap key in `services/core/docker/.env.local`; raw Core startup follows its explicit settings and does not load that local credential file. The SDK `apiKey` option sends `X-API-Key` on HTTP requests and an `auth` frame on the websocket feed connection; it does not send Bearer headers. Keys can be the local or production bootstrap key, or managed keys created through Core admin auth. Per-client identity, scoped keys, audit, and token refresh stay out of scope until Core has a richer auth model.

## Composite functions

Higher-level functions (multiple endpoints, or one endpoint with opinionated defaults) live in the SDK so the API layer stays thin. Design rule: composites only orchestrate public client methods — never private internals — so they stay testable and the basic layer remains the single source of API behavior. No concrete composites exist yet; candidates will come from real usage (likely first: task-an-asset flows built on the command catalog).

## Task lifecycle, check-in, and queries

`client.tasks.create(request, { idempotencyKey })` creates an immutable Task. The request contains only `asset_id`, `command`, and `input`; Core generates `task_id`. The required key belongs to one operator tasking attempt and must be reused when that attempt is retried. Asset runtimes use the explicit `acknowledge`, `start`, `progress`, `complete`, and `fail` methods with a current `runtimeId`. Tasking clients use `cancel` without runtime context. Every successful lifecycle response enters the same cache/watch path as feed updates.

`client.runtime.begin`, `ready`, `stop`, and `tasks` expose process registration, manifest publication, explicit deactivation, and runtime-scoped delivery. `begin`, `ready`, and `stop` carry the runtime ID in their request bodies; `tasks` carries it in `Atlas-Runtime-ID`. A missing or stale stop is an idempotent Core no-op. The SDK does not infer process restarts from transport reconnects.

`client.entities.checkIn` is the telemetry and observed-state reporting path. It accepts telemetry, operational status, component updates, and an optional `AbortSignal`, refreshes the entity heartbeat through Core, and returns the updated Entity only. `client.handshake` accepts the same lifecycle signal. Full/default check-in calls return the generated `EntityCheckInFullResponse`; `fields: "minimal"` returns `EntityCheckInMinimalResponse`; unresolved option unions return the generated non-generic `EntityCheckInResponse` union. Task delivery is separate and runtime-scoped.

`client.queries.full` and `client.queries.changedSince` expose typed one-page wrappers over the existing query endpoints. They intentionally do not mutate sync state or fire watchers; the sync engine manages its own reconciliation cursor.

## Testing

The test harness in `packages/sdk/test/` drives a fake Core and feed through Entity writes, Task lifecycle changes, Object writes, deletions, dropped events, and forced version gaps while keeping a ledger of every write. At checkpoints and at the end, the SDK cache must match the ledger, watchers must receive every relevant change, and reconciliation must recover from injected faults. The same suite runs in Node and a browser through Playwright, alongside unit tests and the CLI smoke test.

## Known gaps (explicitly deferred)

- **Offline/flaky-link writes from assets.** Writes always call the API; there is no SDK queueing or retry outbox for an asset that calls e.g., `client.tasks.complete(...)` while its link is down. Out of scope for v1 — asset software must handle write failures itself until a later phase designs durable retries. Add an SDK outbox only after client identity and idempotency keys exist, so retries can be attributed and safely de-duplicated.
- **Object upload.** Upload remains a direct Core API call for now; the SDK already has the transport and cache conventions it should follow when this is added.
- **Auth hardening.** Bootstrap and managed API keys are still full-access machine credentials. Browser UI auth is Core-owned session-cookie auth, not durable client-side API-key state. Per-client identity, scoped/read-only keys, and an audit trail of who tasked an asset are prerequisites before anything broader than the current operator deployment.

Feed-side decisions — endpoint shape, wire formats, slow-consumer policy, keepalive, missing-version skips, and harness placement — are recorded in the [change feed doc](../atlas-change-feed/README.md).
