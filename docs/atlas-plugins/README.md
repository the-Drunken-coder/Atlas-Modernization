# Atlas plugins

Status: agreed architecture. No plugin runtime, source connector, plugin operation, or datastream exists yet.

Atlas plugins add bounded capabilities without deploying a new public API for every integration. Atlas remains the public control plane. Plugins run behind Core-owned routes, consume external data through Atlas-managed source connectors, and use normal Atlas resource and task systems when their results become durable or cause action.

## Goals

- Install different kinds of plugins without adding a new public service for each one.
- Give plugins a consistent way to use external APIs without exposing credentials to the browser or duplicating access policy.
- Allow plugins to expose bounded operations, publish optional datastreams, and request Atlas actions.
- Isolate plugin and external-source failures from Atlas Core.
- Make installed capabilities and their current status visible to authenticated operators.

## Non-goals for the first version

- Executable browser plugins or plugin-provided React code.
- A universal schema that normalizes every external API.
- Direct plugin database access.
- Arbitrary plugin-owned public HTTP routes.
- Treating every plugin result as a durable Atlas resource.
- A plugin marketplace, hot installation, or automatic dependency resolution.

## Model

```text
Command Interface or another Atlas client
                    |
          Core-owned HTTP interface
                    |
          Plugin registry and proxy
             /       |       \
      Operations  Datastreams  Atlas actions
             \       |       /
                 Plugin
                    |
              Source Gateway
                    |
          named Source connector
                    |
             External source
```

Core owns public authentication, authorization, request limits, errors, and route stability. A Plugin owns source-specific queries, normalization, and behavior. The Source Gateway hosts Source connectors, which own secrets and shared access mechanics. Normal Atlas action modules remain authoritative for Entity, Task, and Object mutations.

## Public HTTP interface

Plugins do not add arbitrary routes. Core exposes fixed, namespaced routes and dispatches requests to the matching Plugin. The initial route family is:

```text
GET  /plugins
POST /plugins/{plugin_id}/operations/{operation_id}
```

`GET /plugins` is the authenticated discovery and status endpoint. Core reserves the `/datastreams` namespace but exposes no Datastream discovery or delivery route until that contract defines transport, ordering, replay, latency, and persistence. A Plugin manifest contains only its Plugin ID, display name, Operation descriptors, and optional Tool Asset ID. When present, the Tool Asset ID must equal the stable ID Core derives from the Plugin ID; a mismatch invalidates the manifest. Each Operation descriptor declares the timeout Core enforces for that Operation. Commands remain in the Tool Asset's existing runtime manifest. Plugin manifests do not contain Datastream descriptors, configuration schemas, connector requests, permissions, protocol versions, or upgrade metadata.

An Operation is always a bounded synchronous JSON request and response. Core applies hard size limits to the public request body and the private Plugin response body. It rejects an oversized request before dispatch and maps an oversized Plugin response to Plugin failure. Core treats input and output as opaque JSON. The Plugin validates input and owns the result shape. Each descriptor declares a timeout, and Core rejects the whole manifest if any timeout exceeds its hard maximum. Core cancels the private request when the public caller disconnects or that timeout expires. The Plugin handler must stop promptly and propagate cancellation to its Source Gateway and Atlas SDK calls. A caller disconnect or Operation timeout applies only to that invocation and does not change Plugin availability. Core returns the Operation result in the same request. Work that must outlive that request uses a Tool Task instead; the Plugin system does not add asynchronous Operation jobs or polling.

Operations are semantically read-only and side-effect free. They may query Atlas or an External source, including sources whose query API uses HTTP `POST`, but they do not mutate Atlas, change an External source, or start ongoing behavior. Durable changes use normal Core writes, and ongoing actions use Tool Tasks. Core cannot infer side effects from opaque JSON, so Plugin code owns compliance with this contract. The live delivery transport for Datastreams remains open until a real stream establishes its ordering, replay, and latency needs.

## External-source access

A private Source Gateway container hosts named Source connectors for all Plugins. It is part of the Compose-managed Atlas deployment and has no public API. Core does not proxy external-source traffic, and Plugins do not receive External source credentials.

Source connectors centralize mechanics shared across external systems:

- secret injection without revealing credentials to the Plugin or browser
- allowed hosts and outbound request policy
- timeouts and cancellation
- rate limits and concurrency limits
- caching and freshness policy
- retries and circuit breaking
- request metrics and failure status

Each Source connector pins its external origin and credentials. A Plugin identifies the connector and supplies a relative path, method, query, allowed headers, and body within configured limits. The Gateway rejects absolute URLs, origin overrides, and credential-header overrides. Before every connection, it validates the selected address against the connector's egress policy. Loopback, link-local, and private addresses are denied unless that connector explicitly allows them, and the connection uses only the validated address. The Gateway never follows upstream redirects; it returns each `3xx` response to the Plugin under the same bounded response rules. It does not translate vendor payloads into an Atlas-wide external-data schema. Each Plugin owns the meaning and shape of its source data.

The Gateway buffers the complete upstream response up to the connector's configured response-size limit, which cannot exceed a hard Gateway maximum. It then returns the upstream status, allowed response headers, and raw response bytes to the Plugin. It rejects an oversized response without returning a partial body. It does not require JSON, stream partial data, or wrap data in a normalized external-data envelope.

Every source-backed Plugin result must carry enough source provenance and freshness information for callers to judge it. This requirement applies when the Plugin returns the result from an Operation or future Datastream and when it writes the result through the Atlas SDK. The Plugin owns the result-specific fields; the Source Gateway does not add a common metadata envelope.

Caching is disabled unless connector configuration enables an in-memory time-to-live cache for specific upstream endpoint and method combinations whose provider contract declares responses safe to reuse. The Gateway never caches a request that may mutate upstream state. The cache key covers the complete outbound request, including the connector, method, relative path, query, allowed headers, and body. In addition to the per-response limit, the cache has hard Gateway-wide byte and entry caps. Cache admission evicts entries rather than exceeding either cap. Cached data is disposable and is lost when the Gateway restarts.

Connector configuration declares retry safety for specific upstream endpoint and method combinations, plus the failure or response statuses that allow another attempt. The Gateway applies only bounded retries under those rules. A request that may mutate upstream state is retryable only when the connector rule requires a provider-supported idempotency key and the request supplies it. The Gateway never treats a method alone as proof that a request is safe to retry. It maintains one circuit breaker per connector.

The Gateway owns fixed failure categories for an unknown connector, rejected request policy, timeout, oversized response, open circuit, and unreachable upstream. It does not return raw network or connector errors. A valid upstream HTTP response is not a Gateway failure, even when its status represents a vendor error. The Gateway returns that status, the allowed headers, and the bounded response body for the Plugin to interpret.

A Source Gateway failure degrades Plugins that depend on External sources. It does not change Core liveness or readiness. All installed Plugins are trusted and may use every configured connector. Connector access is not a Plugin capability and requires no per-Plugin grant.

Deployment configuration defines connector IDs, external origins, request limits, and secret references. The Gateway resolves secret references from environment variables or Compose secrets at startup. Core, Atlas resources, and Plugins do not store those credentials. Changing connector configuration restarts the Gateway.

## Atlas access

Plugins may need to read Atlas data or request Atlas mutations. They never access the database directly. Core remains responsible for validation, authorization, idempotency, persistence, and the change feed.

Plugin code uses the ordinary Atlas SDK with a full-access managed API credential. Core applies the same authentication, validation, and resource rules it applies to any SDK client, but it does not enforce Plugin-specific capabilities. Plugin code owns its own safety and limits which SDK methods it calls.

Today's full-access managed API keys satisfy this contract. All Plugins share one full-access Plugin API key supplied through deployment configuration. Atlas does not currently persist an actor on Entities, Tasks, Objects, or feed events, so the Plugin architecture adds no Plugin-specific provenance or audit model.

## Execution and failure isolation

The deployment orchestrator starts one trusted container per configured Plugin. In the bundled Atlas deployment, Docker Compose owns startup, restart policy, resource limits, and shutdown. Core does not receive Docker socket access and does not create, upgrade, or delete containers.

Deployment configuration gives Core each Plugin's stable ID and private base URL. Core uses a fixed HTTP/JSON protocol to fetch its manifest and health, dispatch Operations, and report status. Plugins do not self-register, and Core does not scan Docker or the network for them. Either side may start first; Core keeps retryable Plugin failures out of base liveness and readiness.

Core applies a hard response-size limit to every private Plugin call, including manifest, health, and Operation responses. An oversized response is invalid and makes the Plugin unavailable without Core buffering beyond the limit.

Core fetches each configured Plugin manifest during startup. If the Plugin is unavailable, Core continues starting and retries until the first successful manifest response. Before caching it, Core requires the manifest's Plugin ID to match the configured Plugin ID exactly and any advertised Tool Asset ID to match the stable ID derived from that Plugin ID. A mismatch is an invalid manifest and keeps the configured Plugin unavailable. Core caches a valid matching manifest in memory until Core restarts. A valid cached manifest is an independent availability prerequisite that health or Operation responses cannot replace. Core does not refresh manifests periodically or fetch one for every request. Plugin upgrades restart the whole deployment, so manifest changes do not need hot reload.

The private Plugin protocol has no revision field, version negotiation, or compatibility layer. Core and Plugin changes update the contract directly, and Plugin tests catch mismatches. Plugins still use the Atlas SDK's existing generated Atlas Protocol revision check when calling Core; the Plugin system does not add another version mechanism. A future Core-wide versioning rework may replace that existing check, but it stays outside the Plugin architecture.

The first architecture has no separate Plugin Definition and Plugin Instance concepts. One configured Plugin ID maps to one deployment-managed container, whose Plugin may be `starting`, `available`, or `unavailable`. A Plugin may handle multiple concurrent requests or monitored areas internally, but Atlas does not schedule multiple active instances of the same Plugin.

## Configuration and upgrades

Plugin settings live in deployment files and environment variables mounted into the Plugin container. Atlas has no Plugin configuration API or Plugin configuration resources. Runtime operator intent still uses Operations or Tasks.

Installing or upgrading a Plugin means editing deployment configuration or its image tag and restarting the Atlas Compose deployment. Core has no installation or upgrade API. A development Compose restart may clear scratch data under the existing destructive development workflow. Production restarts continue to preserve durable storage; data loss is not part of the Plugin upgrade contract.

## Health, readiness, and status

`GET /health` remains Atlas Core liveness only. `GET /readiness` remains limited to dependencies required for Core to serve its base contract.

`GET /plugins` includes authenticated status for every configured Plugin with `starting`, `available`, or `unavailable` status. `starting` means Core has not completed its first manifest check. `available` means Core has cached a valid matching manifest, Plugin transport is reachable, and its latest health response is OK. `unavailable` means the manifest prerequisite failed, transport failed, or the latest health response reported an application-level failure. Status includes the time of the latest check and a stable Core-owned reason code. It never includes private URLs, raw health responses, credentials, or upstream response bodies.

Core checks Plugin health on one fixed internal cadence. A connection failure, a manifest or health timeout, or an invalid private response makes the Plugin transport unavailable immediately. Any subsequent valid manifest, health, or Operation response restores transport availability immediately, even when the Operation rejects its input or health remains non-OK. Transport recovery cannot replace a valid cached manifest. A descriptor deadline or caller-initiated cancellation affects only that Operation invocation. Transport recovery does not clear an application-level health failure; only a later OK health response does. Core maps a non-OK health response to a stable `application_unhealthy` public reason without exposing its private detail. After Core caches a manifest, discovery continues to show its Operations while the Plugin is unavailable, but invocation fails. An optional Plugin failure does not make Core unhealthy or unready.

Core owns the public Operation error envelope and maps failures into stable categories for rejected input, an unavailable Plugin, timeout, and Plugin failure. It does not proxy the Plugin's HTTP status or raw error body. A Plugin may include a Plugin-specific error code and safe diagnostic data inside the authenticated error details without expanding Atlas's top-level error categories.

## Command-interface integration

The first version does not load executable UI code from Plugins. The Command Interface may use generic discovery and status data. A first-party feature may also understand a specific Plugin's Operation or a future Datastream contract.

Declarative contributions such as map layers, forms, and actions may be considered after real Plugin interfaces exist. Arbitrary Plugin-provided JavaScript remains deferred.

A Plugin that operators need to task may register an ordinary Asset with `entity_type: "asset"` and `subtype: "tool"`. Query-only Plugins do not need a Tool Asset. Tool Assets use the existing runtime, Task, and Command systems.

The Plugin derives one stable Tool Asset ID from its Plugin ID and performs an idempotent get-or-create through the Atlas SDK during startup. It creates a missing Entity as an `asset` with subtype `tool` and a `custom_plugin` ownership component containing its Plugin ID. It reuses an existing Entity only when its type, subtype, and ownership marker all match. Any mismatch is a conflict, so the Plugin refuses runtime registration and returns a non-OK private health response until an operator corrects it. The Plugin platform extends Core's existing runtime identity guard so `entity_type`, `subtype`, and the ownership marker cannot change after an Asset runtime has registered. Core rejects deletion of a Plugin-owned Tool Asset while its Plugin remains configured, in addition to the existing deletion guard for nonterminal Tasks. Removing the Plugin from deployment configuration is the only uninstall path; after removal and Task terminalization, an operator may delete its Tool Asset.

Plugin commands remain dedicated, Protocol-authored Atlas Commands, such as `sensing.scan_area`. A Plugin runtime manifest may advertise the subset it implements, but it cannot extend the production Command Catalog. Adding taskable Plugin behavior therefore remains a coordinated Atlas change with a Command schema, semantics, execution handler, and purpose-built Command Interface input. Plugin installation does not inject commands or generic forms into the browser.

Long-running Plugin commands use `immediate` scheduling when several Tasks must execute at once. The existing Protocol contract lets an Asset manifest choose `queued` or `immediate` when the Command definition omits scheduling. The Plugin platform implementation must make Core enforce manifest scheduling only when the Command Catalog explicitly declares a requirement. Multiple immediate Tasks begin in tasking order without waiting for one another to finish. A monitoring Task remains `in_progress` for the monitoring session and declares `supports_cancel: true`. Cancelling the Task is the operator's stop action. Core marks it `cancelled` and aborts that Task's Plugin handler. The Plugin must stop work promptly after observing the abort, but Atlas does not wait for a second shutdown confirmation. Atlas has no separate "queueing off" setting.

## Plugin state

Plugin containers have no persistent private storage in the first architecture. Durable operator intent and durable results use normal Atlas resources. Plugin caches, temporary files, and source checkpoints are disposable. A Plugin-specific persistent volume or a generic Plugin key-value store will not be added until a real Plugin needs state that Atlas resources cannot represent. A long-running monitoring Task is the sole authority for its session; the Plugin does not duplicate desired monitoring state onto the selected Geofeature.

If a Plugin process exits without a graceful runtime stop and no replacement registers, Core does not infer a terminal Task outcome from Plugin health. Its accepted Tasks remain nonterminal until an operator cancels them. Operational recovery must surface those stranded Tasks for cancellation before creating replacements. If a replacement runtime registers first, normal fencing fails them with `asset_restarted`.

## Datastreams

Datastreams remain a named optional Plugin capability, but their delivery and persistence contract is deferred. Neither current forcing scenario requires one. Atlas will not choose a streaming transport, replay model, or retention policy until a concrete transient-data use case needs it.

## Forcing scenarios

These scenarios test the architecture. They are not commitments to specific routes or persistence behavior.

### Monitor ADS-B traffic in an area

An operator selects a Geofeature and creates a `sensing.scan_area` Task for the ADS-B Tool Asset. The Task input identifies the Geofeature and may include the duration defined by that shared Command. The Plugin reads an external ADS-B source and creates or updates Atlas Tracks through Core. It does not need to expose a Datastream merely because its source is continuous. A Datastream would be justified only for a separate transient product that clients need to consume outside the durable Track model.

Each monitoring Task uses `immediate` scheduling, so one Tool Asset can monitor several areas concurrently. The Task remains `in_progress` while its handler monitors the area. Cancelling the Task aborts that handler and tells the Plugin to stop publishing observations for that monitoring session.

The Task is the only authority for the monitoring session. The Geofeature does not carry separate desired monitoring state. During a planned restart, the Plugin calls the Asset runtime's `stop()`, and Core fails active monitoring Tasks with `asset_stopped`. If a new runtime registration fences the old runtime before it stops, Core uses `asset_restarted`. If neither event occurs after a crash, the Tasks remain nonterminal until an operator cancels them. No path resumes the Tasks. An operator must create a new Task to restart monitoring.

One later ADS-B design question is how duplicate aircraft observations map to stable Track identities.

### Inspect a building

An operator selects a point or building on the map and invokes a building-information Operation. The Plugin queries OpenStreetMap or another configured source and returns transient building geometry, tags, provenance, and available height information. The operator may later promote the footprint into an Atlas Geofeature.

The building is not an Asset or Track. Source-provided height is advisory data and cannot by itself authorize a drone flight. A later flight request remains a normal Atlas Task against a drone Asset, with its own safety and preflight behavior.

## Decisions already settled

- Core owns fixed public Plugin routes and reserves the Datastream namespace until its contract exists.
- Docker Compose or the deployment orchestrator starts one trusted container per configured Plugin.
- Deployment configuration explicitly maps one Plugin ID to one private Plugin base URL.
- Core communicates with Plugins through a fixed private HTTP/JSON protocol; Plugins do not self-register.
- Atlas does not model multiple active instances of one Plugin.
- Plugin code uses the ordinary Atlas SDK with full access; Core does not enforce Plugin-specific capabilities.
- All Plugins share one full-access Plugin API key.
- A taskable Plugin may register a Tool Asset with `entity_type: "asset"` and `subtype: "tool"`; query-only Plugins need no Asset.
- A taskable Plugin creates or ensures its own Tool Asset through the SDK during startup and records its Plugin ID in an ownership component.
- A Tool Asset ID is derived from its Plugin ID; Core keeps its type, subtype, and ownership marker immutable after runtime registration, and any mismatch makes the Plugin unavailable.
- An advertised Tool Asset ID must match the stable ID derived from the manifest's Plugin ID.
- Core rejects deletion of a Plugin-owned Tool Asset while its Plugin remains configured.
- Tool Assets implement dedicated Protocol-owned Commands rather than Plugin-defined Commands.
- Long-running Plugin Tasks may use `immediate` scheduling so several Tasks can overlap; cancellation is their stop action.
- Plugin Task cancellation uses the existing terminal cancellation and handler abort without a second confirmation.
- A graceful Plugin runtime stop fails active Tasks with `asset_stopped`; replacement fencing uses `asset_restarted`. Plugins do not resume them automatically.
- A private Source Gateway container hosts Source connectors for all Plugins.
- Source connectors pin external origins, validate each selected address against connector egress policy, accept bounded relative requests from Plugins, and do not follow upstream redirects.
- Every installed Plugin may use every configured Source connector.
- Plugin and Source Gateway configuration is deployment-owned; secrets come from environment variables or Compose secrets.
- Plugin containers have no persistent private storage in the first architecture.
- The private Core-to-Plugin contract has no Plugin protocol version or compatibility negotiation.
- The existing Atlas Protocol revision check between the SDK and Core remains unchanged.
- Installing or upgrading a Plugin edits deployment configuration and restarts the Compose deployment.
- A Plugin manifest contains Plugin and Operation discovery fields only; Datastreams, Commands, configuration, credentials, and compatibility metadata stay elsewhere.
- Core fetches a Plugin manifest once, retrying until success, and caches it until Core restarts.
- Core bounds every private Plugin response and rejects a manifest whose Plugin ID differs from deployment configuration or whose Tool Asset ID differs from the stable derived ID.
- Operations are side-effect-free synchronous JSON calls with Plugin-owned validation, bounded request and response bodies, bounded per-Operation timeouts, and propagated cancellation; longer work uses Tool Tasks.
- Core maps Operation failures into stable Atlas error categories; Plugin-specific codes may appear only in authenticated error details.
- Every configured Plugin remains discoverable with `starting`, `available`, or `unavailable` status.
- Authenticated status reports the latest check time and a stable Core-owned reason code without private endpoints or raw failure data.
- Core checks Plugin health on a fixed internal cadence. Any valid manifest, health, or Operation response restores transport availability immediately, while a valid cached manifest remains an independent prerequisite and a non-OK health response keeps the Plugin unavailable until a later OK health response.
- The Source Gateway buffers complete responses and returns upstream status, allowed headers, and raw bytes under a per-connector limit and hard Gateway maximum.
- Source Gateway caching is disabled by default; a connector may enable a disposable in-memory time-to-live cache only for explicitly safe endpoint and method combinations. Mutating requests are never cached, and hard Gateway-wide byte and entry caps bound the cache.
- Source Gateway retries are bounded by connector-declared endpoint and method rules. A request that may mutate upstream state also requires a provider-supported idempotency key.
- The Source Gateway returns fixed failure categories; valid upstream HTTP responses remain responses for the Plugin to interpret.
- The architecture specifies bounds and behavior, not numeric defaults. Implementation chooses and tests the initial values.
- Plugins do not expose external APIs directly as Datastreams.
- Source connectors unify access mechanics, not external data models.
- Source-backed Plugin results carry enough provenance and freshness information for callers to judge them.
- Durable results use normal Atlas Entity and Object systems.
- Plugin status does not change Core liveness.
- Executable UI plugins are deferred.
- The Datastream delivery contract and reserved delivery route are deferred until a concrete use case needs them.

## Design status

The Plugin platform architecture design tree is closed. The documents specify behavioral bounds but leave health cadence, timeout ceilings, response limits, retry counts, cache durations, and circuit-breaker thresholds to implementation.

Datastream delivery, executable browser plugins, declarative UI contributions, and ADS-B Track identity remain deliberately deferred. Each needs a concrete use case or Plugin design before Atlas should decide it.
