# Implementation boundary and sequence

This document turns the accepted Meshtastic Link architecture into bounded implementation slices. It does not claim that the package or Runtime exists yet.

## Package ownership

Meshtastic Link is a new npm workspace at `packages/meshtastic-link`, implemented in TypeScript for Node 24.

The package owns:

- The generated Radio contract and radio-facing SDK
- Link envelopes, fragmentation, reassembly, deduplication, confirmation, retry, priority, and congestion behavior
- The in-memory Shared Picture
- The long-running Runtime, local JSON API, event stream, and CLI
- Declarative local Radio profile convergence and verification
- The Meshtastic radio adapter
- Reusable virtual clock, virtual radio, packet network, and benchmark engine

The package does not own:

- Atlas Protocol resources or operation semantics
- Asset publication cadence, physical behavior, autonomy, or Command handlers
- Gateway Core credentials, Core writes, feed consumption, or durable Core reconciliation
- MeshCore FieldLink behavior
- Whole-system deployment policy

## One Runtime, two modes

One Runtime implementation and executable supports explicit `asset` and `gateway` modes. The modes share the transport engine, Radio profile, local API, Shared Picture, queues, diagnostics, and simulation seams.

Asset mode discovers and joins through the Gateway. Gateway mode listens for discovery, runs the selected authentication policy, admits members, and exposes field operations to the separate Gateway application. The Gateway application uses Atlas SDK and owns all Atlas Core access.

There are no separate radio profiles or hardware requirements for these modes.

## Generated contract

The generator and its checked-in output live inside `packages/meshtastic-link`. The generator reads the Atlas Protocol source of truth and produces the baseline Radio contract and radio-facing SDK without requiring Atlas Protocol to import Meshtastic code.

CI regenerates into a temporary location and fails if the result differs from the checked-in output. Developers edit Atlas Protocol or the Meshtastic generator, never generated files directly.

The first generated serializer emits deterministic compact UTF-8 Atlas Protocol JSON without compression or radio-specific field selection.

## Radio adapter

The first physical adapter uses USB serial. Bluetooth and radio-hosted Wi-Fi connections are not implemented initially.

The active official Meshtastic Node serial client is isolated behind a narrow Atlas adapter. Production transport code depends on the adapter contract, not directly on the client library. The simulated radio implements the same boundary.

## Simulation ownership

Reusable deterministic mechanics live in `packages/meshtastic-link`:

- Virtual monotonic clock
- Simulated radio adapter
- Packet airtime and queue model
- Flooding, hop, connectivity, collision, duplication, and loss model
- Benchmark runner and metric collection

Whole-Atlas scenarios live in the existing `simulations` workspace when they involve Atlas Core, a Gateway application, or Asset application behavior. They import the production Meshtastic Link package and provide scenario inputs rather than reimplementing transport behavior.

## First vertical slice

The first milestone is entirely simulated and deliberately narrow:

1. Generate the unchanged Atlas Protocol JSON baseline.
2. Have one simulated Asset application submit a valid position resource through the radio-facing SDK.
3. Envelope and fragment it using production transport code.
4. Flood the chunks through the simulated packet network.
5. Reassemble and validate it at the simulated Gateway and another Asset Runtime.
6. Update both Shared Pictures only through the production receive path.
7. Report exact application bytes, packets, transmitted bytes, modeled airtime, and delivery latency.
8. Prove that a fixed scenario and seed produce repeatable semantic and metric results.

This slice contains no optimized encoding and no physical radio. It establishes the no-cheating measurement seam first.

## Expansion order

After the first slice is correct and repeatable:

1. Add every generated Atlas Protocol resource and operation to the simulated Radio contract.
2. Add addressing, confirmation, retries, deadlines, deduplication, fragmentation repair, priority preemption, congestion coalescing, subscriptions, and Object transfers.
3. Add the Runtime's loopback API, event stream, CLI, and Shared Picture lifecycle.
4. Add the USB serial adapter and local Radio profile convergence.
5. Add public discovery, replaceable authentication, and private-channel joining.
6. Integrate Asset and Gateway applications without moving their policy into the Link.
7. Run the canonical five-radio scenarios and record the unoptimized baseline.
8. Attach physical radios, calibrate the simulation, and validate provisional field targets.
9. Introduce compact generated encodings only after measurements identify their value.

Each phase uses the narrow correctness and documentation checks relevant to that phase. A later phase does not require speculative infrastructure in an earlier one.
