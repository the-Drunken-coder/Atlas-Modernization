# Delivery and priority

Meshtastic Link chooses delivery behavior from the meaning of an Atlas message. It does not pretend that every packet needs guaranteed delivery or that radio acceptance proves application handling.

## Delivery classes

| Class | Initial message families | Behavior |
| --- | --- | --- |
| Best-effort publication | Position, telemetry, Tracks, Geofeatures, Object metadata, and other Shared Picture state | Broadcast once without acknowledgements from every listener. Later current-state publication or an explicit request repairs missed information. |
| Confirmed operation | Task assignment and cancellation, data requests and responses, explicit resource writes, and Object transfers | Address one application recipient and require an application-level confirmation, rejection, or bounded failure. The channel still allows every Runtime to inspect the message. |

## Packet size and fragmentation

One Meshtastic packet is an optimization target, not an application limit. The Runtime first serializes the complete Radio contract message. If it does not fit, the transport divides it into bounded numbered chunks and the receiving Runtime reassembles it before delivering the Atlas operation.

Fragmentation is available to every supported message family, including state, Tasks, cancellation, acknowledgements, requests, responses, subscriptions, and Object content. An otherwise valid message is never rejected solely because it needs two or more packets.

Chunks are transport evidence, not Atlas state. They do not enter the Shared Picture and are not exposed as operations to ordinary Runtime clients. Priority applies to the logical message and its pending chunks. Higher-priority work may run between chunks of a lower-priority transfer.

The scheduler reconsiders priority after every emitted chunk. A fragmented message never reserves the transmitter through completion. Cancellation, Task traffic, and other higher-priority work may interrupt a lower-priority transfer, which resumes afterward.

## Task acknowledgement

Radio receipt never acknowledges a Task. Only the assigned Asset application may validate the Task, accept responsibility, place it in its local work state, and send an application acknowledgement.

Other Runtimes may update their Shared Pictures from visible Task traffic. They do not invoke a Task handler or send a response for a foreign Task.

## Missed shared state

Best-effort broadcasts do not ask every listener to reply. Such replies would consume more airtime than the state itself and would not prove that every future listener has the current picture.

Current state is republished at its normal cadence. A Runtime that needs absent or stale state sends a focused data request or creates a Link subscription.

For Asset-originated position, Tracks, telemetry, health, and Task progress, that cadence belongs to the Asset application. Meshtastic Link does not sample the Asset, invent a heartbeat, or decide when state has changed enough to publish.

If a best-effort fragmented publication remains incomplete at its reassembly timeout, the receiver discards it. Listeners do not request its missing chunks because several listeners could create a repair storm. The next current-state publication or a focused request provides recovery.

## Mesh forwarding

Applications do not retransmit a message merely because they overheard it. Meshtastic owns radio flooding, hop limits, and duplicate packet forwarding. A Runtime sends a new message only when it has new Atlas meaning, such as a derived observation or an explicit response.

## Priority

Pending application traffic uses this order:

1. Safety state and cancellation
2. Task control, acknowledgement, progress, and outcomes
3. Data requests and responses
4. Live Asset and Track state
5. Other resource synchronization
6. Object content

Priority governs which pending application message is offered to Meshtastic next. It cannot recall a packet already accepted by the radio or guarantee an RF latency.

## Congestion and coalescing

When submitted traffic exceeds available radio capacity, the Runtime may replace an older unsent best-effort state message with the newest submitted message for the same Atlas record. It does not preserve obsolete intermediate positions, Track updates, telemetry, health, or numeric Task progress merely because they entered the queue first.

Task lifecycle transitions, cancellation, requests, responses, resource writes, and other confirmed operations are never silently dropped or replaced. They remain queued according to priority until confirmed, explicitly rejected, or failed at a bounded deadline. Congestion, replacement, and deadline failure remain visible in metrics and diagnostics.

The Runtime accepts a new confirmed operation only after reserving bounded queue and tracking resources for it. If it cannot make that reservation, it rejects the local submission immediately with an overload result. It never claims an operation is queued and then silently loses responsibility for it.

## Bounded failure

Confirmed operations use stable request or operation identities so retries remain idempotent. Retries are bounded. Exhaustion produces a visible failure for the originating Runtime client and bounded diagnostic evidence. The operation never becomes confirmed merely because retrying stopped.

The initial end-to-end retry deadlines are:

- Fifteen seconds for safety, cancellation, and Task-control delivery
- Thirty seconds for ordinary requests, responses, and resource writes
- Five minutes for Object-content transfer

Reaching the deadline produces an explicit failure. The caller may decide whether a new operation or retry remains appropriate. Exact retry spacing and attempt count within each deadline remain implementation choices to validate against the configured Radio profile.

## Object content

Object metadata may be published as Shared Picture state. Actual Object content crosses the link only after an explicit request. The transfer is application-addressed to the requester, uses the lowest traffic priority, and supports requesting only missing chunks rather than restarting from the beginning. Runtimes that did not request the content do not assemble or store it.

The initial maximum Object-content transfer is 32 KiB. Larger content fails clearly and must use another communication method. This is a deliberate transfer bound, not a refusal caused merely by fragmentation.

Each Runtime emits chunks for at most one Object-content transfer at a time. Additional Object transfers wait in priority order. Routine messages and confirmed operations may still run between the active transfer's chunks.

## Duplicate and stale delivery

Each Runtime start creates a fresh session identity. Messages carry the stable Asset identity, Runtime session identity, and an increasing source sequence. Receivers use those values to reject duplicate delivery and prevent delayed state from replacing newer state from the same source session.

Confirmed operations also carry a stable operation identity. Retrying the same operation cannot create a second physical action or resource mutation.
