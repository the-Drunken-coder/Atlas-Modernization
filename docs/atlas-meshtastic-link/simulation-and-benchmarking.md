# Simulation and benchmarking

Meshtastic Link uses a faster-than-real-time deterministic packet-level simulation to measure the generated Atlas Protocol baseline and later transport optimizations.

The simulator is a protocol and network workbench, not a replacement for hardware testing. Its job is to make architectural comparisons repeatable before consuming field time.

The packet network models each source and relay transmission separately. Carrier sensing reserves only the transmitting radio's audible neighborhood, so disconnected neighborhoods may transmit concurrently and hidden transmitters may collide at a shared receiver. The deterministic baseline uses a four-airtime contention window, treats an earlier overlapping reception as captured, loses equal-start collisions, and suppresses destructive overlap between copies of the same flooded packet. These are explicit uncalibrated assumptions for comparison, not RF claims.

## No-cheating rule

A scenario must exercise the same application path used by a real Link service:

1. A Link client invokes the production radio-facing SDK.
2. The production Radio contract serializer creates the payload.
3. The production transport envelopes, fragments, queues, and prioritizes it.
4. A simulated Meshtastic network applies configured modem airtime, transmission queues, flooding across hops, contention, collision, loss, duplication, retry, changing connectivity, and delay.
5. The receiving production transport reassembles and validates the message.
6. Only the normal receive path may update a Shared Picture or deliver an addressed operation.

The simulation may advance a virtual clock faster than wall time. It may not inject final Atlas state into a destination, skip serialization, estimate a smaller payload than production emits, bypass fragments, grant acknowledgements without delivery, or use perfect global knowledge inside a Link service.

## Reproducible scenarios

Each scenario records:

- Scenario version and deterministic random seed
- Radio profile and regulatory region
- Radio topology, hop relationships, and changing connectivity
- Assets, Gateway, publications, subscriptions, Tasks, requests, and Object transfers
- Asset-application publication schedules, message rates, payloads, and event timing
- Loss, duplication, collision, retry, and queue assumptions
- Success criteria and measurement window

The initial suite should include quiet convergence, simultaneous Asset reporting, a new Link service joining, Gateway restart without channel-key change, aggregate subscription demand, the known field-to-Core-to-field duplicate path, ordered Task delivery and cancellation under load, service restart with delayed old-generation traffic, snapshot-to-stream handoff, Gateway-to-Core loss, and a 32 KiB Object transfer interrupted by higher-priority traffic.

Publication schedules are scenario inputs representing Asset application behavior. The simulated Link must not generate Asset position, Track, telemetry, health, or Task-progress schedules on its own.

## Canonical fleet and topology

The canonical fleet contains five radios: one Gateway and four Assets. Its normal topology includes paths of one, two, and three hops, with some nodes able to hear more than one neighbor. The suite also runs an all-nodes-within-one-hop topology and a temporary network partition followed by reconnection.

The normal workload supplies these Asset and Gateway behaviors as scenario inputs:

- Each of four Asset applications submits position once per second and telemetry every ten seconds.
- Five active Tracks each receive one update per second.
- One Task is created each minute. After the assigned Asset receives and accepts it, the Asset reports acknowledgement, start, progress, and completion through the production Task-report path.
- Two Assets subscribe to the same feed, which must produce only one Gateway publication.
- One small data request occurs every thirty seconds.

The stress workload adds twenty active Tracks, one 32 KiB Object transfer, and an urgent cancellation while background traffic is queued.

## Production code in the loop

The benchmark uses the actual serializer, fragmentation, reassembly, retry, deduplication, scheduling, and Shared Picture logic. Simulation-specific code provides a radio and clock adapter. It does not implement a second simplified protocol stack.

Atlas semantics are checked at both ends. A successful delivery must decode into the same Atlas operation and resulting state as a real link. Seeded scenario fixtures are valid Atlas Protocol inputs, not hand-sized synthetic byte arrays.

## Baseline and comparisons

The first named baseline uses the generated Atlas Protocol Radio contract as ordinary compact UTF-8 JSON without compression or radio-specific field selection. Its fragmentation is part of the result.

The checked-in seed-42 position, canonical five-radio normal, and canonical stress baseline results live in `packages/meshtastic-link/baselines`. The canonical normal scenario is revision 2 because its feed and Task workload now exercise the documented Core publication and one-minute Task cadence. Package tests rerun all three through the production transport and fail if their semantics or exact measurements drift without an intentional baseline update. The canonical picture snapshots preserve the exact 30-second, 60-second, and final post-drain observations. Its independent record-count gate uses the 30-second and 60-second measurement windows; with the current seed-42 full workload, the normal run has zero records at 30 seconds and one at 60 seconds. The exact final snapshot still records slow delivery and freshness expiry honestly without turning a performance miss into a correctness failure.

The ordinary JSON baseline is not a field candidate. At the documented publication rates, the checked-in normal and stress runs truthfully record deadline failures and incomplete convergence instead of manufacturing successful delivery. Focused quiet-link tests separately prove confirmation, rejection, retry exhaustion, ordered Task delivery, priority interruption, joining, and snapshot handoff. A later encoding or scheduling optimization must rerun the unchanged load and improve those recorded outcomes.

The baseline has correctness gates but no performance gate. It succeeds as a baseline when it faithfully exercises Atlas semantics and reports its cost, even if its latency, fragmentation, or airtime is unsuitable for field use. Field-ready optimized implementations inherit both correctness and performance targets.

An optimization is compared by changing only the declared protocol implementation while retaining the scenario, inputs, topology, seed, Radio profile, and success criteria. Every comparison reports both absolute results and change from the generated baseline.

At minimum, record:

- Serialized application bytes
- Meshtastic packets and transmitted bytes
- Estimated airtime by message family and priority
- End-to-end delivery and confirmation latency
- Queue depth and time spent queued
- Fragment retransmission and incomplete reassembly
- Operation success, rejection, timeout, and retry exhaustion
- Shared Picture convergence and freshness
- Duplicate delivery suppressed
- Object transfer completion time and interference with higher-priority work

Throughput improvement is invalid if Atlas semantics, application confirmation, delivery success, or priority behavior regresses outside the scenario's accepted limits.

The canonical normal benchmark uses a deterministic fake Core change feed. Aggregate Gateway demand opens one Core feed subscription, a feed event enters the Gateway's production Radio SDK, and the resulting `gateway_feed` publication goes through serialization, transport, the simulated radio, and normal receiver handling. The result records the Core publish count, Gateway publish count, number of Link subscribers, and receiver deliveries. A broadcast may be received by every radio, so receiver delivery is measured from the actual receive path rather than inferred from demand transitions.

The production Link implementation and whole-system scenarios must prove:

- The Link suppresses duplicate delivery during one service session, and the Asset application's durable Task-ID fence prevents duplicate physical execution across Link service restarts.
- Confirmed Task assignments reach each Asset in ascending `created_at`, then `task_id`, even when radio delivery reorders packets.
- A `tasks_for_asset` feed updates only the Shared Picture and never invokes the Asset's Task handler or acknowledges a Task.
- Delayed state from an older source generation never replaces newer accepted state from that source.
- Snapshot and live-stream handoff loses no accepted Shared Picture change.
- Only the addressed application acts on a confirmed operation.
- Multiple subscriptions for the same feed produce one Gateway publication stream.
- Confirmation, rejection, timeout, and retry exhaustion produce the specified visible outcomes.
- Higher-priority messages interrupt lower-priority fragmented traffic between chunks.
- Successfully delivered messages produce the same Atlas operations and final Shared Picture state across baseline and optimized encodings.

## Provisional field-ready targets

In the normal three-hop scenario, an optimized field candidate should meet these targets:

- An urgent cancellation reaches the assigned Asset application within two seconds.
- A Task assignment reaches the assigned Asset within five seconds.
- A small data request completes within ten seconds.
- A newly joined Link service develops a useful Shared Picture within thirty seconds.
- A background Object transfer does not cause any of those targets to be missed.

These are simulator goals until hardware trials validate them. The baseline is measured against them but is not rejected for missing them.

## Model calibration

The simulator operates at the packet level. It does not attempt to simulate electromagnetic waveforms, terrain propagation, or antenna physics. Exact serialized bytes, packet sizes, configured modem airtime, transmission queues, routing and flooding, hop limits, application scheduling, retries, and acknowledgements come from production configuration and code. Loss, collision, interference, and changing connectivity begin as explicit scenario assumptions.

Hardware experiments record actual firmware, Radio profile, topology, environment, packet outcomes, and timing. Their results calibrate or bound the simulator. Uncalibrated assumptions remain labeled instead of being presented as field predictions.

Before field use, three physical radios using the selected firmware and `LOCAL_ONLY` profile must prove that an Asset discovery beacon and the public-key-encrypted join exchange traverse one intermediate relay in both directions. This result cannot be inferred from the packet simulator.


## Meshtastic Lab backend

Atlas also owns a real-time experiment runner at
`packages/meshtastic-link/src/experiments`. It uses Meshtastic Lab programmatically
as a native firmware and RF-medium backend. The lab does not interpret Atlas
messages or decide whether an Atlas experiment passed. The runner supplies valid
Radio contract workloads and observes production Link instances at both ends.

Individual packet drops, complete-message acceptance, sender confirmation, and
missed deadlines remain separate outcomes. Recovered packet loss is successful
message delivery with additional cost. A lost confirmation does not erase the
receiver's acceptance. Native RF observations and controlled pre-reassembly fault
injections retain separate provenance; unavailable native loss rates stay unknown.

These experiments use lab-configured channels and TCP Client API connections.
They supplement the deterministic benchmarks and physical-radio trials without
claiming to validate joining, full Radio profile convergence, or physical range.
See [the experiment guide](../../packages/meshtastic-link/experiments/README.md)
for scenarios, reproducibility, lifecycle ownership, and exact result denominators.

## September 2026 bandwidth comparison

The [bandwidth optimization report](../../packages/meshtastic-link/experiments/BANDWIDTH-OPTIMIZATION.md) compares the frozen `deflate-v1` implementation with corrected native payload budgets, causal response metadata, and the opt-in `deflate-v2` encoding. It retains the three-Asset A–Gateway–B–C workload, five-second telemetry, and fifteen-second command cadence.

The packet model now carries received native packet IDs, applies the per-send native budget, and includes the five-byte request ID in estimated airtime. Its three checked-in canonical baseline artifacts were intentionally regenerated after that correction. Those artifacts remain JSON reference costs, not evidence of an optimized fleet's throughput. The model still lacks firmware queue priority and eviction, and does not establish physical RF performance.

The native Lab comparison resets host-local packet priority at the simulated RF boundary, matching physical Meshtastic headers. Earlier Lab results that carried that priority across RF cannot measure the benefit of native response metadata. Both implementations must run on the corrected Lab to make that comparison.

The [next optimization round](../../packages/meshtastic-link/experiments/FURTHER-OPTIMIZATION.md) tests explicit receipt/report pairing with `deflate-v3`, lease renewal traffic, and join acceptance limits. `runSimulatedExperiment` derives per-node Link IDs from the scenario seed, so compressed sizes and event timing are reproducible without replacing global crypto functions. Production services retain cryptographic IDs. Native experiment node results include `radio_queue`: bounded local queue-status observations since device connection (including setup), with minimum reported free slots and matched admissions/rejections. These observations do not establish RF transmission or end-to-end delivery.


## Latency and current-state comparisons

`createGatewayFleetExperiment({ commandsPerAsset: true })` keeps three Assets publishing every five seconds and increases commands to one per Asset every fifteen seconds. The original default remains one fleet-wide round-robin command every fifteen seconds. Both use the same Gateway–A, Gateway–B, B–C connectivity. `scripts/compare-latency.ts` compares the prior v3 encoding, binary encoding, adaptive retries, compact state updates, and their combination across both loads and both presets with seeded identities.

Experiment telemetry results include time-weighted sample age (p50, p95, maximum), the longest interval without a fresher accepted sample, and unknown time before the first accepted sample. These use independently observed application acceptance. Their active window runs from the first through the last scheduled publication for that source and receiver; the remaining drain window is reported separately. An out-of-order older sample cannot make the freshest known state older. A missing initial sample is unknown state, not zero age. The existing per-message delivery, confirmation, and packet counters remain separate.

The [latency and bandwidth comparison](../../packages/meshtastic-link/experiments/LATENCY-AND-BANDWIDTH.md) records the binary codec, atomic acceptance/report API, telemetry scheduler, optional retry/update modes, and their measured tradeoffs.
