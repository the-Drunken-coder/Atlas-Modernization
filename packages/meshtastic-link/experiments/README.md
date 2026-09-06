# Atlas experiments with Meshtastic Lab

Atlas owns the workload, production Link instances, test application acceptance,
and semantic verdicts. Meshtastic Lab provides native firmware radios, directed
connectivity, and packet observations through its existing API. No Atlas behavior
or result interpretation needs to be added to Meshtastic Lab.

## Run

Start Meshtastic Lab separately. Its web service must be reachable at
`http://127.0.0.1:8080`, with the simulation **stopped** and available exclusively
for the experiment. Use Node 24 and install this repository's dependencies with
`npm ci` from the repository root.

From the Atlas repository root:

```sh
npm run meshtastic-link -- experiment \
  --config experiments/recover-loss.json \
  --output /tmp/atlas-recover-loss.json
```

The npm command runs in `packages/meshtastic-link`, so its config path is relative
to that package. Absolute config and output paths also work. The output must be a
new file. The CLI exits zero when all declared expectations hold, the observation
window completes, packet history is complete, requested fault rules are exercised,
and cleanup succeeds. A deliberately undeliverable message can therefore pass its
negative test while still contributing to the measured message failure rate.

The runner reserves the lab with a local lock, saves its scenario, configures a
fresh network, starts firmware, connects one ordinary TCP client per node, and
runs the workload. It then closes clients, stops the simulation, and restores the
saved scenario. It never resets the lab's saved results. SIGINT and SIGTERM request
cleanup and write an incomplete result. A hard process kill can leave a lock or
running simulation; inspect the PID recorded in the named lock before manually
removing a stale reservation. The lock coordinates Atlas runners; it cannot stop
someone changing the lab through another client or its UI during a run.

Atlas code can also invoke the runner through the package's public export:

```ts
import {
  parseExperiment,
  runLabExperiment,
  experimentSourceIdentity
} from "@the-drunken-coder/atlas-meshtastic-link/experiments";

const source = await experimentSourceIdentity();
const result = await runLabExperiment(parseExperiment(workloadJSON), abortSignal);
const artifact = { ...result, source };
```

The caller owns writing a programmatic result. The CLI adds the source fingerprint
and writes its JSON artifact even when a valid experiment fails during preflight.

## Scenarios

| Config | Expected result |
| --- | --- |
| `quiet.json` | One Task assignment accepted once and confirmed |
| `recover-loss.json` | Drop one received Task fragment; the production Link repairs delivery |
| `no-delivery.json` | Drop all received Task fragments through the observation window; no complete delivery |
| `lost-confirmation.json` | Accept the Task, suppress return control fragments; delivered but unconfirmed |
| `duplicate.json` | Duplicate received Task fragments; one application acceptance |
| `state-fanout.json` | One best-effort state publication reaches both the Gateway and a peer Asset |

Receive faults are explicit test injections **after firmware reception and before
Link reassembly**. They do not claim a native RF collision occurred. `count` caps
the number of packets affected by a rule; it is not a requested minimum. Every
configured rule must affect at least one packet for the run to pass.

A config specifies 2–10 nodes, their Atlas roles and lab TCP ports, a full mesh or
line topology, the modem preset, payload ceiling, and a bounded timeline. Node
order defines neighbors in a line. All native radio roles are `CLIENT`, with US
region, frequency slot 20, hop limit 3, and the lab's primary channel. These are
controlled simulator settings, not field selections.

Each message contains a valid Atlas Radio contract value, a source-scoped operation
ID, expected receivers, optional logical destination, scheduled time, deadline,
and expected outcome. Supply additional entries to test different publication
cadences or simultaneous sources; the Link itself does not generate telemetry.
State messages broadcast, so each expected receiver is checked separately.
`link_changes` entries contain `at_ms`, `from`, `to`, and `enabled` and change one
directed link at a time. Specify both directions for a bidirectional partition.
The result preserves actual application and link-change times as well as the plan.

`max_payload_bytes` is passed to the production fragmenter through its radio
adapter. The examples use 200 bytes. Initial native trials rejected 233-byte
frames as `TOO_LARGE`; 230-byte trials admitted frames but did not reconstruct
complete messages. The pinned native `SimRadio` also wraps payloads in a bounded
protobuf envelope. The 200-byte choice is a tested lab setting, not a measurement
of maximum physical-radio capacity. Keep this parameter fixed when comparing
workloads or implementations.

## Gateway fleet workload

The generated five-minute workload uses `asset-a ↔ gateway ↔ asset-b ↔ asset-c`.
All three assets publish position telemetry together every five seconds, starting
at time zero. The Gateway sends a Task assignment every fifteen seconds, rotating
A, B, C. That produces 180 telemetry publications and 20 command exchanges.
A thirty-second drain follows the five minutes of submissions.

Generate a config or run the modeled medium from the repository root:

```sh
node --import tsx packages/meshtastic-link/scripts/gateway-fleet.ts config /tmp/atlas-fleet-config.json
node --import tsx packages/meshtastic-link/scripts/gateway-fleet.ts simulate /tmp/atlas-fleet-modeled.json
npm run meshtastic-link -- experiment --config /tmp/atlas-fleet-config.json --output /tmp/atlas-fleet-native.json
```

All output paths must be new. Use Node 24. The modeled and native commands save
failed results and exit nonzero when their expectations fail. The fleet is a
capacity experiment; its existence does not mean the current encoding sustains
this traffic. The modeled runner supports static full-mesh and line topologies;
it rejects directed topology changes rather than silently ignoring them.

The generated fleet uses `deflate-v1` and a 227-byte application limit. This native limit reserves six bytes for firmware's `SIMULATOR_APP` protobuf wrapper inside its 233-byte buffer; it is a simulator boundary, not a physical-radio calibration. Other configs may explicitly select `frame_encoding: "canonical-json"` for baseline comparison.

Assets publish at offsets 0, 1.6, and 3.2 seconds in each five-second period. Each still publishes every five seconds; the command cadence is unchanged. `createGatewayFleetExperiment({ synchronizedTelemetry: true })` retains the simultaneous-burst stress case. Neither timing choice guarantees delivery of best-effort telemetry, and failed expectations remain failed.

The public experiments export also provides `createGatewayFleetExperiment()` and
`runSimulatedExperiment(config, seed)`. Both runners use the same reactive test
application and production Link transports.

An addressed Gateway Task assignment can include `response: { id, deadline_ms,
message }`, where `message` is a valid Task report for that same Task. The asset
submits this report only after it accepts the exact command. Duplicate deliveries cannot trigger another report. Missing or
rejected commands do not manufacture a response. A late command still triggers
a report, while its missed delivery deadline remains visible. A rejected response
submission remains a visible local admission failure.

The response deadline is measured from the command's scheduled time, so it covers
the outbound trip as well as the return trip. The fleet allows fifteen seconds
for command delivery and thirty seconds for the exchange. Its response is an
immediate synthetic completion report, not physical execution or a Core Task
lifecycle. Payload timestamps are reproducible fixture values; relative schedule,
submission, acceptance, and confirmation times provide measured latency.

## Results and denominators

The JSON artifact keeps the layers separate:

- `outcomes.exchanges` separates command delivery/confirmation, response
  submission/delivery/confirmation, and application round-trip latency. A round
  trip can complete while a transport confirmation is missing. A response that
  was never triggered stays `not_submitted`, and the exchange remains incomplete.
- `outcomes.telemetry` groups receiver delivery counts, maximum sample latency,
  and latest delivered sample age by source Asset. Age uses the publication's
  scheduled sample time and includes the final drain period.
- `summary.scheduled_messages` counts timeline entries; `expected_messages`
  includes conditional responses. `expected_responses` and `triggered_responses`
  keep unreceived commands from disappearing from the exchange accounting.
- `outcomes.messages` records exact decoded-message equality, receiver acceptance,
  sender confirmation, final sender status, deadlines, duplicates, packet
  admissions, and payload bytes per source-scoped operation. Retries remain one
  logical message.
- `message_delivery_failure_rate` counts fully observed, Link-admitted logical
  messages for which at least one expected receiver never accepted the message
  during the observation window. A locally rejected submission is separate.
- `delivery_deadline_failure_rate` counts missed acceptance deadlines. A message
  arriving late is `delivered_late`, not an undelivered message.
- Confirmation failures have their own rates and deadlines. Receiver acceptance
  can succeed while the sender times out waiting for its confirmation.
- `nodes.*.packet_submissions` separates attempts, firmware queue acceptance,
  queue rejection, unique fragments, retransmission admissions, and bytes.
  Queue acceptance is not evidence that a packet was transmitted or received.
- `nodes.*.receive_faults`, `injected_drop_rate`, and `applied_faults` describe
  controlled packet drops and duplicates. The injected-drop denominator is all
  incoming Atlas packets observed by that node during the workload.
- `nodes.*.transport` retains the production retry, repair, queue, and duplicate
  counters. `nodes.*.picture` retains final Shared Picture snapshots.
- `packets` retains raw lab events, counts by event type, and aggregate native RF
  airtime over the workload window, including firmware background traffic. Startup
  and previous-run events are excluded. Missing history invalidates aggregate
  airtime and fails the experiment's evidence gate.

The existing lab history does not supply a complete native per-attempt reception
denominator. `native_packet_loss_rate` is therefore `null`, not zero. `rx_injected`
means that the medium offered a frame to firmware; firmware may still reject it.
`link_disabled` records intentional topology exclusions, not packet loss. Raw
routing-error evidence remains distinct from final Atlas message outcomes.

An interrupted run does not turn unobserved deadlines into measured delivery
failures. A zero denominator produces `null`. Duplicate application acceptance or
payload mismatch fails the expectation even if the sender reports confirmation.

## Boundary and reproducibility

The runner uses the production device adapter, serializer, fragmenter, scheduler,
reassembler, duplicate suppression, settlement, and Shared Picture code. Its TCP
adapter uses length-delimited binary input framing and the official outbound
framing utility. Embedded marker bytes inside a payload are preserved. The fault wrapper neither
reimplements transport retries nor writes directly into a receiver's picture.

The test application accepts matching confirmed inbound messages. Task acceptance
means delivery to this test application, not physical Task execution. A mutation
can be confirmed as received and subsequently fail waiting for an application
response; its final sender status is retained. The runner does not provide Core
persistence or general data-request/response application handlers, and rejects data-request,
data-response, Object-content, and internal-control workloads as initial messages.

These experiments use the lab-configured primary channel. They do not validate
joining, PKI membership exchange, complete Atlas radio-profile convergence, USB
behavior, durable execution fences, or physical RF range. The operator-facing
`serve` command retains its documented USB-only connection path.

Each artifact includes its config hash, lab firmware and build provenance, Node
version, Git revision when available, and content hashes of the actual Link code,
SDK build, and lockfile. Native firmware scheduling is not deterministic. Repeat
experiments and compare delivery, tail latency, and recovery cost rather than
assuming a single pass establishes capacity or field readiness.

The regular package tests run the semantic scenarios through the deterministic
packet network and cover lifecycle restoration and event-history gaps. Native
runs are explicit integration experiments and require the external lab service.
