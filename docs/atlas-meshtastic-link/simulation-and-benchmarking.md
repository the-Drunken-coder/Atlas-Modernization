# Simulation and benchmarking

Meshtastic Link uses a faster-than-real-time deterministic packet-level simulation to measure the generated Atlas Protocol baseline and later transport optimizations.

The simulator is a protocol and network workbench, not a replacement for hardware testing. Its job is to make architectural comparisons repeatable before consuming field time.

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
- One Task is created each minute, reports progress, and completes.
- Two Assets subscribe to the same feed, which must produce only one Gateway publication.
- One small data request occurs every thirty seconds.

The stress workload adds twenty active Tracks, one 32 KiB Object transfer, and an urgent cancellation while background traffic is queued.

## Production code in the loop

The benchmark uses the actual serializer, fragmentation, reassembly, retry, deduplication, scheduling, and Shared Picture logic. Simulation-specific code provides a radio and clock adapter. It does not implement a second simplified protocol stack.

Atlas semantics are checked at both ends. A successful delivery must decode into the same Atlas operation and resulting state as a real link. Seeded scenario fixtures are valid Atlas Protocol inputs, not hand-sized synthetic byte arrays.

## Baseline and comparisons

The first named baseline uses the generated Atlas Protocol Radio contract as ordinary compact UTF-8 JSON without compression or radio-specific field selection. Its fragmentation is part of the result.

The checked-in seed-42 position, canonical five-radio normal, and canonical stress baseline results live in `packages/meshtastic-link/baselines`. Package tests rerun all three through the production transport and fail if their semantics or exact measurements drift without an intentional baseline update.

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
