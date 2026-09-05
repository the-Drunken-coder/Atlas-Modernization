# Atlas Meshtastic Link

This Node 24 workspace implements the Atlas Meshtastic Link described in [`docs/atlas-meshtastic-link`](../../docs/atlas-meshtastic-link/README.md). It owns the radio-facing Atlas contract, packet transport, Shared Picture, local service, Radio profile convergence, Gateway membership, dynamic joining, and deterministic packet simulation. It does not own Atlas Core access or Asset behavior.

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
| `POST /v1/subscriptions` | Add, renew, or remove one local client's feed demand |
| `DELETE /v1/clients/:id` | Release all demand for a disconnected local client |
| `GET /v1/metrics` | Bounded transport counters |
| `GET`, `PUT /v1/radio/profile` | Inspect or replace the desired validated profile |
| `POST /v1/radio/profile/apply` | Apply and verify Atlas-owned radio settings |

Task delivery events include `addressed_to_local`, `requires_settlement`, and an opaque source-scoped `settlement_id`. Only the addressed Asset application settles executable Task work using that settlement ID. A `tasks_for_asset` state feed updates the Shared Picture and never invokes this delivery path.

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

## Checks

```sh
npm run build:sdk
npm run check --workspace @the-drunken-coder/atlas-meshtastic-link
```

The check regenerates the Radio contract from the canonical Protocol schema, verifies that the checked-in output has not drifted, formats and lints the workspace, type-checks it, runs the deterministic suite, and builds the executable package.

The serial adapter pins `@meshtastic/protobufs` 2.7.8 to match the schema bundled in `@meshtastic/core` 2.6.7. The `@meshtastic/protobufs-firmware` alias supplies schema 2.8.0 for the firmware's device-telemetry switch. Typed binary conversion preserves that field across the older SDK's read and write path.
