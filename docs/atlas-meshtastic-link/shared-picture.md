# Shared Picture

The Shared Picture is the ephemeral latest-known view exposed by each Meshtastic Link Runtime. It lets local software inspect current Atlas state without waiting on a radio request.

## Accepted behavior

- Every Runtime has its own Shared Picture.
- It starts empty whenever the Runtime starts and is not restored from disk.
- It learns primarily from useful channel traffic that the local Asset did not request.
- State returned for a local request enters the same picture when it represents a supported Atlas record.
- It keeps the latest accepted state for each record rather than a history of updates.
- It may be incomplete and may temporarily differ from the pictures on other nodes.
- In the initial five-radio network, routine publication should normally produce a useful current picture within thirty seconds.

The thirty-second target does not make the picture globally synchronized. The Runtime becomes ready when its link and local interface are operational, and the picture warms in the background.

## Required record context

Each record must retain enough context for local software to judge it and for the system to measure duplicate paths:

- Atlas resource type and stable ID
- Latest accepted Atlas state or observation
- Source Asset and Runtime when known
- Observation time and local receive time
- Atlas version or source sequence when available
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

The following remain available only as diagnostic evidence:

- Discovery, joining, and authentication exchanges
- Radio delivery receipts and transport acknowledgements
- Retry and congestion-control messages
- Transfer setup, fragments, and reassembly bookkeeping
- Malformed, rejected, or unsupported messages

## Staleness and removal

Freshness depends on the kind of record:

- Asset position, telemetry, and Track state become stale quickly when expected publications stop. They later leave active query results.
- Active Tasks remain through their terminal outcome and then age out of the Shared Picture.
- Geofeatures and Object metadata remain until a newer version or explicit deletion replaces them.

Initial freshness intervals are:

- Asset and Track position becomes stale after five seconds and leaves active query results after thirty seconds.
- Asset telemetry and health becomes stale after thirty seconds and leaves active query results after two minutes.
- A terminal Task remains visible for ten minutes.
- An active Task remains visible if its Asset disappears, but its record reports degraded source connectivity.
- Geofeatures and Object metadata remain until a newer version or explicit deletion replaces them.

These intervals are Link defaults and may later be tuned from scenario and field evidence. They do not define how often Asset software publishes. Every returned record exposes its freshness so local software does not have to infer it from payload contents.

## Not operational history

Replacing a record removes the older value from the Shared Picture. Atlas Core may retain durable history, and the Runtime may emit bounded diagnostic evidence, but neither is part of the Shared Picture interface.

## Implementation detail

Exact HTTP routes and event names remain implementation details. [`runtime-interface.md`](runtime-interface.md) fixes the logical snapshot and live-update behavior.
