# Atlas plugins

Release and installation details:

- [`RELEASE_FORMAT.md`](RELEASE_FORMAT.md) defines independent Plugin artifacts, catalog trust, and publication.
- [`MANAGEMENT.md`](MANAGEMENT.md) defines local Installed Plugin state, compatibility, commands, and transactions.

Status: Plugin platform v1 and the first-party query-only catalog are implemented. Datastream delivery, executable UI
Plugins, third-party installation, hot upgrades, untrusted-Plugin isolation, scoped Plugin credentials, persistent
Plugin storage, and taskable-Plugin lifecycle management remain deferred.

## Independent Plugin releases

The implemented v1 remains the current behavior until this design is implemented. Its Core-packaged catalog and
matching Core and Plugin release versions are superseded as an architectural direction.

The replacement design has these settled requirements:

- Each Plugin has its own version and release workflow. First-party Plugin source remains in this repository unless a
  later ownership need justifies moving it.
- Updating a Plugin does not require publishing or installing a new Atlas Core version.
- The host-side `atlas-core` terminal menu discovers, installs, updates, enables, disables, and uninstalls Plugins. Core
  and the Command Interface do not receive container-runtime or host-filesystem authority.
- The first catalog is one signed, Atlas-published catalog of trusted first-party Plugins. Arbitrary catalogs, bundles,
  and image URLs remain unsupported.
- One Plugin release consists of one strict UTF-8 JSON `.atlas-plugin` document and the immutable multi-architecture
  container image that document identifies by digest. The document contains declarative installation metadata and never
  supplies executable installation hooks or arbitrary Compose configuration.
- A Plugin catalog entry is a release available to install. Catalog presence, installation, enablement, and runtime
  health are separate states. Installation retains one selected Plugin release. Enablement includes that Installed
  Plugin in the Atlas deployment. Runtime health continues to use `starting`, `available`, and `unavailable`; `available`
  never means catalog presence.
- Plugin compatibility follows the Plugin package schema, membership in the deployed Core-to-Plugin and
  Plugin-to-Source-Gateway supported-major sets, the existing Atlas Protocol revision when the Plugin uses the SDK, and
  fixed Command Interface interactions. Atlas Core SemVer is not the primary compatibility check.
- Plugin updates require explicit operator approval, either for one Plugin or for all compatible updates. Atlas does not
  install unattended Plugin updates.
- Enable, enabled-Plugin update, disable, and enabled-Plugin rollback may restart the existing Core, Source Gateway, or
  Plugin containers.
  They use the installed Core's retained Compose bundle and exact image, so they do not change the Atlas Core version.
  Hot installation and hot upgrades remain deferred.
- The first managed release supports trusted query-only Plugins. Taskable-Plugin installation, update, and uninstall
  remain deferred until Atlas defines active Task and Tool Asset handling.
- Plugin releases use immutable Semantic Versions in one stable channel. The manager offers the latest compatible,
  non-revoked release. Plugins cannot depend on other Plugins.
- Atlas Core continues to own public Plugin routes, authentication, limits, and durable Atlas actions.
- The Command Interface continues to provide fixed shared interactions and renderers. Plugins use those tools through
  declarative contracts rather than shipping executable browser code.
- Plugin processes remain separate from Core and continue to run under the deployment orchestrator.
- The first independent Core release refuses to update while a bundled-v1 Plugin is enabled. Operators disable those
  Plugins before the Core update and reinstall them from the signed catalog afterward.

The release format, catalog trust and publication, local state, transaction recovery, compatibility fields, and command
behavior are specified in the linked design documents. The current wire and deployment sections below continue to
describe implemented v1 until the replacement is built.

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
- A third-party marketplace, arbitrary image installation, hot installation, or automatic dependency resolution.

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

`plugin_id` and `operation_id` are lowercase ASCII identifiers matching `^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$`. Core rejects an invalid configured Plugin ID and rejects a manifest containing an invalid Plugin ID, an invalid Operation ID, or duplicate Operation IDs. This grammar excludes path separators and percent encoding, so each advertised Operation maps to one public route.

`GET /plugins` is the authenticated discovery and status endpoint. Core reserves the `/datastreams` namespace but exposes no Datastream discovery or delivery route until that contract defines transport, ordering, replay, latency, and persistence. A Plugin manifest contains only its Plugin ID, display name, private contract major, Operation descriptors, and optional Tool Asset ID. A Tool Asset ID is `plugin_` followed by the unpadded RFC 4648 base64url encoding of the SHA-256 digest of the exact ASCII Plugin ID. The prefix and 43-character digest encoding produce a 50-character Entity ID without normalization or truncation. When present, the Tool Asset ID must equal that derived value; a mismatch invalidates the manifest. Each Operation descriptor declares the timeout Core enforces for that Operation. Commands remain in the Tool Asset's existing runtime manifest. Plugin manifests do not contain Datastream descriptors, configuration schemas, connector requests, permissions, release versions, or upgrade metadata.

### Discovery response

After authentication, `GET /plugins` returns HTTP `200` with `Content-Type: application/json` and this array:

```json
[
  {
    "plugin_id": "adsb",
    "display_name": "ADS-B",
    "status": "available",
    "reason_code": null,
    "checked_at": "2026-08-27T13:00:00Z",
    "operations": [
      {
        "operation_id": "inspect_aircraft",
        "display_name": "Inspect aircraft",
        "timeout_ms": 5000
      }
    ],
    "tool_asset_id": "plugin_rfSey5Te4YU6Prz-hpGcwRnuSBuF9z1COTHZJt_s0G4"
  }
]
```

Core emits one entry per configured Plugin, ordered by `plugin_id`; Operations are ordered by `operation_id`. Every entry contains exactly the fields shown. `display_name` and `tool_asset_id` are strings from the cached manifest or `null` before Core caches a valid manifest; `tool_asset_id` is also `null` for a query-only Plugin. `operations` is empty before Core caches a valid manifest. Core retains cached discovery fields while a Plugin is unavailable.

`status` is `starting`, `available`, or `unavailable`. `checked_at` is the RFC 3339 timestamp of the latest manifest, health, or Operation transport result observed by the status tracker, or `null` before any such result. `reason_code` is `null` for `starting` and `available`. For `unavailable`, it is exactly one of `transport_unreachable`, `transport_timeout`, `invalid_manifest`, `invalid_response`, or `application_unhealthy`. `invalid_manifest` covers a malformed manifest, an identity mismatch, an oversized manifest, or a non-`200` manifest response. `invalid_response` covers a malformed, oversized, or unexpected health or Operation response. Authentication failures continue to use Core's existing public error envelope.

An Operation is always a bounded synchronous JSON request and response. Core applies hard size limits to the public request body and the private Plugin response body. It rejects an oversized request before dispatch and maps an oversized Plugin response to Plugin failure. Core treats input and output as opaque JSON. The Plugin validates input and owns the result shape. Each descriptor declares a timeout, and Core rejects the whole manifest if any timeout exceeds its hard maximum. Core cancels the private request when the public caller disconnects or that timeout expires. The Plugin handler must stop promptly and propagate cancellation to its Source Gateway and Atlas SDK calls. A caller disconnect or Operation timeout applies only to that invocation and does not change Plugin availability. Core returns the Operation result in the same request. Work that must outlive that request uses a Tool Task instead; the Plugin system does not add asynchronous Operation jobs or polling.

Core enforces one hard in-flight Operation limit per configured Plugin. The limit counts requests from private dispatch until the Plugin response, timeout, or caller cancellation completes. Core does not queue requests above the limit. It rejects them immediately with the unavailable Plugin error category and stable reason `capacity_exhausted`, without changing Plugin status. Implementation chooses and tests the numeric limit.

### Operation errors

The Plugin platform implementation adds `PLUGIN_NOT_FOUND`, `PLUGIN_INPUT_REJECTED`, `PLUGIN_UNAVAILABLE`, `PLUGIN_TIMEOUT`, and `PLUGIN_FAILURE` to the Atlas Protocol `ErrorCode` enum before Core exposes the public Plugin routes. Operation failures use Core's existing `ErrorResponse` envelope. `success` remains `false`; Core supplies the human-readable `message` and its normal `error_id`, `timestamp`, and `path` metadata. Clients branch on `error_code` and the fields below, not `message`.

| Failure | HTTP status | `error_code` | `details` |
| --- | --- | --- | --- |
| Unknown Plugin or Operation | `404` | `PLUGIN_NOT_FOUND` | Omitted. |
| Valid private `400` | `400` | `PLUGIN_INPUT_REJECTED` | `plugin_code`, plus `plugin_details` only when the Plugin supplied details. |
| Plugin cannot be invoked | `503` | `PLUGIN_UNAVAILABLE` | `reason_code`. |
| Descriptor deadline expires | `504` | `PLUGIN_TIMEOUT` | Omitted. |
| Valid private `500` | `502` | `PLUGIN_FAILURE` | `plugin_code`, plus `plugin_details` only when the Plugin supplied details. |
| Invalid or oversized private response | `502` | `PLUGIN_FAILURE` | `reason_code: "invalid_response"`. |

For `PLUGIN_UNAVAILABLE`, `reason_code` is one of the five discovery reasons above, `starting`, or `capacity_exhausted`. `capacity_exhausted` appears only in an Operation error and never changes or appears in `GET /plugins` status. Malformed or oversized public requests continue to use Core's existing `INVALID_JSON`, `BODY_TOO_LARGE`, or `VALIDATION_ERROR` responses. Caller disconnection cancels the private request and produces no response for that caller.

Operations are semantically read-only and side-effect free. They may query Atlas or an External source, including sources whose query API uses HTTP `POST`, but they do not mutate Atlas, change an External source, or start ongoing behavior. Durable changes use normal Core writes, and ongoing actions use Tool Tasks. Core cannot infer side effects from opaque JSON, so Plugin code owns compliance with this contract. The live delivery transport for Datastreams remains open until a real stream establishes its ordering, replay, and latency needs.

## External-source access

A private Source Gateway container hosts named Source connectors for all Plugins. It is part of the Compose-managed Atlas deployment and has no public API. Core does not proxy external-source traffic, and Plugins do not receive External source credentials.

### Private Gateway protocol

Deployment configuration gives every Plugin one private `http` or `https` Source Gateway origin with no path, query, fragment, or credentials. Connector IDs use the same grammar as Plugin IDs. A Plugin makes one kind of call relative to that origin:

```text
POST /connectors/{connector_id}/requests
```

The request uses `Content-Type: application/json` and `Accept: application/json`. Its body has exactly these fields:

```json
{
  "plugin_to_source_gateway_protocol_major": 1,
  "method": "GET",
  "path": "/v1/aircraft",
  "query": [["bbox", "42.0,-72.0,43.0,-71.0"]],
  "headers": [["accept", "application/json"]],
  "body_base64": null
}
```

`plugin_to_source_gateway_protocol_major` is a positive integer and is exactly `1` for the first independent-release
contract. The implemented v1 request does not yet send this field. After migration, a missing or unsupported value is a
malformed request and produces HTTP `400` with `request_rejected`. `method` is an uppercase HTTP method. `path` begins
with `/` and contains no scheme, authority, query, or fragment. The path and query tuple strings are decoded UTF-8 text,
never pre-encoded URL text. The Gateway evaluates connector policy against those decoded values, rejects NUL, backslash,
and `.` or `..` path segments, then percent-encodes UTF-8 bytes exactly once. A literal `%` is data and becomes `%25`.
The Gateway preserves slash boundaries, query tuple order, and repeated query names; it encodes query spaces as `%20`,
not `+`. `query` and `headers` are arrays of two-string tuples so repeated names are preserved; the Gateway adds the
configured origin and credentials itself. `body_base64` is `null` for an empty body or the standard padded base64
encoding of the request bytes. The connector body limit counts decoded request bytes, while a separate hard Gateway
limit bounds the complete JSON request. The Gateway rejects unknown fields, malformed tuples or base64, disallowed
methods, paths, queries, or headers, credential-header overrides, and requests over its configured header or body limits.

Each connector configuration contains request and response header-name allowlists. The Gateway compares HTTP header names case-insensitively and emits response names in lowercase. It preserves repeated values as separate tuples in their received order. It always rejects Plugin-supplied `host`, `content-length`, `authorization`, `proxy-authorization`, `cookie`, and every configured credential header. In both directions it removes `connection`, every header named by `Connection`, `content-length`, `keep-alive`, `proxy-authenticate`, `proxy-authorization`, `proxy-connection`, `te`, `trailer`, `transfer-encoding`, and `upgrade`. It also removes `authorization`, `cookie`, `set-cookie`, and every configured credential header from responses. The Gateway sets `Host` and `Content-Length`, injects connector credentials, and forwards only remaining allowlisted headers. Hard limits bound the tuple count and total decoded header-name and value bytes in each direction.

A valid upstream HTTP response always becomes HTTP `200` from the Gateway, including an upstream `3xx`, `4xx`, or `5xx`. The JSON body has exactly `status`, `headers`, and `body_base64`; `status` is the upstream status, `headers` preserves allowed repeated response headers as two-string tuples, and `body_base64` contains the standard padded base64 encoding of the complete bounded response body.

Gateway failures use `Content-Type: application/json` and a body containing only `code`:

| Gateway status | `code` | Meaning |
| --- | --- | --- |
| `400` | `request_rejected` | The request is malformed, disallowed, or over a request limit. |
| `404` | `unknown_connector` | The connector ID is not configured. |
| `413` | `response_too_large` | The upstream response exceeded the connector or Gateway limit. |
| `502` | `upstream_unreachable` | The Gateway could not reach the selected upstream address. |
| `503` | `circuit_open` | The connector circuit breaker rejected the request. |
| `503` | `admission_timeout` | The request expired while waiting for connector concurrency or rate-limit admission, before the next outbound attempt began. |
| `504` | `upstream_timeout` | The bounded upstream attempt timed out. |

The Gateway does not authenticate or identify individual Plugin callers. Compose limits the route to the private deployment network, and the trusted first deployment lets every Plugin use every connector. When a Plugin Operation or Task is cancelled, the Plugin cancels this private request; the Gateway cancels the outbound request, performs no later retry, and discards any response. Gateway and Plugin tests must exercise strict decoding, repeated query and header values, binary bodies, failure mapping, response bounds, and cancellation. The implemented v1 protocol has no version negotiation. An independent Plugin release declares the Plugin-to-Source-Gateway contract major it requires, and each private request repeats that major so the Gateway can reject an unsupported caller. The request carries one exact required major, which the Gateway checks against its explicit supported set; it does not negotiate a version.

Source connectors centralize mechanics shared across external systems:

- secret injection without revealing credentials to the Plugin or browser
- allowed hosts and outbound request policy
- timeouts and cancellation
- rate limits and concurrency limits
- caching and freshness policy
- retries and circuit breaking
- request metrics and failure status

Each Source connector pins its external origin and credentials. A Plugin identifies the connector and supplies a relative path, method, query, allowed headers, and body within configured limits. The Gateway rejects absolute URLs, origin overrides, and credential-header overrides. Before every connection, it validates the selected address against the connector's egress policy. Loopback, link-local, and private addresses are denied unless that connector explicitly allows them, and the connection uses only the validated address. The Gateway never follows upstream redirects; it returns each `3xx` response to the Plugin under the same bounded response rules. It does not translate vendor payloads into an Atlas-wide external-data schema. Each Plugin owns the meaning and shape of its source data.

The Gateway buffers the complete upstream response up to the connector's configured response-size limit, which counts raw body bytes before base64 encoding and cannot exceed a hard Gateway maximum. Separate hard limits bound allowed response-header bytes and the complete encoded Gateway response. Those limits must allow every permitted raw body and header set to fit its JSON envelope. The Gateway returns the upstream status and allowed response headers, and transports the raw response bytes in `body_base64`. It rejects an oversized response without returning a partial body. It does not require JSON, stream partial data, or wrap data in a normalized external-data envelope. Core's private Plugin response limit applies later, after the Plugin maps source data into an Operation JSON result, and does not limit Gateway responses.

Every source-backed Plugin result must carry enough source provenance and freshness information for callers to judge it. This requirement applies when the Plugin returns the result from an Operation or future Datastream and when it writes the result through the Atlas SDK. The Plugin owns the result-specific fields; the Source Gateway does not add a common metadata envelope.

Caching is disabled unless connector configuration enables an in-memory time-to-live cache for specific upstream endpoint and method combinations whose provider contract declares responses safe to reuse. The Gateway never caches a request that may mutate upstream state. The cache key covers the complete outbound request, including the connector, method, relative path, query, allowed headers, and body. In addition to the per-response limit, the cache has hard Gateway-wide byte and entry caps. Cache admission evicts entries rather than exceeding either cap. Cached data is disposable and is lost when the Gateway restarts.

Connector configuration declares retry safety for specific upstream endpoint and method combinations, plus the failure or response statuses that allow another attempt. The Gateway applies only bounded retries under those rules. A request that may mutate upstream state is retryable only when the connector rule requires a provider-supported idempotency key and the request supplies it. The Gateway never treats a method alone as proof that a request is safe to retry. It maintains one circuit breaker per connector.

The Gateway owns fixed failure categories for an unknown connector, rejected request policy, admission timeout, upstream timeout, oversized response, open circuit, and unreachable upstream. It does not return raw network or connector errors. A valid upstream HTTP response is not a Gateway failure, even when its status represents a vendor error. The upstream attempt completes when the Gateway has buffered the bounded response body. Later local header filtering, encoding, or response cleanup cannot turn that buffered response into `upstream_timeout`, though caller cancellation still discards it. The Gateway returns the upstream status, allowed headers, and bounded response body for the Plugin to interpret.

A Source Gateway failure degrades Plugins that depend on External sources. It does not change Core liveness or readiness. All installed Plugins are trusted and may use every configured connector. Connector access is not a Plugin capability and requires no per-Plugin grant. The first Compose topology does not sandbox Plugin outbound networking or prevent a trusted Plugin from making a direct outbound request. Using the Gateway for external-source access is an implementation requirement, not a containment boundary. Supporting untrusted Plugin images would require enforced egress isolation.

Deployment configuration defines connector IDs, external origins, request limits, and secret references. The Gateway resolves secret references from environment variables or Compose secrets at startup. Core, Atlas resources, and Plugins do not store those credentials. Changing connector configuration restarts the Gateway.

## Atlas access

Plugins may need to read Atlas data or request Atlas mutations. They never access the database directly. Core remains responsible for validation, authorization, idempotency, persistence, and the change feed.

Plugin code uses the ordinary Atlas SDK with a full-access managed API credential. Core applies the same authentication, validation, and resource rules it applies to any SDK client, but it does not enforce Plugin-specific capabilities. Plugin code owns its own safety and limits which SDK methods it calls.

Today's full-access managed API keys satisfy this contract. All Plugins share one full-access Plugin API key supplied
through deployment configuration. The host manager provisions and transactionally rotates that key. Atlas does not
currently persist an actor on Entities, Tasks, Objects, or feed events, so the Plugin architecture adds no Plugin-specific
provenance or audit model.

## Execution and failure isolation

The deployment orchestrator starts one trusted container per configured Plugin. In the current bundled Atlas deployment, Docker Compose owns startup, restart policy, resource limits, and shutdown. The independent manager keeps Compose ownership but fixes every retained base service and generated Plugin service to `restart: "no"`. Docker daemon and host restarts leave Atlas stopped until `atlas-core start` performs transaction recovery and validation. Core does not receive Docker socket access and does not create, upgrade, or delete containers.

Deployment configuration gives Core each Plugin's stable ID and private base URL. Core uses a fixed HTTP/JSON protocol to fetch its manifest and health, dispatch Operations, and report status. Plugins do not self-register, and Core does not scan Docker or the network for them. Either side may start first; Core keeps retryable Plugin failures out of base liveness and readiness.

### Private HTTP protocol

A configured Plugin base URL is a plain `http` origin with no path, query, fragment, or credentials. Core makes only these private calls relative to that origin:

| Request | Purpose |
| --- | --- |
| `GET /manifest` | Fetch immutable discovery data for this Core process. |
| `GET /health` | Read Plugin application health. |
| `POST /operations/{operation_id}` | Invoke one advertised Operation. |

Core sends `Accept: application/json` on every call and `Content-Type: application/json` for an Operation. A private response is valid only when it uses `application/json` and contains one complete JSON value within Core's response-size limit.

`GET /manifest` succeeds only with HTTP `200` and this JSON shape:

```json
{
  "plugin_id": "adsb",
  "display_name": "ADS-B",
  "core_to_plugin_protocol_major": 1,
  "operations": [
    {
      "operation_id": "inspect_aircraft",
      "display_name": "Inspect aircraft",
      "timeout_ms": 5000,
      "interaction": { "kind": "map_area" }
    }
  ],
  "tool_asset_id": "plugin_rfSey5Te4YU6Prz-hpGcwRnuSBuF9z1COTHZJt_s0G4"
}
```

`plugin_id`, `display_name`, `core_to_plugin_protocol_major`, and `operations` are required, and each display name is a
nonempty string. Initial independent releases require major `1`; a later Core may explicitly support more than one major
during a transition. The implemented v1 manifest does not yet send this field. After migration, a missing or unsupported
value invalidates the manifest and uses Core's existing `invalid_manifest` status reason. This private transport field
stays outside the generated Atlas Protocol `PluginManifest` shape and revision token. `tool_asset_id` is optional and
omitted for a query-only Plugin. Each
Operation requires `operation_id`, `display_name`, and a positive integer `timeout_ms`, measured in milliseconds and no
greater than Core's hard maximum. An Operation may also declare the fixed, non-executable interaction descriptor
`{ "kind": "map_area" }`. Core validates this descriptor and continues to proxy Operation bodies as opaque JSON. The
operations array may be empty. Core rejects unknown fields in the manifest or an Operation descriptor, invalid
identifiers, duplicate Operation IDs, invalid timeouts, identity mismatches, and any status other than `200`.

`GET /health` has two valid responses. HTTP `200` with `{"status":"ok"}` is healthy. HTTP `503` with `{"status":"unhealthy"}` is an application-level health failure. Any other status or body is an invalid private response and a transport failure. Health has no detail field; Plugin logs own private diagnostics.

The private Operation request body is the public request's validated JSON value with no wrapper. Core interprets private Operation responses as follows:

| Status | Body | Public result |
| --- | --- | --- |
| `200` | Any JSON value | Return that value as the Operation result. |
| `400` | Plugin error object | Map to `PLUGIN_INPUT_REJECTED`. |
| `500` | Plugin error object | Map to `PLUGIN_FAILURE`. |

A Plugin error object contains a required `code` matching `^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$`, an optional JSON `details` value, and no other fields. Any other status, invalid error object, invalid JSON, or oversized body maps to Plugin failure and makes transport unavailable. A valid `400` or `500` response proves transport is reachable and does not change application health. Core never proxies the private status or raw body. Connection failure maps to an unavailable Plugin, and the descriptor deadline maps to timeout. Core cancels the private HTTP request on caller cancellation or timeout.

Core applies a hard response-size limit to every private Plugin call, including manifest, health, and Operation responses. An oversized response is invalid and makes the Plugin unavailable without Core buffering beyond the limit.

Core fetches each configured Plugin manifest during startup. If the Plugin is unavailable, Core continues starting and retries until the first successful manifest response. Before caching it, Core requires the manifest's Plugin ID to match the configured Plugin ID exactly and any advertised Tool Asset ID to match the value derived from that Plugin ID. A mismatch is an invalid manifest and keeps the configured Plugin unavailable. Core caches a valid matching manifest in memory until Core restarts. A valid cached manifest is an independent availability prerequisite that health or Operation responses cannot replace. After caching the first valid manifest, Core immediately checks Plugin health. Core does not refresh manifests periodically or fetch one for every request. Plugin upgrades may restart the existing deployment, so manifest changes do not need hot reload.

The implemented v1 private Plugin protocol has no revision field, version negotiation, or compatibility layer. The
independent release design replaces that assumption with one required major checked against Core's supported-major set,
without negotiation. The release document declares the required Core-to-Plugin major, and the private runtime manifest
repeats it so Core rejects an unsupported Plugin even when deployment configuration bypasses the manager. The CLI also
rejects an incompatible release before deployment. A release that calls Core through the Atlas SDK declares the exact
generated Atlas Protocol revision it requires; the manager compares that declaration with the deployed Core before
changing Plugin state.

The first architecture has no separate Plugin Definition and Plugin Instance concepts. One configured Plugin ID maps to one deployment-managed container, whose Plugin may be `starting`, `available`, or `unavailable`. A Plugin may handle multiple concurrent requests or monitored areas internally, but Atlas does not schedule multiple active instances of the same Plugin.

## Managed deployment and upgrades

Package schema 1 has no Plugin setting or secret injection model. The manager supplies only fixed platform values: the
private Source Gateway origin and, for SDK-using Plugins, the private Core origin plus one shared deployment-owned managed
API key. A release cannot provide or override them. A later package-schema major may add Plugin settings when a concrete
Plugin requires them. The menu can transactionally rotate the shared Core key, including after an administrator revokes
it, without adding per-Plugin configuration. Runtime operator intent still uses Operations or Tasks.

The host-side Atlas Core CLI manages Installed Plugins from one signed Atlas catalog. Each Plugin release has its own
version and workflow. Its strict `.atlas-plugin` JSON document pins one multi-architecture image by digest and declares
the private contract majors, optional Atlas Protocol revision, and fixed Command Interface interactions it requires.
Release metadata and runtime discovery stay separate: the release document does not duplicate Operations from the
private runtime manifest. The CLI regenerates deployment configuration from retained release documents and the installed
Core bundle's hash-verified generation templates before every start, validates the complete Compose model, and verifies
running image identity against durable selected and previous image receipts. Enable, enabled-Plugin update,
enabled-Plugin rollback, and Core update transactions wait for Plugin health before commit and roll back on failure. A
normal start waits only for base Atlas readiness while Core reports Plugin status asynchronously. Fresh initialization
temporarily starts the exact base composition under its recovery journal to create the managed Plugin key, then returns
Atlas to stopped state. The manager never passes arbitrary Plugin-supplied Compose, templates, or executable installation
hooks to the host.
If retained bundle bytes or images are lost, explicit repair-start flags restore only the recorded Core package bundle
and exact image digests. Repair never selects a newer Core or Plugin release.

Installation, enablement, and runtime health are separate. Installing selects and retains a Plugin release. Enabling
includes that Installed Plugin in the deployment. Disabling removes it from the active deployment without uninstalling
the selected release. Uninstall requires the Plugin to be disabled and then removes its selected release. The manager
retains the selected release and one previous release. A failed Plugin update restores the previous release
automatically, and the operator may roll back explicitly to that previous release when it remains compatible and
non-revoked. The first managed scope is trusted query-only Plugins, and every update requires operator approval.
Production restarts preserve durable Core storage.

The CLI embeds versioned Atlas Plugin catalog public keys and a minimum catalog checkpoint. Atlas signs the exact catalog
bytes with Ed25519. A protected append-only ledger preserves release hashes and one-way revocations before GitHub Pages
publishes the signed bytes. Each signed catalog entry pins the exact `.atlas-plugin` byte hash, and that release document
pins the image digest. The manager atomically stores its accepted catalog and anti-rollback receipt. A catalog entry may
revoke an immutable release. The manager refuses new installation, enablement, update, or manual rollback to a revoked
release. It warns about an already Installed revoked release but does not stop it without operator approval.
If the selected release is revoked, an approved update may choose the greatest compatible non-revoked release even when
that requires a version downgrade. It never reports a revoked selection as current.

Plugin versions are immutable Semantic Versions in one stable channel. A release workflow publishes and verifies the
image and `.atlas-plugin` document before it appends the release to a newly signed catalog. A failed catalog publication
may leave unlisted artifacts, which have no installation path and may be reused by a retry. A published version is never
replaced. Plugins do not depend on other Plugins; every release depends only on declared Atlas contracts, fixed Command
Interface interactions, and configured Source connectors.

## Health, readiness, and status

`GET /health` remains Atlas Core liveness only. `GET /readiness` remains limited to dependencies required for Core to serve its base contract.

`GET /plugins` includes authenticated status for every configured Plugin with `starting`, `available`, or `unavailable` status. `starting` means Core has not completed its first manifest attempt, or it has cached the first valid manifest and is waiting for the immediately triggered initial health result. `available` means Core has cached a valid matching manifest, Plugin transport is reachable, and its latest health response is OK. `unavailable` means the manifest prerequisite failed, transport failed, or the latest health response reported an application-level failure. Status includes the time of the latest check and a stable Core-owned reason code. It never includes private URLs, raw health responses, credentials, or upstream response bodies.

After the initial health result, Core checks Plugin health on one fixed internal cadence. A connection failure, a manifest or health timeout, or an invalid private response makes the Plugin transport unavailable immediately. Any subsequent valid manifest, health, or Operation response restores transport availability immediately, even when the Operation rejects its input, reports a handled failure, or health remains non-OK. Transport recovery cannot replace a valid cached manifest. A descriptor deadline, caller-initiated cancellation, or capacity rejection affects only that Operation invocation. Transport recovery does not clear an application-level health failure; only a later OK health response does. Core maps a non-OK health response to a stable `application_unhealthy` public reason without exposing its private detail. After Core caches a manifest, discovery continues to show its Operations while the Plugin is unavailable, but invocation fails. An optional Plugin failure does not make Core unhealthy or unready.

Core owns the public Operation `ErrorResponse` and uses the exact HTTP status, `error_code`, and `details` mapping above. It does not proxy the Plugin's private HTTP status or raw error body. A valid Plugin error object contributes only `plugin_code` and optional `plugin_details` to the authenticated public details.

## Command-interface integration

The Command Interface never loads executable UI code from Plugins. It discovers fixed `map_area` interaction metadata
through `GET /plugins` and provides one generic rectangle and spatial-result runner for every Operation that advertises
that interaction. The shared runner validates the Protocol `MapArea` and `SpatialOperationResult` contracts, renders
Polygon and MultiPolygon results, and displays generic fields, truncation, provenance, freshness, and attribution. It
does not branch on Plugin IDs, Operation IDs, or providers. Other declarative interaction kinds need a concrete shared
contract before they are added. Arbitrary Plugin-provided JavaScript remains deferred.

A Plugin that operators need to task may register an ordinary Asset with `entity_type: "asset"` and `subtype: "tool"`. Query-only Plugins do not need a Tool Asset. Tool Assets use the existing runtime, Task, and Command systems.

The Plugin derives its Tool Asset ID with the manifest derivation above and performs an idempotent get-or-create through the Atlas SDK during startup. It creates a missing Entity as an `asset` with subtype `tool` and the exact ownership component `"custom_plugin": {"plugin_id": "<plugin_id>"}`. The component must be an object with only `plugin_id`, whose value follows the Plugin ID grammar. The Plugin reuses an existing Entity only when its type, subtype, and parsed `plugin_id` all match; JSON object key order is irrelevant. That ownership check also handles the theoretical case where different Plugin IDs derive the same Entity ID. Any mismatch is a conflict, so the Plugin refuses runtime registration and returns a non-OK private health response until an operator corrects it. Core re-reads and validates the stored component during runtime registration, then extends its existing action-level runtime identity guard so `entity_type`, `subtype`, and `custom_plugin.plugin_id` cannot change after registration. That guard covers every component mutation path, including Entity PATCH and check-in. Core performs the same validation before applying the configured-Plugin deletion guard. Disabling the Plugin removes it from deployment configuration but retains its selected release. Uninstall is a separate host-manager action that deletes retained release state after the Plugin is disabled. After disablement and Task terminalization, an operator may delete its Tool Asset.

Plugin commands remain dedicated, Protocol-authored Atlas Commands, such as `sensing.scan_area`. A Plugin runtime manifest may advertise the subset it implements, but it cannot extend the production Command Catalog. Adding taskable Plugin behavior therefore remains a coordinated Atlas change with a Command schema, semantics, execution handler, and purpose-built Command Interface input. Plugin installation does not inject commands or generic forms into the browser.

Long-running Plugin commands use `immediate` scheduling when several Tasks must execute at once. The existing Protocol contract lets an Asset manifest choose `queued` or `immediate` when the Command definition omits scheduling. Core resolves scheduling from the Command Catalog when the Command declares it and otherwise from the stored runtime manifest entry. Core must use that same resolved value for manifest validation, Task creation, deliverable selection, acknowledgement and start transitions, ordering, and immediate-start timeout reconciliation. It must not default an omitted catalog value back to `queued` after accepting the manifest choice. Multiple immediate Tasks begin in tasking order without waiting for one another to finish. A monitoring Task remains `in_progress` for the monitoring session and declares `supports_cancel: true`. Cancelling the Task is the operator's stop action. Core marks it `cancelled` and aborts that Task's Plugin handler. The Plugin must stop work promptly after observing the abort, but Atlas does not wait for a second shutdown confirmation. Atlas has no separate "queueing off" setting.

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
- Core caps in-flight Operations per Plugin, rejects excess requests without queueing, and leaves Plugin status unchanged.
- Docker Compose or the deployment orchestrator starts one trusted container per configured Plugin; Gateway use is an implementation requirement rather than a Plugin egress sandbox.
- Deployment configuration explicitly maps one path-safe Plugin ID to one private Plugin base URL, and each manifest uses unique path-safe Operation IDs.
- Core communicates with Plugins through fixed private manifest, health, and Operation HTTP/JSON routes; Plugins do not self-register.
- Atlas does not model multiple active instances of one Plugin.
- Plugin code uses the ordinary Atlas SDK with full access; Core does not enforce Plugin-specific capabilities.
- All Plugins share one full-access Plugin API key that the host manager can rotate transactionally.
- Fresh initialization temporarily starts the exact pull-disabled base composition under a finish-forward journal to create the managed Plugin key, then returns Atlas to stopped state.
- Installed state retains selected and previous platform-manifest digests and local image IDs; disposable active files never define expected image identity.
- Retained base services and generated Plugin services use `restart: "no"`; Docker daemon or host restart cannot bypass manager recovery.
- A taskable Plugin may register a Tool Asset with `entity_type: "asset"` and `subtype: "tool"`; query-only Plugins need no Asset.
- A taskable Plugin creates or ensures its own Tool Asset through the SDK during startup and records its Plugin ID as the strict `custom_plugin.plugin_id` ownership component.
- A Tool Asset ID is `plugin_` plus the unpadded base64url encoding of the full SHA-256 digest of its Plugin ID; Core keeps its type, subtype, and ownership marker immutable across PATCH, check-in, and every other mutation path after runtime registration.
- An advertised Tool Asset ID must match the value derived from the manifest's Plugin ID.
- Core rejects deletion of a Plugin-owned Tool Asset while its Plugin remains configured.
- Tool Assets implement dedicated Protocol-owned Commands rather than Plugin-defined Commands.
- When catalog scheduling is omitted, every Core lifecycle decision uses the scheduling declared by the stored runtime manifest; long-running Plugin Tasks may therefore use `immediate` scheduling so several Tasks can overlap.
- Plugin Task cancellation uses the existing terminal cancellation and handler abort without a second confirmation.
- A graceful Plugin runtime stop fails active Tasks with `asset_stopped`; replacement fencing uses `asset_restarted`. Plugins do not resume them automatically.
- A private Source Gateway container hosts Source connectors for all Plugins.
- Source connectors pin external origins, validate each selected address against connector egress policy, accept bounded relative requests through the fixed private Gateway protocol, apply configured header allowlists plus fixed forbidden headers, and do not follow upstream redirects.
- Every installed Plugin may use every configured Source connector.
- Core endpoint and Source Gateway configuration is deployment-owned; Source Gateway secrets come from environment
  variables or Compose secrets.
- Plugin containers have no persistent private storage in the first architecture.
- Independent Plugin releases declare a package schema, required Core-to-Plugin and Plugin-to-Source-Gateway majors, an
  Atlas Protocol revision when they use the SDK, and fixed Command Interface interactions. The CLI checks compatibility
  before deployment, and runtime peers repeat and enforce their private protocol majors without negotiation.
- Core and Source Gateway record sets of supported private majors so a release can support both sides of a transition.
- The existing Atlas Protocol revision check between the SDK and Core remains unchanged and is enforced before managed
  deployment when a Plugin declares an SDK dependency.
- Each trusted first-party Plugin has its own version and release workflow while its source remains in this repository.
- The Atlas Core CLI manages Plugins from one signed Atlas-published catalog. Arbitrary catalogs, bundles, and images are
  not supported in the first managed release.
- A Plugin release is a strict UTF-8 JSON `.atlas-plugin` document that pins its multi-architecture container image by
  digest. The document cannot provide executable installation hooks or arbitrary Compose configuration.
- Installation, enablement, and runtime health are separate states. The existing `available` status remains a runtime
  health term and does not mean catalog presence.
- Plugin updates are operator-approved and may restart the existing deployment without changing the Atlas Core version.
- Restart-capable Plugin operations use the installed Core's retained Compose bundle and exact image rather than assets
  from a newer host CLI.
- The manager retains the selected and previous Plugin releases, restores failed updates, and supports explicit rollback
  only to a compatible, non-revoked previous release.
- Package schema 1 has no general Plugin setting or secret lifecycle. The CLI owns the fixed Core and Source Gateway
  connection values that managed Plugin containers need.
- One Ed25519-signed Atlas catalog authenticates exact release-document hashes and image digests. Revocation prevents new
  use of a release but does not stop an Installed Plugin without operator approval.
- The catalog comes from a protected append-only ledger, uses ordered key epochs with per-epoch sequence floors, and is
  cached with one atomic anti-rollback receipt.
- Plugin releases use immutable Semantic Versions in one stable channel and cannot depend on other Plugins.
- Independent installation, update, and uninstall initially support trusted query-only Plugins. Taskable-Plugin
  lifecycle management remains deferred.
- The first independent Core release requires bundled-v1 Plugins to be disabled and reinstalled from the signed catalog;
  Atlas does not infer a signed release receipt for their old local images.
- A Plugin manifest contains Plugin and Operation discovery fields plus its private Core-to-Plugin contract major;
  Datastreams, Commands, configuration, credentials, release versions, and upgrade metadata stay elsewhere.
- The private Core-to-Plugin and Plugin-to-Gateway protocols fix endpoint paths, JSON or binary framing, bounds, cancellation, and error mapping.
- Core fetches a Plugin manifest once, retrying until success, and caches it until Core restarts.
- Core bounds every private Plugin response and rejects a manifest whose Plugin ID differs from deployment configuration or whose Tool Asset ID differs from the value derived from that Plugin ID.
- Operations are side-effect-free synchronous JSON calls with Plugin-owned validation, bounded request and response bodies, bounded per-Operation timeouts, and propagated cancellation; longer work uses Tool Tasks.
- Core maps Operation failures into five Plugin-specific Protocol error codes; `capacity_exhausted` appears only in authenticated `PLUGIN_UNAVAILABLE` details and does not change discovery status.
- Every configured Plugin remains discoverable with `starting`, `available`, or `unavailable` status; `starting` lasts through the immediately triggered initial health result after the first valid manifest.
- Authenticated status uses one exact `GET /plugins` response schema with nullable pre-manifest discovery fields and five Core-owned unavailability reason codes.
- Core checks Plugin health immediately after the first valid manifest and then on a fixed internal cadence. Any valid manifest, health, or Operation response restores transport availability immediately, while a valid cached manifest remains an independent prerequisite and a non-OK health response keeps the Plugin unavailable until a later OK health response.
- The Source Gateway buffers complete responses and returns upstream status, allowed headers, and raw bytes under explicit raw-body, header, and encoded-envelope limits.
- Source Gateway caching is disabled by default; a connector may enable a disposable in-memory time-to-live cache only for explicitly safe endpoint and method combinations. Mutating requests are never cached, and hard Gateway-wide byte and entry caps bound the cache.
- Source Gateway retries are bounded by connector-declared endpoint and method rules. A request that may mutate upstream state also requires a provider-supported idempotency key.
- The Source Gateway returns fixed failure categories; valid upstream HTTP responses remain responses for the Plugin to interpret.
- The architecture specifies bounds and behavior, not numeric defaults. Implementation chooses and tests the initial response limits, timeout ceilings, health cadence, and per-Plugin in-flight Operation limit.
- Plugins do not expose external APIs directly as Datastreams.
- Source connectors unify access mechanics, not external data models.
- Source-backed Plugin results carry enough provenance and freshness information for callers to judge them.
- Durable results use normal Atlas Entity and Object systems.
- Plugin status does not change Core liveness.
- Fixed `map_area` interaction metadata is implemented; executable UI plugins remain deferred.
- The Datastream delivery contract and reserved delivery route are deferred until a concrete use case needs them.

## Design status

The runtime Plugin platform, independent release format, catalog, installation lifecycle, compatibility checks, and
failure recovery are settled. The design tree for independent trusted query-only Plugin management is closed. The
documents specify behavioral bounds but leave health cadence, timeout ceilings, response limits, the per-Plugin
in-flight Operation limit, retry counts, cache durations, and circuit-breaker thresholds to implementation.

Datastream delivery, executable browser plugins, additional declarative interaction kinds, arbitrary third-party
installation, taskable-Plugin lifecycle management, and ADS-B Track identity remain deliberately deferred. Each needs a
concrete use case or Plugin design before Atlas should decide it.
