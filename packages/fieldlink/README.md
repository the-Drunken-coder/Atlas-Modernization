# Atlas FieldLink

FieldLink delivers registered binary messages through one MeshCore Companion USB radio. The public module is `FieldLinkNode`. A thin NDJSON adapter exposes the same interface across a process boundary, and the local `fieldlink test` command starts two adapters to prove a real RF echo.

```text
Atlas-side caller
  -> FieldLinkNode or adapter process
  -> MeshCore Companion USB radio
  -> MeshCore channel and RF mesh
```

FieldLink does not flash firmware, write radio configuration, change channels, or replace MeshCore routing. It uses MeshCore channel data type `0xFFFF`, flood delivery, and the 163-byte channel-datagram limit.

## Project status

Only the first row describes code that exists in this repository today.

| Status                   | Scope                                                                                                                                                                                                                                                                                                                   |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Implemented now          | Registered Test, Resource, Runtime, Task, Observation, and Object-content messages; priority-aware delivery; passive publication and reassembly; bounded persistent FieldLink Picture; local congestion estimates; the adapter, two-radio controller, terminal console, and a deterministic four-node fault simulation. |
| Application integration  | Not implemented in this monorepo. Future Asset and Gateway applications will own Core access, execution, and delivery policy.                                                                                                                                                                                           |
| Planned, not implemented | Durable gateway operation journaling and the one-gateway, three-asset acceptance exercise over four real radios.                                                                                                                                                                                                        |
| Still to validate        | Four-radio passive collection and Task isolation, multihop behavior, Core feed recovery during internet loss, and operational storage budgets under sustained traffic.                                                                                                                                                  |
| Deferred                 | Radio sender authentication, a deny or quarantine system, congestion-based traffic control, and transfer recovery across process restarts. FieldLink Track fusion is not planned. Future Track fusion belongs to Atlas Core.                                                                                            |

FieldLink does not contain an Edge Gateway, Asset Host, Atlas SDK client, API
key, or Atlas request executor. Applications provide those policies on each
side of the link. They consume `FieldLinkNode` or `AdapterProcessNode` through
the package's public interface.

## Requirements

- Node.js 24
- Python 3 for the optional terminal console
- MeshCore.js 1.13.0
- MeshCore Companion USB firmware with channel-data support
- A shared non-empty channel configured in the same slot on both radios
- Two dedicated radios with matching LoRa and channel settings for hardware testing
- Four radios for the complete one-gateway, three-asset acceptance mission

Install exactly from the lockfile:

```bash
npm ci
```

## FieldLinkNode

```ts
import { FieldLinkNode, type FieldLinkTransport } from "atlas-fieldlink";

async function sendTest(nodeId: string, transport: FieldLinkTransport) {
  const node = new FieldLinkNode({ nodeId, transport });

  const unsubscribe = node.onMessage((received) => {
    console.log(received.source, received.message);
  });

  try {
    return await node.send(
      {
        type: "test",
        kind: "request",
        correlationId: 1,
        payload: Uint8Array.of(1, 2, 3),
      },
      {
        destination: "0123456789abcdef",
        priority: "normal",
        retryStrategy: "selective-window",
      },
    );
  } finally {
    unsubscribe();
    await node.close();
  }
}
```

The module exposes this interface:

```ts
send(message, {
  destination,
  priority?,
  retryStrategy?,
  signal?,
}): Promise<SendResult>

publish(observation, {
  priority?,
  signal?,
}): Promise<PublishResult>

onMessage(listener): () => void
onPassiveMessage(listener): () => void
onEvent(listener): () => void
congestion(): Promise<FieldLinkCongestionSnapshot>
close(): Promise<void>
```

A Node ID is the first eight bytes of the SHA-256 hash of a MeshCore public key, written as 16 lowercase hexadecimal characters. It is an address, not proof of identity. Any member of the MeshCore channel can spoof a FieldLink source or destination Node ID. FieldLink relies on MeshCore channel membership as its only sender trust.

## Messages

Message-specific behavior lives in one file under `src/messages/`. A message definition owns its stable `uint16` ID, name, default priority, runtime validation, binary codec, examples, hardware exercise, passive-observation eligibility, and optional inbound handler. FieldLink registers Test as ID 1, Resource as ID 2, Runtime as ID 3, Task as ID 4, Observation as ID 5, and Object content as ID 6.

The explicit registry is `src/messages/index.ts`. Adding a message requires one new message file and one registry entry. Startup rejects duplicate IDs or names. Generic contract tests validate every registered example and codec round trip.

The hardware exercise constructs a representative message and recognizes successful end-to-end delivery. This keeps message-specific test input and completion rules in the message file while the CLI continues to own radios, transport, evidence, and timing.

Test has request and response variants. Both carry a `uint32` correlation ID and arbitrary bytes. A received request is echoed to its source with identical correlation and payload. A response is delivered to listeners and never echoed.

Resource carries a typed UTF-8 JSON envelope for Entity and Object CRUD plus Task reads. Create and patch bodies use Atlas JSON; Object bodies are metadata only. Every request has a `request_id`, and every response returns the same ID, a numeric status, and an optional JSON body. Resource carries no HTTP routes or credentials. The two-radio test uses a canned responder to prove that exact request and response JSON cross RF; it does not call Atlas. See the [Resource message contract](docs/messages/resource.md).

Runtime carries Asset registration, readiness, check-in, and stop requests as
UTF-8 JSON. FieldLink validates only the transport envelope. A future
Asset or Gateway application must validate Atlas Protocol
bodies and own any Asset or Gateway state. See the [Runtime message
contract](docs/messages/runtime.md).

Task carries current-state push, current-Task synchronization, and explicit
`acknowledge`, `start`, `progress`, `complete`, and `fail` actions. It has no
generic status setter, delete, reorder, or asset-side cancel operation. See the
[Task message contract](docs/messages/task.md).

Observation carries Entity, Track, GeoFeature, and Object metadata snapshots.
`publish()` sends one best-effort copy to the MeshCore channel. Every hearing
FieldLink node may reassemble it into Picture without sending receipts or
invoking an addressed handler. Required state can still be recovered with an
addressed request. See [passive state and Picture](docs/messages/observation.md).

Object content carries raw bytes with an Object ID and optional content type.
It defaults to bulk priority and avoids base64 expansion. The encoded message,
including its small header, remains subject to the 1 MiB FieldLink bound. See
the [Object-content contract](docs/messages/object-content.md).

## Delivery

An encoded message of 132 bytes or less uses one complete FieldLink frame. Larger messages use an in-memory transfer with 132-byte fragments. The maximum encoded message is 1 MiB.

Every FieldLink frame submission carries a 16-bit transmission ID. MeshCore can suppress duplicate RF copies of one submission, while an intentional FieldLink retry has a new ID and reaches the receiver. Fragment indexes and logical transfer IDs still make reassembly idempotent.

FieldLink ships `selective-window`, retry strategy ID 1:

- The receiver accepts the transfer before fragments are sent.
- The sender transmits windows of eight fragments.
- A one-byte receipt bitmap identifies received fragments.
- Only missing fragments are repaired.
- Transfer open waits 5 seconds. Each window allows five repair rounds. A receipt request waits 30 seconds
  and is retried once before any fragment repair.
- Completion is sent only after length and SHA-256 validation.

FieldLink permits one active outbound transfer, four active addressed inbound transfers, four passive inbound transfers, and 64 pending sends per node. Completed-transfer replay tombstones are bounded separately at 64. Only one frame is offered to MeshCore at a time. High, normal, and bulk queues are reconsidered between frames, and lower-priority outbound frames yield while a higher-priority inbound transfer is active. Core Stats `queueLen` keeps the radio queue shallow. Inactive inbound state expires after two minutes.

Observation publication is deliberately unconfirmed. It sends a complete frame
or one transfer start followed by every fragment once. Listening nodes do not
reply, so publication cannot create a receipt storm. Addressed delivery remains
the recovery path when an asset requires missing state.

Transfers are not persisted. Restart, disconnect, shutdown, abort, or exhausted retries fail the transfer and require the caller to send it again. FieldLink does not add compression, persistent resume, replay protection, or signatures.

MeshCore remains responsible for channel encryption and integrity, RF routing, repeater forwarding, radio-packet duplicate suppression, its transmit queue, and the shared Companion inbox. FieldLink adds only message framing, destination filtering, transfer reassembly, selective repair, application priority, and delivery evidence that MeshCore does not provide.

## Commands

List current USB serial radio candidates:

```bash
npm run fieldlink -- radios list
```

On macOS, discovery reads current `/dev/cu.*` entries and keeps USB serial and USB modem callout paths. It hides Bluetooth, debug-console, audio, and other unrelated serial endpoints. A listed path is still unverified. The adapter confirms MeshCore Companion identity and capabilities during preflight before any test traffic is sent.

List the message registry and its runnable payload presets:

```bash
npm run fieldlink -- messages list
npm run fieldlink -- messages list --json
```

Run one deployed adapter process:

```bash
npm run fieldlink -- adapter \
  --radio /dev/cu.usbmodem-A \
  --channel 1 \
  --output results/adapter-A \
  --allow-inbox-drain
```

The adapter creates `events.jsonl` in the output directory before opening the radio and records every consumed Companion inbox item there. It reserves stdout for typed NDJSON and sends diagnostics to stderr. Its `ready` event includes safe radio identity, selected channel metadata, Node ID, supported messages, retry strategies, and delivery limits. `Uint8Array` values cross NDJSON as base64.

Run a two-radio Test echo:

```bash
npm run fieldlink -- test \
  --a /dev/cu.usbmodem-A \
  --b /dev/cu.usbmodem-B \
  --message test \
  --payload-size 64 \
  --retry-strategy selective-window \
  --timeout-ms 1800000 \
  --allow-inbox-drain
```

`--payload-size` is the selected message's exercise payload, excluding its message-local envelope. Each message advertises its own default and presets through `messages list`. Exercise input proves delivery only; it does not call Atlas. The overall test timeout defaults to 30 minutes.

To exercise one exact Resource request and response across the radios, pass a
Resource request JSON file:

```bash
npm run fieldlink -- test \
  --a /dev/cu.usbmodem-A \
  --b /dev/cu.usbmodem-B \
  --message resource \
  --resource-request request.json \
  --retry-strategy selective-window \
  --allow-inbox-drain
```

The CLI validates the JSON before opening a radio. After preflight, radio B's
test responder returns a correlated `200` response that identifies itself as a
test responder. This proves FieldLink framing, transfer recovery, JSON
preservation, and response correlation. It does not prove Atlas API behavior.

Runtime and Task request files use the same transport-only responder:

```bash
npm run fieldlink -- test \
  --a /dev/cu.usbmodem-A \
  --b /dev/cu.usbmodem-B \
  --message runtime \
  --runtime-request runtime.json \
  --retry-strategy selective-window \
  --allow-inbox-drain
```

Use `--task-request task.json` with `--message task` for a Task request. Actual
Atlas execution is future Asset and Gateway application work. The FieldLink
tests stop at the transport interface.

Before starting the adapters, the controller asks MeshCore for every channel slot available on both radios. It chooses the lowest configured slot whose name and key fingerprint match exactly. This inspection does not write radio configuration or transmit RF. If no slot matches, the test stops with an error. `--channel <index>` skips automatic selection and forces one slot for diagnostics.

The controller then starts one adapter per radio, verifies distinct identities and matching LoRa and selected-channel settings, and sends one deterministic Test request from A to B. B's registered handler echoes it. The test passes only when A receives the matching response with identical bytes, any fragmented response finishes, cleanup succeeds, and neither adapter reports a listener or protocol error.

## Terminal console

Run the standard-library Python console from the repository root:

```bash
npm run fieldlink:tui
```

Use the arrow keys and Enter to select a registered message, source radio, destination radio, input, and retry strategy. The console reads both lists from the real FieldLink CLI. Radio entries are USB serial candidates and remain marked unverified until MeshCore preflight succeeds. FieldLink finds the shared MeshCore channel automatically and shows the chosen slot in the live log.

Test offers these presets:

- 64 payload bytes in one frame
- 127 payload bytes, the largest Test payload that fits in one frame
- 4096 payload bytes across 32 fragments
- a custom size up to the message limit

When you select Resource, the console shows operation-aware fields on the left
and the generated request JSON on the right. Choose `create`, `get`, `list`,
`patch`, or `delete`; select the allowed resource type; fill its ID, page query,
or body; then press `s` to continue. Body JSON uses a multiline editor where
Ctrl-G saves. The console skips synthetic payload selection, displays the exact
request, and shows radio B's correlated test response in the transcript. A
manual CLI run can still use `--payload-size` for a synthetic Resource response.

Runtime appears in the console's registered-message list and its synthetic
payload exercise is available there. Editing and executing real Runtime JSON is
CLI-only in this slice. The console does not yet have a Runtime form.

The test starts after retry-strategy selection. During the run, the console shows the CLI's RF and inbox-drain warning, then follows `events.jsonl` for frames, fragmentation, receipts, retransmissions, delivery on both radios, SNR, errors, and cleanup. The header, events, and statistics form one scrolling transcript. It follows new events until you press the up arrow, then holds that position while more events arrive. Press the down arrow to return to the bottom. Press `q` to stop cooperatively.

When a test starts, the console replaces `tools/results.txt` with a human-readable transcript of that run. The exact Resource request JSON is at the top, events are flushed into the file while the test runs, and the decoded response is at the bottom after the run finishes. The normal timestamped `manifest.json`, `events.jsonl`, and `summary.json` under `results/` remain the complete machine-readable evidence and are not overwritten. The console does not implement radio or delivery behavior itself. It launches `fieldlink test` and renders its evidence.

## Inbox and evidence safety

MeshCore exposes one shared Companion inbox containing channel data, channel text, and contact messages. FieldLink must drain the complete inbox while it runs. `--allow-inbox-drain` is an explicit acknowledgement of that behavior.

Before either radio opens, `fieldlink test` creates:

- `manifest.json` with requested test inputs
- `events.jsonl` for streamed inbox, frame, message, fragment, receipt, retry, SNR, interruption, error, and cleanup evidence
- `summary.json` with an initial `running` state that is replaced by the final or partial result

The final summary records request and response delivery separately. Each side
includes encoded bytes, fragments, retransmissions, receipts, and sender
duration when available, including receipt requests and their retries for
transfers. Verification reports response correlation, the fragment digest when
a transfer was used, and the application status carried by a Resource, Runtime,
or Task response. A successful
run is `clean` when neither direction needed recovery and `recovered` when a
fragment repair or receipt-request retry succeeded. Listener and protocol errors
make the final run fail even if the expected response arrived first.

Each adapter also creates `adapters/a/events.jsonl` or `adapters/b/events.jsonl` before opening its radio. It appends every consumed inbox item to that local file before sending the item to the controller. The root `events.jsonl` remains the combined test transcript.

The default directory is `results/<timestamp>-test/`. Existing evidence is never overwritten. Full public keys and channel keys are never written or exposed by the process adapter.

Use dedicated test radios. Automated validation never transmits RF. A hardware run requires explicit authorization and confirmed `/dev/cu.*` paths.

## Development

```bash
npm ci
npm run check
git diff --check
```

Start at [`docs/README.md`](docs/README.md) for the dictionary and design decisions.
