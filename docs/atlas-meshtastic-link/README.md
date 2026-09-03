# Atlas Meshtastic Link

This document is the completed discovery record and governing architecture for the Atlas communication method implemented in [`packages/meshtastic-link`](../../packages/meshtastic-link/README.md). Hardware calibration and the separate Gateway and Asset application integrations remain distinct follow-on work where noted.

## Confirmed starting point

- Meshtastic Link is for Atlas Modernization.
- A shared Meshtastic channel should let every participating radio receive useful Atlas state and build a common situational-awareness picture.
- The first field network is small: roughly five radios and no more than three radio layers between endpoints.
- Additional airtime from shared publication is acceptable when it materially improves the common picture.
- Subscription behavior should limit what Atlas Core state the gateway proactively publishes. A state update needed by several assets should be transmitted once, not separately for each asset.

## Existing Atlas constraints

The current Atlas architecture already fixes these boundaries:

- Atlas Core owns durable, authoritative Atlas resources and Task state.
- An Edge Gateway bridges field communication methods to Atlas Core. It is not an Asset and does not perform Asset behavior.
- An Asset application owns physical behavior, safety, local autonomy, and Command handlers.
- A radio transport moves Atlas messages. It does not own Core access, task execution, or deployment policy.
- One logical Asset has one Asset Host. An attached Meshtastic radio is a peripheral, not another Atlas compute node.

Changing one of these boundaries requires an explicit project-level design decision.

## Accepted product decisions

### Link service and local access

A Meshtastic Link service runs continuously on every participating machine. It owns the local radio connection, fulfills data requests over the link, maintains the local Shared Picture, and exposes that picture to the Asset or Gateway application in real time.

The Asset application may use the Shared Picture as an input to its autonomous software. Receiving a radio message does not itself invoke physical behavior. The application decides how received state influences autonomy.

One Link service owns the machine's radio and serves multiple local Link clients through a loopback-only JSON interface. A client can read the current in-memory picture and then follow live changes without causing radio traffic. The snapshot returns a service session and picture revision, and the event stream resumes after that revision without a gap. The Shared Picture is read-only; publication, data requests, and Link subscriptions use explicit operations.

Data requests return a request ID immediately and finish asynchronously. A request that needs an unavailable Gateway fails promptly rather than remaining queued for execution after an unexpected later reconnection.

The Link service combines Link subscription demand from all local clients. One client ending its interest does not remove the Gateway feed while another client still wants it. Normal clients receive Atlas state, request results, link status, and useful metrics. Raw radio traffic remains diagnostic.

See [`service-interface.md`](service-interface.md) for the logical local interface.

### Radio configuration ownership

Meshtastic Link owns configuration of its attached radio. The starting assumption is Meshtastic 2.7.15 or a later tested release with no Atlas-specific setup.

At startup, the Link service reads the radio's settings, compares Atlas-owned fields with its desired static Radio profile, applies only required changes, reconnects after any device reboot, and verifies the result. Asset mode then clears old private-channel material before discovery. Gateway mode loads its durable membership without joining through itself.

Radio profiles are part of the Atlas system so modem settings, hop limit, role, rebroadcast behavior, channels, and related controls can be tuned through repeatable experiments. Manual undocumented setup is not part of deployment.

The development strategy prioritizes bandwidth over maximum range. Initial work uses Meshtastic's `SHORT_FAST` preset on Heltec V3 radios, with `SHORT_TURBO` available only as an explicit maximum-capacity experiment. Later higher-power radios improve the link budget while retaining the chosen modem bandwidth and application design. Slower, longer-range presets remain tuning options when measured capacity allows them.

Every supported radio uses the same static Radio profile. The profile does not differ between Gateway and Asset radios or between hardware models. Dynamic private-channel membership is a separate input and is not a profile overlay. Gateway and Asset are modes of the software on the companion computer, not Meshtastic radio roles. Hardware that cannot satisfy the common profile is unsupported.

Each Link service manages only its locally attached radio. Remote radio administration over the mesh is a non-goal because a flaky link is not a safe configuration path.

The Link service exposes one configuration system through both a command-line interface and its local programmatic API. Operators, automation, and AI agents can inspect desired and actual settings, change the desired profile, apply it, verify it, and collect configuration evidence without bypassing the Link service's ownership of the radio.

Changing a desired setting does not immediately disrupt a live radio. The caller inspects the resulting difference and explicitly applies it. Link service startup automatically applies the selected profile because starting the Link service is already an instruction to make the link operational.

The common profile is version-controlled deployment configuration distributed with the companion software. It contains no private-channel key. Experiments require an explicitly selected alternate profile and never mutate the normal field profile as a hidden side effect. The companion computer is the local trust boundary, so the CLI and loopback API do not introduce another authentication system for configuration changes.

If required settings cannot be applied and verified, the Link service does not join or transmit Atlas traffic. It exposes the exact mismatch and attempted changes through status, CLI output, and diagnostics.

The Link service does not enable Meshtastic Managed Mode because doing so would block its normal local configuration path. See [`radio-configuration.md`](radio-configuration.md) for the ownership boundary and lab-selected implementation details.

### Shared field bus

The first system uses one private Atlas channel as a shared field bus. Every member may receive and inspect routine Atlas traffic, including:

- Asset position, telemetry, and health
- Tracks and Track telemetry
- Geofeatures
- Atlas Entity and Object metadata selected for publication
- Task assignments, cancellations, progress, and outcomes
- Data requests and their responses when the contents are useful to the group

Application addressing determines which node acts or replies. A Task addressed to one Asset is visible to the entire channel, but only the addressed Asset may acknowledge or execute it.

Large Object contents and information with no shared situational value are not broadcast by default. They may still cross the link when explicitly requested or selected for delivery.

### Dynamic field joining

Dynamic field joining is a product goal. A new radio should be able to discover the Atlas mesh in the field and receive what it needs to join without having been loaded with the Atlas channel beforehand.

The initial threat model is a cooperative, non-contested environment. The design should prevent accidental confusion and make joins observable, but it does not need hardened admission control against an active attacker.

There is exactly one Gateway. It is the only join authority. Join authentication must be isolated behind a replaceable policy because its mechanism may change. The Gateway itself does not join through that authority.

The Asset's stable Atlas identity belongs to its machine, not its radio. Replacing a radio must not create a different Asset.

Before joining, an Asset-mode Link service broadcasts a structured public Atlas discovery beacon on the known rendezvous channel, effectively announcing that Atlas is operating without a configured Gateway connection. After learning the Asset radio's public key, the Gateway begins a public-key-encrypted direct-message authentication exchange. Successful authentication provides the private Atlas channel membership and a new source generation used for normal traffic. The Link refuses shared-channel-key fallback.

The beacon is public but is not an ordinary text chat message. It contains only an Atlas marker, join-attempt ID, radio node identity, stable Asset ID, Link service session, and supported link capabilities. It carries no location, Tasks, telemetry, credentials, private-channel material, or Shared Picture contents.

An unjoined Asset-mode service sends immediately, every five seconds with jitter for the first thirty seconds, then every thirty seconds until the Gateway responds. It stops beaconing after joining. The rendezvous channel remains configured and passively available for the next Asset service start, while the Gateway continues listening for new Assets.

An Asset-mode Link service does not treat a previous join as durable membership. It clears or disables old private-channel material, then repeats discovery and joining whenever it starts as if the prior service did not exist. The stable Asset identity still survives across starts.

The Gateway deployment durably stores the current private-channel material and never regenerates it during an ordinary restart. It increments its own source generation and resumes the same mesh. Explicit key rotation is a separate operation because it requires Assets to rejoin.

If the Gateway is unavailable, an Asset service that is already running continues participating, but an Asset service that starts or restarts waits until it can join through the Gateway.

See [`dynamic-joining.md`](dynamic-joining.md) for the current joining design.

### Passive picture convergence

Joining does not trigger a full-state download or historical backfill. The new Link service joins the shared channel and learns current state by listening to normal traffic. In the initial small network, ordinary publication should provide a useful up-to-date Shared Picture within roughly thirty seconds.

The Link service reports ready as soon as joining and its local service interface are operational. Thirty-second picture convergence is an acceptance target, not a readiness gate or a guarantee that every possible record has arrived.

The Shared Picture starts empty on every Link service start. Only stable Asset identity persists across starts.

Most Shared Picture records are expected to come from messages the local Asset did not request. Responses to its own requests enter the same picture when they contain shared state. The distinction affects request completion, not whether the information may become part of the picture.

The Shared Picture keeps only the latest accepted state for each Atlas record. It is not an operational-history store. See [`shared-picture.md`](shared-picture.md) for the current state and freshness model.

Positions, telemetry, and Tracks become stale quickly and later leave active results. Active Tasks remain through their terminal outcome and then age out. Geofeatures and Object metadata remain until updated or deleted.

Only state-bearing messages update the Shared Picture. Radio receipts, joining traffic, retries, and transfer fragments remain in diagnostics. A Task acknowledgement or progress report that changes the latest Task state remains eligible because it contributes to the operational picture.

### Link subscriptions

A Link subscription requests a data feed from the Gateway. The Gateway combines subscriptions from every Link service. It broadcasts one update while at least one Link service wants the feed, regardless of whether one or several Link services subscribe. One Link service unsubscribing does not stop publication while another subscription remains.

Subscriptions create publication demand; they do not create private delivery. Every Link service may hear and use the resulting feed.

Subscriptions are renewable leases rather than permanent Gateway configuration. Demand from a Link service expires when that Link service disappears and stops renewing it.

The first feed selectors are an exact Atlas record identified by resource type and ID, all records of one supported type, and Tasks assigned to one Asset. The link does not introduce an arbitrary query language or geographic filtering.

When subscribed Core state changes faster than the radio can carry it, the Gateway replaces queued superseded state with the latest value. It does not replay obsolete intermediate positions, Track updates, or observational Task state.

When the first Link service subscribes to a feed, the Gateway broadcasts its current value once and then publishes later updates. This focused initial value is not a general picture dump.

`tasks_for_asset` is an observational feed for the Shared Picture. The Gateway delivers executable Task assignments and cancellations to their addressed Asset through the confirmed Task path whether or not a Link subscription exists. Feed traffic cannot invoke a Task handler or acknowledge a Task.

A known airtime concern remains unresolved: a field Asset may already broadcast its own position or telemetry, while a Link subscription causes the Gateway to broadcast the same underlying state again after receiving it through Atlas Core. Multiple subscribers do not multiply transmissions, but the field-to-Gateway-to-field loop may duplicate data that was already audible on the mesh.

See [`subscriptions.md`](subscriptions.md) for the aggregate-demand rule and the unresolved duplicate-path concern.

### Delivery behavior

Shared state such as position, telemetry, Tracks, Geofeatures, and picture publications is best effort. Tasks, cancellation, data requests and responses, explicit resource writes, and Object transfers require confirmation from their intended application recipient.

The Meshtastic Link does not decide when an Asset publishes position, Tracks, telemetry, health, or Task progress. Those cadences and change triggers belong to the Asset application. The Link service transports the publications it is given and does not invent heartbeats, sample attached systems, or impose normal publication-rate policy.

If submitted traffic exceeds available capacity, the Link service may replace an older unsent best-effort state update with the newest submitted state for the same record. It never silently drops or replaces a confirmed operation. Congestion therefore reduces state frequency rather than creating an obsolete history backlog.

If the Link service cannot reserve bounded tracking resources for another confirmed operation, it rejects that operation immediately with an explicit local overload result. It never reports an operation as queued unless it can track the operation to confirmation, rejection, or deadline failure.

Receiving radio bytes does not acknowledge a Task. The assigned Asset application validates and explicitly accepts it. Broadcast state does not create acknowledgements from every listener; periodic current-state publication and focused requests repair missed information.

For each Asset, the Gateway dispatches confirmed Task assignments in Atlas Protocol order and waits for application acknowledgement, rejection, or terminal state before delivering the next assignment. The Asset application owns execution order. The delivery rule prevents radio reordering from hiding an earlier Task that the application has not received.

When traffic competes, the Link service prioritizes safety and cancellation, Task control and outcomes, requests and responses, live Asset and Track state, other resource synchronization, then Object content. See [`delivery-and-priority.md`](delivery-and-priority.md).

### Generated Radio contract

The first Radio contract is generated from Atlas Protocol rather than designed as an optimized collection of radio-only resources. It exposes the same Atlas resources and operations through a radio-facing SDK and preserves their meaning without manually copying or independently evolving the schema.

The baseline deliberately establishes how the ordinary Atlas Protocol behaves on the mesh before optimization. It may require many radio packets. That cost is measured rather than hidden. Later compact encodings or field selections must be generated from the same Atlas Protocol source, preserve the same operation semantics, and prove their improvement against the baseline scenarios.

The Radio contract adds only transport concerns such as Link revision, role-tagged source and optional destination Link nodes, Gateway-issued source generation, Link service session, sequence, operation identity, and fragmentation. These fields describe delivery and do not become Atlas resource fields. Supporting a complete Radio contract also does not cause every resource to be broadcast. Publication, subscription, Shared Picture, Gateway, and Core policies still determine what is sent and why.

Routine messages should fit in one Meshtastic packet whenever practical, but one-packet size is not a validity rule. Any supported message may be divided into chunks and reassembled. The Link service never rejects an otherwise valid operation merely because it needs a second packet.

Incomplete best-effort state is discarded after its reassembly timeout and recovered from the next publication or a focused request. It does not trigger missing-chunk requests from every listener. Confirmed operations and Object transfers may request only their missing chunks.

Fragmentation cannot reserve the transmitter until completion. The scheduler reconsiders priority after every chunk so cancellation, Task traffic, and other urgent work can interrupt and later resume a lower-priority transfer. Each Link service emits chunks for at most one Object-content transfer at a time, although routine and confirmed traffic may continue between those chunks.

Commands supported through Meshtastic Link must remain suitable for radio operation. Large input content belongs in an Object transferred first, leaving the Task to reference the Object rather than embedding the content. The generated baseline itself may still require fragmentation until measured optimizations make common operations smaller.

See [`wire-protocol.md`](wire-protocol.md) for this source-of-truth boundary.

### Simulation and benchmarking

Protocol evolution is benchmark-driven. A deterministic simulation runs realistic multi-radio scenarios faster than real time while using the production serializer, fragmenter, reassembler, scheduler, priority rules, and Shared Picture receive path. Simulated information may not bypass the radio path or appear directly in another Link service's picture.

The generated Atlas Protocol form is the named baseline. It uses the ordinary compact UTF-8 JSON emitted for Atlas Protocol operations, without compression or radio-specific field selection. Optimizations must run the same scenarios with the same topology, traffic, losses, seed, Radio profile, and success criteria. Comparisons report packets, transmitted bytes, estimated airtime, latency by priority, delivery and retry outcomes, queue pressure, Shared Picture convergence, and Object-transfer cost.

The simulator is not allowed to claim RF fidelity that has not been calibrated. Hardware trials provide evidence for airtime, collision, loss, and range assumptions. See [`simulation-and-benchmarking.md`](simulation-and-benchmarking.md).

The canonical scenario uses one Gateway and four Assets with paths up to three hops. Its normal workload includes Asset position and telemetry, five active Tracks, Task progress, duplicate demand for one subscription feed, and small data requests. A stress scenario adds twenty Tracks, a 32 KiB Object transfer, and urgent cancellation.

The unoptimized JSON baseline has strict correctness gates but no performance gate. It is allowed to perform badly as long as the benchmark reports that result honestly. Field-ready optimized implementations must preserve the same Atlas outcomes and meet provisional normal-scenario goals: cancellation within two seconds, Task delivery within five seconds, a small data request within ten seconds, and useful Shared Picture convergence within thirty seconds. Hardware trials must validate those goals before they become guarantees.

### Disconnected operation

Gateway-to-Core loss is considered unlikely, but it must not stop peer situational awareness. Joined assets continue publishing observations and updating their Shared Pictures. They may continue work already accepted before the loss. The field mesh does not invent new authoritative Core Tasks while disconnected.

Pending Link operations, transport duplicate fences, and transmission queues do not survive a Link service restart. The old Link service reports failure to its pending local callers. The replacement rejoins from scratch, and authoritative Asset or Core state decides whether work must be resubmitted or reconciled. The Asset application must durably fence physical execution by Atlas Task ID. The Link promises duplicate suppression only within one service session.

### Gateway and Atlas Core

Atlas Core and the Shared Picture serve different purposes. The Shared Picture is an ephemeral local view assembled from channel traffic. Core is the durable Atlas control and data plane.

The Gateway does not copy or reconcile the Shared Picture as a whole. It submits each valid field-originated Atlas report or operation to Core once. Examples include new Asset telemetry, a field-observed Track, an Asset-created Geofeature, and Task lifecycle reports. Passive copies and the Gateway's own Core-originated broadcasts do not become new Core writes.

Core remains final for every Task. Field-reported Task progress appears in the Shared Picture immediately with its confirmation state. Core acceptance confirms it. Core rejection restores the authoritative Task state, returns the rejection to the originating Asset, and produces bounded diagnostic evidence.

See [`gateway-core-bridge.md`](gateway-core-bridge.md) for ownership and confirmation behavior.

## Target system shape

The Link runs as a local service on the Gateway and every Asset Host.

```text
Atlas Core <-> Atlas SDK <-> Gateway application
                                   |
                          Meshtastic Link service
                                   |
                                 radio
                                   )))
                         shared private channel
                           (((           (((
                         radio           radio
                           |               |
                 Meshtastic Link   Meshtastic Link
                     service           service
                           |               |
                  Asset application  Asset application
```

Each Link service maintains its own Shared Picture from state it receives. The Gateway bridges selected Core state into the mesh and reconciles field reports back to Core when connected.

## Implementation boundary

Meshtastic Link is a separate TypeScript and Node 24 workspace at `packages/meshtastic-link`. It is not part of the MeshCore-specific FieldLink package. One Link service implementation and executable supports explicit `asset` and `gateway` modes while sharing configuration, framing, queues, Shared Picture behavior, simulation, and its local API. Core access remains in the Gateway application outside the package.

The package initially connects to Meshtastic radios only through USB serial. The official Meshtastic Node serial dependency remains behind an Atlas-owned adapter so the Link service and simulator do not depend directly on one client library throughout their code.

The Radio contract generator and checked-in generated output belong to the Meshtastic Link package. The generator reads Atlas Protocol's authoritative schema, and CI fails when regeneration differs from the checked-in output. Atlas Protocol never imports Meshtastic code.

Reusable virtual clock, radio network, and benchmark mechanics live with the package. Whole-Atlas scenarios involving Core, Gateway, and Asset applications live in the existing `simulations` workspace. Both exercise the same production Link implementation.

See [`implementation-sequence.md`](implementation-sequence.md) for the accepted first vertical slice and later phases.

## Accepted design principles

These principles define the accepted design:

- Publish shared state once and let every radio that receives it use it.
- Treat subscriptions as publication demand, not as radio-level secrecy or per-recipient duplication.
- Put routine state, Task, and control traffic on the shared channel so every Link service can understand current activity.
- Use application addressing to decide who may act or reply.
- Preserve source, observation time, receive time, freshness, and identity so missed or repeated packets do not corrupt the local picture.
- Use current-state synchronization to recover from missed traffic instead of requiring perfect packet delivery.
- Keep each routine update small enough for one radio packet whenever practical.
- Retain fragmentation as a fallback for every supported message instead of making packet size a validity rule.
- Optimize only after measuring the generated Atlas Protocol baseline in repeatable realistic scenarios.
- Leave publication cadence and state-change policy with the Asset application rather than embedding Asset behavior in the Link.

## Completed discovery

The architecture interview covered:

1. Dynamic joining behavior and identity
2. Contents and lifecycle of the Shared Picture
3. Link service interface for local applications
4. Gateway subscriptions and Core reconciliation
5. Delivery classes, acknowledgements, retries, and recovery
6. Airtime policy, message size, update frequency, and priority
7. Initial field scenario and acceptance criteria
8. Package boundary and implementation sequence

The product decisions needed for the first vertical slice are complete. Remaining choices in the focused documents are laboratory measurements or implementation details.

## Related documentation

- [`../../CONTEXT.md`](../../CONTEXT.md) defines Atlas-wide terms.
- [`../atlas-protocol/`](../atlas-protocol/) defines Atlas Commands, Tasks, and shared data contracts.
- [`../../packages/fieldlink/docs/system-architecture.md`](../../packages/fieldlink/docs/system-architecture.md) is the current MeshCore-specific radio architecture and a useful comparison.
- [`../../edge/asset/README.md`](../../edge/asset/README.md) and [`../../edge/gateway/README.md`](../../edge/gateway/README.md) reserve the application roles that will integrate the link.
- [`dynamic-joining.md`](dynamic-joining.md) records the restart-time discovery and joining flow.
- [`shared-picture.md`](shared-picture.md) defines the ephemeral latest-known local view.
- [`subscriptions.md`](subscriptions.md) defines combined feed demand and records its airtime concern.
- [`service-interface.md`](service-interface.md) defines how local software uses the Link service.
- [`gateway-core-bridge.md`](gateway-core-bridge.md) distinguishes Field reports, Shared Picture state, and authoritative Core state.
- [`delivery-and-priority.md`](delivery-and-priority.md) defines best-effort publication, confirmed operations, and traffic priority.
- [`radio-configuration.md`](radio-configuration.md) defines Link service ownership of the attached Meshtastic radio configuration.
- [`wire-protocol.md`](wire-protocol.md) defines the generated Radio contract, transport envelope, fragmentation, and compatibility boundary.
- [`simulation-and-benchmarking.md`](simulation-and-benchmarking.md) defines the honest faster-than-real-time benchmark.
- [`implementation-sequence.md`](implementation-sequence.md) defines package ownership and the first implementation slices.
- [Meshtastic channel configuration](https://meshtastic.org/docs/configuration/radio/channels/) describes the shared channel name, key, and shareable configuration used by current Meshtastic clients.
- [Meshtastic encryption](https://meshtastic.org/docs/overview/encryption/) describes shared-key channel broadcasts and public-key-encrypted direct messages.
- [Meshtastic `LOCAL_ONLY` definition](https://github.com/meshtastic/protobufs/blob/master/meshtastic/config.proto) defines rebroadcasting in terms of configured local channels.
- [Meshtastic direct-message downgrade advisory](https://github.com/meshtastic/firmware/security/advisories/GHSA-377p-prwp-4hwf) records the legacy fallback fixed in firmware 2.7.15.
