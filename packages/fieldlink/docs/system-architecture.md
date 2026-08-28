# Atlas FieldLink system architecture

This document records the agreed target architecture. It mixes current
FieldLink behavior with systems that have not been built, so status is explicit
below. Unless a later section says otherwise, it describes planned behavior.

## Architecture status

| Status                   | Scope                                                                                                                                                                                                                                                             |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Implemented in FieldLink | Test, Resource, Runtime, Task, Observation, and Object-content messages; addressed and passive delivery; bounded persistent Picture; local congestion estimates; adapter, two-radio controller, terminal console, and a deterministic four-node fault simulation. |
| Atlas integration        | Not implemented. Future Asset and Gateway applications will own Core access, execution, and delivery policy.                                                                                                                                                      |
| Planned, not implemented | Durable gateway operation relay across process restarts and the one-gateway, three-asset acceptance scenario over four physical radios.                                                                                                                           |
| Still to validate        | Four-radio passive collection and Task isolation, multihop behavior, Core feed recovery during internet loss, sustained Picture storage budgets, and field congestion thresholds.                                                                                 |
| Deferred                 | Radio sender authentication, deny or quarantine behavior, congestion-based traffic control, and transfer recovery across process restarts. FieldLink Track fusion is explicitly out of scope. Future fusion belongs to Atlas Core.                                |

The sections below use direct language to define the target. That language is
not an implementation claim. The table above is the source of truth for what
exists now.

## System shape

Atlas FieldLink connects Atlas Core to radio-equipped assets without moving
Core authority or Asset behavior into the radio transport.

```text
                           Internet

Atlas Core <-> Atlas SDK <-> Gateway application
                                |
                     FieldLink Transport
                                |
                         MeshCore radio
                                )))))
                 shared encrypted MeshCore channel
                  (((((                  (((((
             MeshCore radio         MeshCore radio
                    |                      |
          FieldLink Transport     FieldLink Transport
                    |                      |
            FieldLink Picture      FieldLink Picture
                    |                      |
          Asset application      Asset application
```

One active gateway application bridges one radio mesh to Core. The initial acceptance
exercise uses one gateway and three simulated assets over real radios. The
design target is about twenty assets and one gateway, not an unbounded mesh.

## Ownership

| Owner               | Responsibilities                                                                                                                                                                                     |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Atlas Core          | Durable Atlas resources, the Command Catalog, authoritative Task state and ordering, future Track fusion, and system-wide policy.                                                                    |
| Gateway application | The Atlas SDK and API key, Asset self-registration, Core feed consumption, current-state reconciliation, application durability, proactive Core-state publication, and local congestion observation. |
| FieldLink Transport | Registered message framing, addressing, delivery, fragmentation, reassembly, application priority, retry behavior, delivery evidence, and exposure of valid passive observations.                    |
| FieldLink Picture   | Persistent latest known state, a bounded observation journal, provenance and freshness, and a query interface shared by gateway and asset applications. It performs no fusion.                       |
| Asset application   | Physical behavior, Command handlers, safety, local autonomy, response to link loss, and decisions about whether received information is trustworthy enough to use.                                   |
| MeshCore            | Channel encryption and integrity, RF routing, repeater forwarding, radio-packet duplicate suppression, the radio transmit queue, and the shared Companion inbox.                                     |

FieldLink is semantically transparent to Atlas data, not transparent to time or
bandwidth. Atlas Tasks, Entities, Tracks, GeoFeatures, Object metadata, Object
content, and observations may cross the link through purpose-built message
families. FieldLink is not an arbitrary HTTP tunnel and does not carry API
routes, credentials, or headers over the radio.

## Authority and convergence

Atlas Core remains authoritative. FieldLink uses at-least-once delivery for
operations that must converge. Stable Atlas resource IDs and versions,
FieldLink request IDs, Task IDs, and Asset runtime IDs make repeats safe.
Exactly-once packet delivery is not a system promise.

Push is the fast path. Current-state synchronization is the recovery path. An
asset reconnecting after missed traffic reports its current runtime and known
Task or resource versions. The gateway application returns the current authoritative state,
not a replay of Core's event history. Core feed cursors and changed-since
recovery remain inside the gateway application.

The planned durable gateway journals non-best-effort operations until Core confirms them
or rejects them permanently. It may coalesce or discard stale observations.
Recovering a partially received Object-content transfer across a process
restart is not a current requirement.

The planned disconnected-Core policy does not begin delivering a cached
Task that the asset has never seen. It continues relaying state for work the
asset already accepted and buffers lifecycle reports until it can reconcile
with Core. This avoids beginning work after a cancellation that the gateway
could not observe.

## Asset identity and runtime registration

Every physical asset has a stable, locally configured Atlas Asset ID. The Asset
Entity is disposable. When a running asset registers and Core has no Entity for
that ID, the gateway application creates it through the Atlas SDK and continues runtime
registration. If an operator deletes an online Asset Entity, the asset
automatically recreates it. Deletion is cleanup, not denial or quarantine.

Each Asset process start creates a fresh runtime ID. Runtime registration
and Asset Entity creation are separate operations:

1. The gateway application ensures that the Asset Entity exists.
2. The Asset application begins a new runtime registration.
3. The Asset application establishes its local safe state.
4. The Asset application reports ready with its fixed Command Manifest.
5. The Asset application reports a clean runtime stop when it shuts down.

Radio loss does not define physical behavior. The Asset application and its
Command handlers
decide whether to wait, continue, stop, or take action intended to restore the
link. FieldLink reports delivery and link evidence but does not encode a global
lost-link policy.

## Commands and Tasks

Atlas uses these terms precisely:

- A Command is one Protocol-defined type of operator intent.
- A Task is one assigned execution of one Command.
- A FieldLink message operation is not an Atlas Command.

The Atlas Command Catalog owns the Commands an Asset may advertise. The Asset
application provides its Command Manifest from its installed handlers; it does not discover
executable behavior over the radio. An asset asking "what work do I have?" is
requesting current Tasks, not its Command Catalog.

Tasks are never deleted or manually reordered. Core orders queued work by
`created_at` and then `task_id`. Immediate scheduling is a separate Protocol
rule, not queue reordering.

The target Task message family covers:

- Gateway-to-asset current Task state push
- Asset-to-gateway current-state synchronization
- `acknowledge`, `start`, `progress`, `complete`, and `fail` actions
- Responses carrying the resulting authoritative Task state

Cancellation reaches the Asset application as an authoritative Task state change. There is
no second Asset-side cancellation operation. There is also no generic Task
status setter, Task rejection operation, Task delete, or Task reorder operation.
A rejected Task fails with a structured Atlas reason.

A FieldLink delivery receipt proves message delivery. Task acknowledgement is
different: it means the Asset application validated a queued Task, accepted responsibility,
and placed it in its local queue. Receiving radio bytes never acknowledges a
Task by itself. Only the addressed asset may execute a Task. Other radios may
observe the traffic but must not pass it to a Command handler.

## Message families

The target design uses a small number of broad registered messages instead of
one message ID per action:

| Family         | Purpose                                                                        |
| -------------- | ------------------------------------------------------------------------------ |
| Runtime        | Asset self-registration, runtime begin, ready, stop, and observed Asset state. |
| Task           | State push, synchronization, lifecycle actions, and responses.                 |
| Resource       | Typed Atlas Entity, Object, and Task resource operations.                      |
| Observation    | Compact state updates intended for passive situational awareness.              |
| Object content | Bounded binary content transfer for Atlas Objects.                             |

The current Resource message remains the broad JSON resource operation. Object
content stays out of Resource because it is bytes rather than JSON resource
metadata. The separate Object-content family allows text, JSON, XML, sensor
matrices, and other Atlas Object content to cross FieldLink.

## Passive collection and FieldLink Picture

Every FieldLink radio listens for as much useful state as it can receive. A
producer transmits once and every in-range node may learn from the same traffic.
Addressed request and response remain available when passive collection missed
required state.

FieldLink Transport distinguishes:

- A delivered message addressed to the local node and eligible for its handler
- A passive observation heard by the local node but addressed elsewhere or
  published for shared observation

Passive observation never causes an application acknowledgement, Task handler,
or control response. Assets do not retransmit application messages merely
because they overheard them. MeshCore already owns repeater forwarding and
radio-packet duplicate suppression. A new derived observation may be published
with its own identity and the provenance of its inputs.

FieldLink Picture runs on every asset and gateway. It stores:

- The latest known Entities, Tracks, GeoFeatures, and Object metadata
- State-bearing observations with source, observation time, receive time,
  freshness, and authentication status
- A bounded journal of recent observations

Stale information stays queryable and is marked stale. The bounded journal
evicts its oldest entries when it reaches its storage budget. Foreign Tasks,
runtime control, acknowledgements, and transfer fragments do not enter the
Picture query interface. Diagnostic evidence may record them separately.

FieldLink Picture performs no Track fusion or probabilistic identity matching.
Different IDs remain different records. Future fusion belongs only in Atlas
Core. The Asset application may query the Picture and decide which records and sources are
acceptable for a particular Command.

Proactive publication of relevant Core Entity and Object state is planned. The
gateway application will publish it once so assets can collect it passively. It coalesces pending updates to the latest
state. Tasks remain addressed to their assigned asset, and Object content moves
when produced, requested, or otherwise selected for transfer.

## Object content

FieldLink permits Atlas Object content. It does not ban content because it is a
text file, JSON, XML, or a sensor matrix. Content size still affects airtime and
delivery duration.

Any asset may start an Object-content transfer without a gateway grant. Its
frames use bulk priority. The system does not pause bulk transfers in response
to congestion and does not promise when a large transfer will finish. Higher
priority FieldLink traffic is reconsidered between MeshCore frames.

## Priority

FieldLink uses this application priority order:

1. Safety state, runtime fencing, and cancellation
2. Task delivery and Task lifecycle reports
3. Live Track and Asset observations
4. Resource synchronization and queries
5. Object content

Priority governs which pending FieldLink frame is offered to MeshCore next. It
cannot recall a frame already accepted into MeshCore's transmit queue or promise
RF latency. FieldLink keeps that queue shallow and reconsiders priority between
frames so bulk transfers do not monopolize its own scheduler.

## Congestion monitoring

Each FieldLink node reports a local congestion estimate for observation and
future use.
The first system does not throttle, pause, reject, or reschedule traffic from
that estimate.

The current adapter can observe its attached radio queue length, FieldLink
delivery duration, retransmissions and receipts, plus received SNR and path
length. MeshCore also exposes local transmit and receive airtime and packet
counters that FieldLink may add to the estimate. None of these is a true
mesh-wide channel-utilization measurement. Documentation and user interfaces
must call the result an estimate rather than authoritative congestion.

## Authentication and trust

Radio authentication remains deferred. A MeshCore channel member can currently
spoof a FieldLink Node ID. FieldLink Picture therefore preserves source and
authentication status instead of declaring received data authoritative. Asset
application decides whether a source is trustworthy enough to drive a physical
action.

Asset Entity deletion does not block registration. The architecture contains no
deny list or quarantine mechanism.

## First validation scenario

The planned physical acceptance test uses one gateway application and three
simulated Asset applications over real MeshCore radios. It should demonstrate:

1. Each asset creates its missing Asset Entity and registers a fresh runtime.
2. Core creates a Task for one asset and the gateway pushes it immediately.
3. A deliberately lost Task push is recovered through current-state
   synchronization.
4. The assigned asset acknowledges, starts, and completes the Task without
   another asset executing it.
5. One asset publishes Track state once, while the gateway and the other assets
   collect it passively in their local Pictures.
6. The gateway publishes a Core-originated resource and every asset records it.
7. An Object-content transfer runs at bulk priority while Task traffic is
   selected first between FieldLink frames.
8. The gateway records a local congestion estimate without changing traffic.

The exercise must measure actual sent frames, receipts, repairs, delivery
duration, priority selection, and Picture state. Software simulation does not
claim radio acceptance, and a two-radio transport exercise does not claim this
system behavior.

## Remaining implementation choices

The implementation uses broad Task and Observation JSON messages, raw
Object-content bytes, a bounded file-backed Picture, the existing 1 MiB
encoded-message bound, and one structural peer seam between FieldLink and its
future Atlas applications. The current fault simulation uses one gateway and
three assets with drop, duplicate, and reorder behavior, but it does not model
MeshCore firmware multihop or prove physical RF acceptance. Future work still
must choose measured congestion thresholds, durable gateway relay storage, and
service supervision.
