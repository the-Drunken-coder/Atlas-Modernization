# Atlas Meshtastic Link

This Node 24 workspace implements the Atlas Meshtastic Link described in [`docs/atlas-meshtastic-link`](../../docs/atlas-meshtastic-link/README.md). It owns the radio-facing Atlas contract, packet transport, Shared Picture, local service, Radio profile convergence, Gateway membership, dynamic joining, and deterministic packet simulation. It does not own Atlas Core access or Asset behavior.

The Radio contract generator checks Protocol definitions and revisions. Operation coverage is checked against the public Atlas SDK, with exhaustive input, output, and context validation; see the [generation boundary](../../docs/atlas-meshtastic-link/wire-protocol.md#source-of-truth).

## What runs

One `atlas-meshtastic-link` service runs on each Asset Host and on the Gateway. Both modes use the same static Radio profile and USB serial adapter.

Asset mode clears old private membership, advertises on the public rendezvous channel, authenticates with the Gateway using a public-key-encrypted direct exchange, installs current private membership, and then starts normal Link transport. Gateway mode loads its durable membership, increments its own durable source generation, installs the membership locally, and admits Assets without joining through itself.

The initial authentication policy mutually proves a provisioned join key with HMAC-SHA256 before either side accepts the exchange. It is isolated behind the documented policy interfaces. The join key is separate from the private Meshtastic channel key.

## Radio requirements

- Meshtastic firmware 2.7.15 or newer, with one exact tested patch selected in the profile
- macOS USB serial path under `/dev/cu.*`
- US region and an explicitly selected frequency slot
- `SHORT_FAST`, hop limit 3, `CLIENT`, and `LOCAL_ONLY`
- Native position, telemetry, MQTT, managed mode, remote administration, and power saving disabled

The service changes only Atlas-owned settings and verifies the complete readback before joining or transmitting. The private channel key is never stored in the static profile.

Serial application sends complete when the attached firmware reports a matching successful `QueueStatus`, with a 15-second local acceptance deadline. They do not request a Meshtastic routing acknowledgement. Atlas application confirmation remains a separate exchange. Disconnect and shutdown reject pending sends and cancel writes that have not started; configuration and application traffic share one serial writer.

Generate a profile after selecting the field frequency slot and exact tested firmware:

```sh
npm run meshtastic-link -- profile \
  --frequency-slot 20 \
  --tested-firmware 2.7.15 > atlas-radio-profile.json
```

The values above are examples, not field selections. Do not deploy them without the required survey and firmware trial.

## Gateway initialization

Create one join-key file and provision the same file to each authorized companion computer. Then initialize the Gateway membership once:

```sh
umask 077
openssl rand 32 > atlas-join.key
npm run meshtastic-link -- gateway-init \
  --membership /var/lib/atlas/meshtastic-membership.json \
  --gateway-id gateway-main \
  --channel-index 1
```

The service rejects join-key and membership files that are symlinks, are not owned by the service user, or grant any group or other permissions.

Ordinary Gateway starts load this record. They never replace its channel key. Key rotation is intentionally not hidden inside startup. Run only the documented single Gateway-mode service against a membership record; concurrent Gateway processes are not a supported deployment.

## Service

Start Gateway mode:

```sh
npm run meshtastic-link -- serve \
  --mode gateway \
  --node-id gateway-main \
  --serial /dev/cu.usbmodem0001 \
  --profile atlas-radio-profile.json \
  --join-key-file atlas-join.key \
  --membership /var/lib/atlas/meshtastic-membership.json
```

Start Asset mode:

```sh
npm run meshtastic-link -- serve \
  --mode asset \
  --node-id asset-alpha \
  --serial /dev/cu.usbmodem0002 \
  --profile atlas-radio-profile.json \
  --join-key-file atlas-join.key
```

Use `serve --frame-encoding message-v1` on every service in an experimental fleet to enable adaptive lossless message compression and combine an explicit acceptance receipt with an immediately queued single-frame Task report when both fit. Delayed or larger reports keep separate receipts. `binary-v1`, `deflate-v1`, `deflate-v2`, and `deflate-v3` remain available for comparison. Messages that already fit one packet retain the binary-v1 path; larger messages can compress before fragmentation without recompressing their bodies in each frame. Optional `--adaptive-retries` and `--state-deltas` enable the additional experimental modes; neither is enabled by default because their latency and freshness tradeoffs depend on load. The default `canonical-json` retains the measured baseline. Commands, reports, and Shared Picture publications use private-channel broadcast; Atlas carries application destinations and confirmations. See [the wire contract](../../docs/atlas-meshtastic-link/wire-protocol.md) for encoding and compatibility details. See [whole-message compression results](experiments/MESSAGE-COMPRESSION.md) for the fixture measurements and 240-run modeled comparison.

`serve --frame-encoding message-v2` additionally compares dictionary DEFLATE, Brotli, and dictionary Zstandard over three lossless value representations, including packed integers, UUIDs, and per-message string references. It selects using complete framed bytes and fragment count, retaining the previous encoding whenever it wins. Use Node 24.6 or newer in the Node 24 release line and compatible Link software on every participant. See [current validation after rebasing onto main](experiments/MAIN-REBASE-VALIDATION.md) for measurements against `message-v1`. Earlier [compression method results](experiments/COMPRESSION-METHODS.md) describe the pre-rebase contract.

The service binds `127.0.0.1:7331` by default. Its normal interface is:

| Method and route | Purpose |
| --- | --- |
| `GET /v1/status` | Service, join, picture, and queue state |
| `GET /v1/picture` | Atomic current Shared Picture snapshot |
| `GET /v1/picture/events?session=...&after=...` | Gap-free picture SSE stream |
| `GET /v1/events?after=...&client_id=...` | Link operation and addressed-message SSE stream |
| `POST /v1/messages` | Submit a validated Radio contract message |
| `POST /v1/tasks/:asset_id` | Enqueue one validated Task assignment or cancellation in Gateway order |
| `POST /v1/tasks/:asset_id/assignments` | Enqueue a validated ordered batch of Task assignments atomically |
| `POST /v1/tasks/:asset_id/authoritative` | Reconcile one terminal authoritative Task observation |
| `GET /v1/tasks/:asset_id` | Read the Gateway Task dispatcher state for one Asset |
| `GET /v1/operations/:id` | Read a queued, sent, confirmed, responded, rejected, or failed outcome |
| `POST /v1/inbound/:settlement-id/settle` | Application acceptance or rejection of one source-scoped confirmed inbound delivery |
| `POST /v1/inbound/:settlement-id/settle-task` | Atomically accept a Task and enqueue its already available lifecycle report |
| `POST /v1/subscriptions` | Add, renew, or remove one local client's feed demand |
| `DELETE /v1/clients/:id` | Release all demand for a disconnected local client |
| `GET /v1/metrics` | Bounded transport counters |
| `GET`, `PUT /v1/radio/profile` | Inspect or replace the desired validated profile |
| `POST /v1/radio/profile/apply` | Apply and verify Atlas-owned radio settings |

Task delivery events include `addressed_to_local`, `requires_settlement`, and an opaque source-scoped `settlement_id`. Only the addressed Asset application settles executable Task work using that settlement ID. A `tasks_for_asset` state feed updates the Shared Picture and never invokes this delivery path.

When the Asset already has a Task report available, `POST /v1/inbound/:settlement-id/settle-task` accepts `{ report, destination?, operation_id? }`. It validates the Task relationship and reserves both queue entries before accepting the command. A successful `202` response contains `{ accepted: true, receipt, report }`; a `409` leaves the inbound command unsettled and queues neither item. The receipt and report retain separate delivery outcomes. Repeating the same settlement and report replays the original admission response for the ten-minute settlement retention window; changing its report, destination, or supplied operation ID fails explicitly. Current delivery outcomes remain available through the operation routes. Do not delay command acceptance to wait for work to finish: use ordinary settlement first and publish the report later when needed. The programmatic equivalent is `settleInboundWithTaskReport` on the transport, service, and Radio SDK.

`TelemetryPublisher` is an opt-in application helper for five-second or other fixed publication cadences. It chooses a stable per-node phase, samples at the scheduled emission, skips missed ticks instead of accumulating a backlog, and discards an async sample that has become a full period old. Normal message submission and command priority are unchanged. Sampling and publication callbacks must settle: stopping cancels future scheduling, but cannot cancel an arbitrary Promise, and a restart waits for any previous callback to finish so unresolved work cannot accumulate.

```ts
const telemetry = new TelemetryPublisher({
  clock: new RealClock(),
  nodeID: "asset-a",
  periodMs: 5_000,
  sample: (sampledAt) => readCurrentState(sampledAt),
  publish: (publication) => radioSDK.publish(publication),
  onError: (error) => console.error(error)
});
telemetry.start();
// Call telemetry.stop() when the owning application shuts down.
```

Omit `after` from `GET /v1/events` to start with future events. Supply a previous event ID to replay retained events before following live changes. An explicit expired cursor returns HTTP 400; clients can query operation outcomes and reconnect without a cursor. Picture snapshot recovery uses the separate picture stream.

`POST /v1/messages` accepts `{ message, destination?, operation_id? }` for the ordinary Radio contract. A `task_delivery` message submitted there is rejected with guidance to the Task routes so Gateway callers cannot bypass ordered dispatch. A client retrying a confirmed write supplies the same `operation_id`; data requests and requested Object-content responses use their `request_id` as that stable identity. Task reports carry the Asset application's original `observation_time`, so radio delay does not make an old lifecycle report appear newer.

Gateway applications supply Core-derived Task resources through the loopback Task routes. The Link service owns one `OrderedTaskDispatcher` for its attached Gateway transport, preserving per-Asset order, bounded capacity, cancellation priority, and replay of a failed first assignment. `POST /v1/tasks/:asset_id/assignments` accepts `{ tasks }`; the single route accepts `{ task, delivery }`; and the authoritative route accepts `{ task }` only for a terminal Task. Every Task's `asset_id` must match the route, and a batch is validated completely before any enqueue. `GET /v1/tasks/:asset_id` reports only local dispatcher state: the in-flight Task and its operation ID, an optional cancellation attempt with its Task and operation IDs, and queued Task IDs. It does not report Core authority or evidence that a Task has executed.

Gateway applications may still use `GatewayFieldOperationInbox` and `GatewayFeedDemand` for intentional field reports and aggregate feed demand. These seams do not move Core credentials, durable Core reconciliation, or radio ownership into the Link package.

Radio configuration commands are thin clients of the running loopback service. They never open the serial device independently:

```sh
npm run meshtastic-link -- radio show
npm run meshtastic-link -- radio set --profile atlas-radio-profile.json
npm run meshtastic-link -- radio apply
```

## Baseline simulation

Run the canonical one-Gateway, four-Asset scenario or the initial position slice:

```sh
npm run meshtastic-link -- benchmark --scenario canonical --seed 42
npm run meshtastic-link -- benchmark --scenario stress --seed 42
npm run meshtastic-link -- benchmark --scenario vertical-slice --seed 42
```

After an intentional benchmark or metrics change, refresh all three exact seed-42 snapshots with
`npm run baseline:update --workspace @the-drunken-coder/atlas-meshtastic-link` and review the resulting JSON diff.

The checked-in results under [`baselines`](baselines) measure the ordinary deterministic Atlas JSON contract through the production SDK, serializer, fragmenter, scheduler, reassembler, and Shared Picture receive path. The full-rate normal and stress baselines record deadline and convergence failures honestly. They are comparison data, not field performance claims. The packet model remains uncalibrated until the documented three-radio hardware trial is completed.

## Native firmware experiments

The Atlas-owned experiment runner controls Meshtastic Lab programmatically and
reports packet observations, complete-message delivery, application acceptance,
confirmation, deadlines, and recovery cost separately. See
[`experiments/README.md`](experiments/README.md) for runnable workloads, result
semantics, and the laboratory configuration boundary.

## Checks

```sh
npm run build:sdk
npm run check --workspace @the-drunken-coder/atlas-meshtastic-link
```

The check regenerates the Radio contract from the canonical Protocol schema, verifies that the checked-in output has not drifted, formats and lints the workspace, type-checks it, runs the deterministic suite, and builds the executable package.

The serial adapter pins `@meshtastic/protobufs` 2.7.8 to match the schema bundled in `@meshtastic/core` 2.6.7. The `@meshtastic/protobufs-firmware` alias supplies schema 2.8.0 for the firmware's device-telemetry switch. Typed binary conversion preserves that field across the older SDK's read and write path.

The [second optimization report](experiments/FURTHER-OPTIMIZATION.md) covers combined receipts, subscription renewal traffic, compact join acceptance, and native queue observations. Run `npx tsx scripts/compare-fleet.ts new-comparison.json` from this package to compare v2 and v3 using ten reproducible seeds on each of SHORT_FAST and SHORT_TURBO. This comparison uses the same current implementation on both sides; native before/after results use a frozen earlier implementation.

The [latency and bandwidth comparison](experiments/LATENCY-AND-BANDWIDTH.md) records the binary codec, atomic acceptance/report API, telemetry scheduler, optional retry/update modes, and their measured tradeoffs.
