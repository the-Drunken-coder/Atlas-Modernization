# Radio contract and wire protocol

Meshtastic Link begins with an honest generated baseline: Atlas Protocol carried over a constrained radio transport. The baseline is intentionally not hand-optimized before its cost is known.

## Source of truth

Atlas Protocol remains the source of truth for resources, Commands, Tasks, lifecycle operations, requests, responses, and validation. The Radio contract and its client bindings are generated from that source.

The initial generator preserves the Atlas Protocol shapes and semantics without selecting a radio-specific subset of fields. It produces a radio-facing equivalent of the Atlas API and SDK rather than a second hand-authored model.

The first baseline serialization is the ordinary compact UTF-8 JSON emitted for Atlas Protocol operations. It adds no presentation whitespace, compression, shortened fields, omitted Protocol fields, or radio-specific representation. The generated serializer makes output deterministic so a repeated logical payload has stable benchmark bytes.

Future optimized encodings may shorten identifiers, use smaller field representations, or introduce purpose-built compact layouts. They remain generated adapters. A decoded optimized message must produce the same Atlas operation as the baseline and pass the same Protocol validation.

## Complete contract does not mean automatic publication

Generating the full Radio contract makes Atlas operations available to the communication method. It does not send every Core resource across the mesh.

The existing policies still govern traffic:

- Asset applications choose which observations and Task reports they publish.
- Gateway subscriptions select which Core state the Gateway proactively publishes.
- The Gateway submits valid Field reports rather than synchronizing the entire Shared Picture.
- Large Object content moves only after an explicit request.

## Link envelope

The transport wraps a generated Atlas payload with only the information needed to move it safely:

- Meshtastic Link protocol revision
- Message family
- Stable, role-tagged source Link node identity for either an Asset or Gateway
- Optional role-tagged destination Link node identity
- Gateway-issued source generation
- Fresh Link service session identity
- Increasing source sequence
- Stable request, Task, or operation identity when applicable
- Fragmentation identity and chunk position when fragmented

These are Link fields, not Atlas resource fields. Atlas Protocol remains unaware of Meshtastic packet boundaries. Link node identity is independent of the attached radio's Meshtastic identity so replacing a radio does not rename an Asset or Gateway.

The Gateway assigns increasing source generations when an Asset joins and increments its own durable generation when the Gateway service starts. Once a receiver accepts a generation for one source Link node, it rejects every lower generation. Source sequence orders messages only within the accepted generation and service session.

## Fragmentation and reassembly

Every supported message may be fragmented. Common messages should eventually fit in one packet, but packet count does not determine whether an Atlas operation is valid.

The sender serializes once, assigns one logical message identity, and divides the bytes into bounded chunks. One encoded Link message is limited to 128 KiB. The receiver enforces both the 233-byte Meshtastic application-frame limit and the aggregate message limit while reassembling, then validates the complete payload before exposing it to the application or Shared Picture. Partial messages expire from bounded transport state and remain visible only in diagnostics.

Confirmed messages can repair missing chunks without retransmitting a completed prefix. A best-effort fragmented publication that remains incomplete at its reassembly timeout is discarded without a missing-chunk request. It is recovered by a later current-state publication or focused request. The exact repair exchange, chunk size, reassembly timeout, and non-Object concurrency bound remain implementation choices for simulation and hardware measurement.

The scheduler reconsiders priority after every chunk. Higher-priority logical messages may interrupt a lower-priority fragmented transfer and the lower-priority transfer resumes afterward. Fragmentation must not allow a large Object to block cancellation or Task traffic.

One Link service emits chunks for at most one Object-content transfer at a time. Other Object transfers remain queued, while routine messages and confirmed operations may proceed between its chunks.

## Radio-suitable Commands

Every Command offered through Meshtastic Link needs a generated radio representation. Commands must not embed large binary or document content in Task input. Such content is transferred as an Object and the Task references its Atlas Object ID.

This is a semantic authoring constraint, not a one-packet guarantee. The unoptimized generated baseline may fragment an otherwise small Task. Measurements then show which representations deserve compact generated forms.

## Task delivery order

Task execution order remains an Atlas application rule, but the radio adapter must preserve enough delivery order for the Asset application to obey it. The Gateway dispatches confirmed Task assignments per Asset in ascending `created_at`, then `task_id`, and waits for application acknowledgement, rejection, or terminal state before delivering the next assignment. A best-effort `tasks_for_asset` feed is picture state and never substitutes for this confirmed ordered path.

## Compatibility

Discovery advertises the Meshtastic Link revision and capabilities. A Gateway rejects a Link service that cannot exchange the required Radio contract instead of allowing it to misinterpret operations.

Compatibility versioning initially belongs only to Meshtastic Link software. A future communications manager that selects Wi-Fi, Meshtastic, or other methods and updates local packages is outside this system's scope.

An operational mesh uses one selected encoding revision. The simulator may compare several encodings, but field Link services do not mix baseline and optimized representations within one joined fleet.

## Object content

Object metadata may be ordinary shared state. Object content is transferred only on request, addressed to that requester, sent at the lowest priority, and repaired by missing chunk. Other Link services do not assemble or retain content they did not request.

The initial maximum content transfer is 32 KiB. Larger Objects require another communication method.
