# Shared Picture

The Shared Picture is the ephemeral latest-known view exposed by each Meshtastic Link service. It lets local software inspect current Atlas state without waiting on a radio request.

## Accepted behavior

- Every Link service has its own Shared Picture.
- It starts empty whenever the Link service starts and is not restored from disk.
- It learns primarily from useful channel traffic that the local Asset did not request.
- State returned for a local request enters the same picture when it represents a supported Atlas record.
- It keeps the latest accepted state for each record rather than a history of updates.
- It may be incomplete and may temporarily differ from the pictures on other nodes.
- In the initial five-radio network, routine publication should normally produce a useful current picture within thirty seconds.

The thirty-second target does not make the picture globally synchronized. The Link service becomes ready when its link and local interface are operational, and the picture warms in the background.

## Required record context

Each record must retain enough context for local software to judge it and for the system to measure duplicate paths:

- Atlas resource type and stable ID
- Latest accepted Atlas state or observation
- Role-tagged source Link node
- Source Asset and Atlas Runtime ID when the Atlas payload provides them
- Source generation, Link service session, and source sequence
- Observation time and local receive time
- Atlas version when available
- Freshness state
- Whether the record arrived directly from a field publisher or through a Gateway feed

These are logical requirements, not a settled storage or wire format.

## Eligible state

The Shared Picture contains the latest accepted state for:

- Assets, including position, telemetry, and health
- Tracks and Track telemetry
- Tasks, including assignment, cancellation, acknowledgement, progress, and outcome
- Geofeatures
- Atlas Object metadata selected for publication

A Task acknowledgement is eligible when it changes the current Task state. Transport-level acknowledgements are not.

An observational `tasks_for_asset` feed may update Task state in the Shared Picture. It does not deliver work to the Asset application. Only the separate addressed and confirmed Task path may invoke the Task handler.

The following remain available only as diagnostic evidence:

- Discovery, joining, and authentication exchanges
- Radio delivery receipts and transport acknowledgements
- Retry and congestion-control messages
- Transfer setup, fragments, and reassembly bookkeeping
- Malformed, rejected, or unsupported messages

## Staleness and removal

Before applying state, the Link service rejects traffic from a source generation older than the newest generation accepted for that Link node. Within the active generation and service session, a lower source sequence cannot replace a higher one. Atlas resource versions still determine order when Core provides them.

Freshness depends on the kind of record:

- Asset position, telemetry, and Track state become stale quickly when expected publications stop. They later leave active query results.
- Active Tasks remain through their terminal outcome and then age out of the Shared Picture.
- Geofeatures and Object metadata remain until a newer version or explicit deletion replaces them. A versioned deletion leaves a hidden in-memory fence so delayed older state cannot recreate the record.

Initial freshness intervals are:

- Asset and Track position becomes stale after five seconds and leaves active query results after thirty seconds.
- Asset telemetry and health becomes stale after thirty seconds and leaves active query results after two minutes.
- A terminal Task remains visible for ten minutes.
- An active Task remains visible if its Asset disappears, but its record reports degraded source connectivity.
- Geofeatures and Object metadata remain until a newer version or explicit deletion replaces them.

An Entity record that carries components with different freshness intervals uses the longest applicable record interval, so expiring position does not discard telemetry or health that is still within its retention window. Component timestamps remain available when a client needs a finer-grained freshness decision.

These intervals are Link defaults and may later be tuned from scenario and field evidence. They do not define how often Asset software publishes. Every returned record exposes its freshness so local software does not have to infer it from payload contents.

## Not operational history

Replacing a record removes the older value from the Shared Picture. Atlas Core may retain durable history, and the Link service may emit bounded diagnostic evidence, but neither is part of the Shared Picture interface.

## Implementation detail

Exact HTTP routes and event names remain implementation details. [`service-interface.md`](service-interface.md) fixes the logical snapshot and live-update behavior.
