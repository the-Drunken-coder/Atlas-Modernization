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

Ordinary Gateway starts load this record. They never replace its channel key. Key rotation is intentionally not hidden inside startup.

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
| `GET /v1/operations/:id` | Read a queued, sent, confirmed, responded, rejected, or failed outcome |
| `POST /v1/inbound/:settlement-id/settle` | Application acceptance or rejection of one source-scoped confirmed inbound delivery |
| `POST /v1/subscriptions` | Add, renew, or remove one local client's feed demand |
| `DELETE /v1/clients/:id` | Release all demand for a disconnected local client |
| `GET /v1/metrics` | Bounded transport counters |
| `GET`, `PUT /v1/radio/profile` | Inspect or replace the desired validated profile |
| `POST /v1/radio/profile/apply` | Apply and verify Atlas-owned radio settings |

Task delivery events include `addressed_to_local`, `requires_settlement`, and an opaque source-scoped `settlement_id`. Only the addressed Asset application settles executable Task work using that settlement ID. A `tasks_for_asset` state feed updates the Shared Picture and never invokes this delivery path.

Gateway applications consume `GatewayFieldOperationInbox`, `GatewayFeedDemand`, and `OrderedTaskDispatcher`. These expose intentional field reports, aggregate feed demand, and ordered confirmed Tasks without moving Core credentials or durable Core reconciliation into this package.

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
