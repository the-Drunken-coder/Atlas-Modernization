# Link service interface

The Meshtastic Link service is one long-running local service per participating machine. It is the only process that owns the Meshtastic radio and Shared Picture.

One TypeScript and Node 24 Link service implementation supports explicit `asset` and `gateway` modes. Both modes use the same radio configuration, transport, queues, Shared Picture, simulation boundary, and local interface. Asset mode joins through the Gateway. Gateway mode loads Gateway-owned membership and admits Assets. Atlas Core access remains in the separate Gateway application.

## Clients and transport

Multiple Link clients may connect simultaneously. The initial interface is loopback-only JSON so Asset software may be written in TypeScript, Python, or another language without embedding the radio implementation.

The interface provides request-response operations for commands from local clients and a one-way live event stream from the Link service. A simple HTTP interface with server-sent events is the preferred implementation unless testing finds a concrete limitation.

The generated radio-facing SDK preserves Atlas Protocol resource types, operation names, inputs, outputs, and validation. It adapts completion to an asynchronous radio link rather than pretending to be a synchronous Core HTTP connection. A write or request returns an operation ID immediately; confirmation, response, rejection, or timeout arrives through the event stream and remains queryable by that ID. Query operations retain Atlas pagination so one request cannot silently produce an unlimited radio response.

For operation and service events, `GET /v1/events` without `after` starts with future events. An explicit `after` replays retained events and rejects expired cursors. After expiry, clients may query their operation IDs and open a fresh stream. Picture changes use the snapshot cursor handoff described below.

## Logical capabilities

The loopback interface must support:

- Read the current Shared Picture
- Follow picture additions, changes, staleness, and removals in real time
- Read Link service, Gateway, radio, and joining status
- Publish the local Asset's supported state and Task lifecycle reports
- Start a data request and observe its response or failure
- Add, renew, and remove local Link subscription demand
- Read bounded operational metrics and diagnostic summaries
- Enqueue one Task assignment or cancellation for an Asset in order
- Enqueue an ordered Task assignment batch after complete validation
- Reconcile a terminal authoritative Task observation and read per-Asset dispatcher state

Raw Meshtastic packets, transfer fragments, and radio-management commands are not part of the normal client interface.

The same loopback interface also exposes validated Radio profile inspection, mutation, apply, and verification operations. The CLI uses these operations rather than opening the radio independently. The companion computer is the trust boundary; the local interface does not add a separate configuration credential system. Mutation routes reject browser-originated requests so an unrelated web page cannot drive the loopback service through cross-origin form or fetch requests.

## Snapshot and live changes

A client may read the Link service's current in-memory Shared Picture immediately and then follow later changes. Serving this local snapshot causes no radio transmission and is distinct from asking the Gateway for a startup state dump.

The snapshot-to-stream handoff must be gap-free. The Link service maintains a monotonically increasing picture revision for its service session. A snapshot returns the service session identity, its atomic picture revision, and records from that revision. The event stream accepts that position and delivers every later picture change in revision order.

The service retains a bounded handoff buffer. If a requested revision is no longer available, or belongs to a prior service session, it rejects the cursor and requires a new snapshot. It never silently starts at the newest event after losing changes between the snapshot and stream connection. Exact routes and buffer limits remain implementation choices.

Every picture record exposes provenance and freshness. Clients may filter the returned state for their own use, but they do not mutate the Shared Picture.

## Explicit writes

Clients never edit picture records directly. They use explicit operations to:

- Publish an observation or current Asset state
- Report Task acknowledgement, progress, cancellation handling, or outcome
- Request Atlas data
- Subscribe or unsubscribe from a Gateway feed

Gateway clients submit Core-derived Task resources through the loopback Task boundary. The Link service creates one ordered dispatcher for its attached Gateway transport. `POST /v1/tasks/:asset_id` accepts `{ task, delivery }` for one assignment or cancellation, `POST /v1/tasks/:asset_id/assignments` accepts `{ tasks }` for an ordered assignment batch, `POST /v1/tasks/:asset_id/authoritative` accepts `{ task }` for a terminal authoritative observation, and `GET /v1/tasks/:asset_id` returns local dispatcher state with the in-flight Task and `in_flight_operation_id`, an optional `cancellation` object containing its `task_id` and `operation_id`, and queued Task IDs. Each Task must match the route Asset ID; a batch is validated in full before enqueue; and `POST /v1/messages` rejects `task_delivery` messages so callers cannot bypass ordering. The state route reports local queue and operation identity, not Core authority or Task execution.

After a delivery timeout, the Task remains an ordering barrier. The Gateway application rechecks Core and explicitly enqueues that same Task again through the single or batch route when another attempt is appropriate. The dispatcher assigns a fresh Link operation ID and keeps later assignments blocked until application acceptance, rejection, or an authoritative terminal observation. Clients use the returned operation IDs with the operation endpoint and event stream to follow each attempt.

The Link service validates and sends the corresponding Atlas message. Eligible state received in response may subsequently update the Shared Picture through the normal receive path.

The Asset application owns when it invokes these publication operations. The Link service does not create position, Track, telemetry, health, or Task-progress schedules. It may coalesce older unsent best-effort state under congestion, but this queue behavior is not a substitute for the Asset's publication policy.

Before accepting a confirmed operation, the Link service reserves the bounded queue and tracking state required to follow it through confirmation, rejection, or deadline failure. If that reservation is unavailable, the local call fails immediately with an overload result. Acceptance never means an operation was placed into an untracked best-effort queue.

## Asynchronous requests

Starting a radio data request returns a request ID without blocking the local program. Completion, rejection, or timeout is delivered through the event stream and is queryable by request ID.

If the request requires an unavailable Gateway, the Link service fails it promptly. It does not keep the request for surprise execution after reconnection. The existing Shared Picture remains readable while disconnected.

Pending Link operations and transmission queues do not survive a Link service stop or restart. The old Link service fails its pending local callers, and the replacement Link service rejoins with empty queues. Authoritative Asset or Core state determines whether work must be resubmitted or reconciled. Task IDs and Core operation identities provide application-level duplicate protection when work crosses a Link service restart.

## Local subscription aggregation

The Link service tracks demand from each connected local client and sends only one Link subscription for each canonical feed selector. One client's unsubscribe removes only that client's demand. The Link service removes its Link subscription after no local client still wants the feed.

Local clients renew their demand at least every thirty seconds. The Link service expires all demand for a client after ninety seconds without an add or renewal, while a detected event-stream disconnect starts the shorter connection cleanup interval. A client using only request-response calls or the picture stream therefore still releases demand after it vanishes.

## Diagnostics

The normal interface exposes useful link status, request outcomes, queue state, and bounded metrics. A separate diagnostic path may expose raw radio and transport evidence for development and field investigation. Asset behavior must not depend on raw packets.
