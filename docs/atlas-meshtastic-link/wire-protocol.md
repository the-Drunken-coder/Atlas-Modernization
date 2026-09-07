# Radio contract and wire protocol

Meshtastic Link begins with an honest generated baseline: Atlas Protocol carried over a constrained radio transport. The baseline is intentionally not hand-optimized before its cost is known.

## Source of truth

Atlas Protocol remains the source of truth for resources, Commands, Tasks, lifecycle operations, requests, responses, and validation. The Radio contract and its client bindings are generated from that source.

The initial generator preserves the Atlas Protocol shapes and semantics without selecting a radio-specific subset of fields. It produces a radio-facing equivalent of the Atlas API and SDK rather than a second hand-authored model.

The current Protocol schema defines resource shapes and validators, but has no endpoint operation catalog. The baseline generator therefore validates its operation adapters against Protocol definitions and the Protocol revision, and a parity test compares the generated operation names with the public Atlas SDK resource, Runtime, query, catalog, and Plugin methods. Local watches and sync/feed lifecycle helpers are excluded. Input, output, and context validation switches are exhaustive over the generated operation names. This catches drift in existing SDK operation families; adding a new SDK family or a Protocol operation that the SDK does not expose still requires extending the adapter coverage.

The first baseline serialization is the ordinary compact UTF-8 JSON emitted for Atlas Protocol operations. It adds no presentation whitespace, compression, shortened fields, omitted Protocol fields, or radio-specific representation. The generated serializer makes output deterministic so a repeated logical payload has stable benchmark bytes.

Future optimized encodings may shorten identifiers, use smaller field representations, or introduce purpose-built compact layouts. They remain generated adapters. A decoded optimized message must produce the same Atlas operation as the baseline and pass the same Protocol validation.

## Measured compact encoding

The codec dictionary and ordered token vocabularies are frozen in `packages/meshtastic-link/wire/codec-v1.json`, with their originating Protocol and Radio contract revisions. Contract generation follows the current Protocol schema while retaining these wire bytes. New field names and values use literal encoding until a separately versioned codec is introduced. Refreshing the Protocol must not reorder existing tokens or silently replace a pinned dictionary.

`deflate-v1` is an opt-in lossless frame encoding. It compresses the complete canonical Atlas payload together with a binary Link header using raw DEFLATE. The dictionary is generated from Protocol property names and enums, the Radio contract revision, and fixed Link envelope vocabulary. No resource fields are dropped or rounded. Reassembly produces the original canonical bytes and uses the same Protocol validation as the JSON baseline.

A frame starts with `a2` and the first eight SHA-256 bytes of its dictionary. Its compressed body contains seven unsigned base-128 integers (Link revision, message-family ASCII code, priority ASCII code, generation, sequence, chunk index, chunk count), five length-prefixed UTF-8 strings (source, destination or empty, session, operation ID, message ID), and the remaining payload chunk. The decoder bounds decompression, integers, string lengths, frame size, and aggregate reassembly. Unknown dictionaries are rejected. The dictionary identifier detects incompatible codecs; it is not authentication.

`deflate-v2` uses the same complete binary body and the same dictionary, but starts with the single-byte marker `a3` instead of the nine-byte `a2` plus dictionary digest prefix. Its pinned dictionary SHA-256 is `fde4dbf9d274d7e52e4231bd7950a6e1d28752d6bd67d89be418622a72744f3d`. The encoder and decoder reject v2 if the generated dictionary changes. A changed dictionary requires a new wire version and marker. V1 remains unchanged.

`deflate-v3` uses marker `a4` and the exact pinned v2 dictionary. It extends the binary body with one unsigned base-128 receipt flag after the five ordinary identity strings. Flag `0` carries no receipt. Flag `1` carries two additional length-prefixed UTF-8 strings containing the complete `operation_id` and `message_id` of an explicit confirmed receipt. Receipt metadata is valid only on an addressed `task_report` whose first and only chunk is being encoded. It is rejected for every other message family, for undirected reports, for fragmented reports, and when a legacy encoding is selected. The report payload remains the original canonical Atlas payload; no identifier is shortened or inferred. If the report plus receipt does not fit one frame, the encoder fails so transport can send the independent receipt and report.

`LinkTransport.frameEncoding` and `serve --frame-encoding deflate-v1|deflate-v2|deflate-v3|binary-v1|message-v1|message-v2` select transmission encoding. The v3 transport sends ordinary messages as v2 and uses v3 only for a combined receipt/report, avoiding an empty receipt field on every telemetry packet. Calling the frame codec directly with `deflate-v3` always emits the v3 representation. The default remains `canonical-json` so the measured baseline remains reproducible. Configure the same encoding on every field service; joining does not negotiate this experimental option. Diagnostic frame decoding understands every supported representation.

`binary-v1` adds marker `a5` and schema-derived indexes for property names and string values. It preserves JSON numbers and strings exactly, including unpaired UTF-16 surrogates. The complete ordered vocabulary is pinned by SHA-256 `45b9871d47b18b9ad88998c35e18ec0dbf32f9bd5bda483e52c6d54ed0fff1d7` over `JSON.stringify([FRAME_BINARY_KEYS, FRAME_BINARY_STRINGS])`; any change requires a new wire revision. The codec compresses the binary body with the pinned v2 dictionary, reconstructs canonical JSON before Protocol validation, and retains v3's explicit receipt semantics. The binary header uses the same identity fields with lossless WTF-8 strings. Receipt-flag bit zero indicates a receipt; bit one indicates an opaque payload rather than a binary JSON value. Opaque payloads and fragments can therefore retain exact bytes and header identities. For each frame it selects the smaller binary or equivalent v2 representation (v3 with a receipt), provided the legacy representation preserves every header string. A lone-surrogate header requires the binary representation even if larger. This is one transmission profile with several understood frame markers.

`message-v1` adds whole-message compression before fragmentation. It first tries the existing joint header/body binary-v1 frame. If that fits one packet, it keeps that frame without another compression pass. Otherwise it compares a whole-message encoding against binary-v1 fragmentation and selects it only when both total framed bytes decrease and fragment count does not increase. This preserves the efficient small-message path while allowing larger messages to share compression across their fragments. A message that cannot fit the old envelope may use the new one if valid.

The inner message envelope starts with `b2 01`, followed by a mode byte and raw DEFLATE using the pinned v2 dictionary. Mode `0` restores the exact original bytes; mode `1` restores the existing lossless binary-v1 JSON value to canonical JSON. The encoder compares both modes and only offers an envelope smaller than the input. Decoding rejects unknown versions/modes, trailing compressed bytes, truncation, and oversized output. Original and reconstructed messages are limited to 128 KiB. Binary token expansion has a separate bounded intermediate allocation. No field, numeric precision, unknown custom component, or string code unit is discarded.

A whole-message fragment starts with `a6`, a one-byte compressed-header length, the dictionary-compressed header, and an uncompressed slice of the already-compressed inner message. The header is the binary-v1 header with its opaque-payload flag set. Header strings remain lossless WTF-8, and each fragment retains the complete identity and chunk coordinates. The receiver concatenates payload slices, decompresses the complete message once, then applies the ordinary Protocol validation or optional state-delta reconstruction. It never decompresses an individual message slice. Header boundaries and compressed input consumption are checked exactly. Thus the body is not repeatedly compressed at the frame layer, and missing fragments use the existing repair and expiry behavior.

Compound receipts retain their addressed, single-frame Task-report restriction. When pairing, the transport unwraps an existing whole-message report before framing it with the receipt; it does not nest compression envelopes. The `message-v1` profile can emit v2, v3, binary-v1, or a6 frames. Deploy compatible Link software on every participant before selecting it; profile negotiation is not part of joining. The default remains the reproducible canonical-json baseline.

`message-v2` compares three lossless payload representations (original bytes, binary-v1 values, and compact-value-v1) with three compressors: dictionary DEFLATE level 9, Brotli quality 4, and dictionary Zstandard level 9. It chooses the smallest compressed candidate and then compares complete frames against the previous profile. It never increases fragment count or total framed bytes relative to `message-v1`. Unlike v1, this comparison also applies to single-frame messages. Encoder levels are policy; the wire mode fixes the algorithm and value representation. DEFLATE and Zstandard use the same pinned dictionary above. Zstandard compression and decoding limit the window to 1 MiB. Its decoder first checks the complete standard frame boundary, including the final block and optional checksum; Node 24 input-consumption accounting alone does not prove stream completion. This profile requires Node 24.6 or later within the supported Node 24 release line for dictionary support.

A joint single frame starts with `a7`, a mode byte, and the compressed binary-v1 header plus encoded payload. The header must set the opaque-payload flag, and its chunk coordinates must be zero of one. Modes 0–2 use DEFLATE, 3–5 Brotli, and 6–8 dictionary Zstandard; within each group the representations are original bytes, binary-v1, and compact-value-v1. For fragmented messages, the inner envelope is `b3 01`, a mode byte with the same mapping, and the compressed value. Existing `a6` frames carry slices of this envelope without recompressing the body. Decoders reject unsupported modes/versions, trailing compressed input, truncation, and output beyond the bounded intermediate and 128 KiB canonical limits.

Compact-value-v1 begins with value version `01`. It reuses the pinned binary-v1 vocabularies and lossless WTF-8 strings. Safe integers use signed-magnitude varints; an exactly representable float32 uses four bytes and every other non-integer uses float64. Canonical lowercase UUID strings pack into 16 bytes. A per-message table references up to 32 previously encountered strings across keys and values. The table never depends on another message. Canonical expansion is charged against the 128 KiB budget while decoding, including repeated references, before final serialization. All Protocol fields, custom components, numeric precision, and string code units survive unchanged. The encoder uses this representation only for exact canonical JSON inputs.

The `message-v2` profile can also emit every fallback representation understood by `message-v1`. Receipts retain the same addressed, single-frame Task-report restriction. Deploy compatible software across the fleet before enabling it; joining does not negotiate this profile.

Normal Link traffic uses Meshtastic broadcast on the private channel, including addressed commands and reports. Atlas frame destinations determine which application may act and confirm. Firmware 2.7.26 automatically converts native directed `PRIVATE_APP` traffic to public-key encryption on channel 0, bypassing private-channel membership; its native simulator skips that conversion. Native unicast is therefore unsuitable for normal private-channel traffic. Joining retains its separate public-key exchange.

Atlas also preserves scheduling priority in the attached radio's transmit queue: safety and confirmations use `ACK`, tasks use `HIGH`, requests use `RELIABLE`, live state uses `DEFAULT`, and resource/object traffic uses `BACKGROUND`. Meshtastic's RF header does not carry this local queue priority. Causal Atlas receipts and missing-fragment requests additionally carry the last available native packet ID in `Data.request_id`, allowing relays to derive native `RESPONSE` priority. This costs five native protobuf bytes; the adapter reserves that space before fragmentation. It neither requests a native ACK nor replaces Atlas application acceptance.

`retryJitterMs` advances each retry by a bounded, source/operation/attempt-specific amount. `serve` and the generated fleet use a 1,000 ms bound: the ordinary five-second Task retry waits between four and five seconds, so it does not repeatedly coincide with five-second telemetry. Deadlines are unchanged. Direct transport callers and historical baselines default to zero jitter. Experiment configs record `retry_jitter_ms` explicitly.

## Optional retry timing and compact state updates

`adaptiveRetries: true` (CLI `--adaptive-retries`) learns confirmation timing separately for each destination, source generation/session, and priority. Only a single-frame operation confirmed without retransmission contributes an RTT sample. The estimator uses smoothed RTT plus four times its variation, a two-second lower bound, and an upper bound of 1.5 times the existing fixed interval. Existing jitter applies afterward. Per-priority state is bounded to 64 destinations and expires after ten minutes. Explicit `retryIntervalMs` bypasses learning. Application deadlines are unchanged. The mode is optional: low-load latency gains do not establish a benefit under heavy contention.

`stateDeltas: true` (CLI `--state-deltas`) offers lossless updates against a full state snapshot. Full snapshots retain the ordinary canonical Protocol payload. An inner payload beginning `b1 01 01` contains a resource-type byte, length-prefixed UTF-8 resource ID, base source sequence as an unsigned base-128 integer, and canonical JSON patch operations. Each operation carries `op` (`add`, `remove`, or `replace`), a path array, and a value when applicable. Arrays are replaced as values. Reconstruction must yield the complete valid original state, including removals and metadata.

A delta references one full snapshot by source, generation, service session, resource identity, and source sequence. Deltas never depend on other deltas. The sender retains one baseline per resource scope, up to 64 scopes. The receiver retains the newest two full snapshots per scope, up to 64 scopes, so a late old full snapshot cannot displace the current baseline and repeated full snapshots for one resource cannot consume the whole cache. Both enforce the 128 KiB message limit. Cache eviction is handled as a missing baseline. The sender commits a baseline only after all full-snapshot chunks are admitted to the radio; an unsent coalesced snapshot cannot become a dependency. Radio admission still does not prove receiver acceptance. Missing baselines fail closed and count as invalid complete messages; periodic full snapshots restore decoding. The first publication prepared when its baseline is at least fifteen seconds old becomes a new full snapshot. It transmits a delta only when the actual framed byte count is smaller and fragment count does not increase. A full fallback remains valid if no savings are available.

Compact updates are optional because losing a baseline can also lose its dependent updates until the next full snapshot arrives. For the lowest latency and freshest telemetry, use `message-v1` and ordinary full publications; small messages retain binary-v1 framing. Application cadence remains the application's choice; the `TelemetryPublisher` helper provides stable per-node phase staggering without delaying commands.

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

The Gateway assigns increasing source generations when an Asset joins and increments its own durable generation when the Gateway service starts. Once a receiver accepts a generation for one source Link node, it rejects every lower generation. Source sequence orders updates to the same record within the accepted generation and service session; unrelated records may still arrive out of order over the radio.

## Fragmentation and reassembly

Every supported message may be fragmented. Common messages should eventually fit in one packet, but packet count does not determine whether an Atlas operation is valid.

The sender serializes once, assigns one logical message identity, and divides the bytes into bounded chunks. One encoded Link message is limited to 128 KiB. The receiver enforces both the 233-byte Meshtastic application-frame limit and the aggregate message limit while reassembling, then validates the complete payload before exposing it to the application or Shared Picture. Partial messages expire from bounded transport state and remain visible only in diagnostics.

Confirmed messages can repair missing chunks without retransmitting a completed prefix. Confirmation, rejection, and repair controls require both the operation ID and message ID. Repair indexes are unique and lie within the 4,096-fragment wire limit. A best-effort fragmented publication that remains incomplete at its reassembly timeout is discarded without a missing-chunk request. It is recovered by a later current-state publication or focused request. The exact repair exchange, chunk size, reassembly timeout, and non-Object concurrency bound remain implementation choices for simulation and hardware measurement.

For addressed confirmed Task and safety traffic, receiving the final chunk with earlier chunks missing starts an idle repair wait of at most one second. This leaves time for the repair request, missing chunks, and confirmation within the existing fifteen-second deadline. Before the final chunk arrives, the normal reassembly timeout applies so repair does not interrupt a slow initial transmission. After requesting repair, the receiver waits the normal reassembly timeout before repeating the request unless new chunks arrive.

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

An operational mesh uses one selected transmission profile and compatible Link software. The simulator may compare profiles; `binary-v1` selects its smaller supported representation per frame, and `message-v1` additionally compares compression before fragmentation. `message-v2` compares additional value encodings and compression algorithms, including single-frame messages. Joining does not negotiate the optional compact-state mode, so deploy matching Link software across the fleet before enabling it.

## Object content

Object metadata may be ordinary shared state. Object content is transferred only on request, addressed to that requester, sent at the lowest priority, and repaired by missing chunk. Other Link services do not assemble or retain content they did not request.

The initial maximum content transfer is 32 KiB. Larger Objects require another communication method.
