# Meshtastic bandwidth audit, 2026-09-06

Atlas has measurable room to improve. The largest recorded costs are repeated broadcasts, fragmented state, and separate confirmation packets. Atlas and Meshtastic are not currently running two reliability loops for normal field traffic. The audit also found a physical payload-size defect that the existing 227-byte experiments do not exercise.

This records the audit and optimization proposal before implementation. The subsequent [implementation and comparison](BANDWIDTH-OPTIMIZATION.md) addresses payload budgets, causal native responses, compact framing, and the discovered Lab priority-fidelity defect. The findings and measurements below remain the historical audit evidence.

## Checkout and evidence

- Branch `codex/meshtastic-lab-experiments`, HEAD `72a47ae9b8c2e5143b51ccee1f23287dc1593dfe`, including the existing uncommitted radio fixes and compact codec.
- Audited source fingerprint `8755f75193582f3260cea70774294046d3572e88a7ac707fa70063168ad28016`. The recorded `fleet-native-priority.json` differs only in `radio.test.ts`; executable source matches. The physical priority and SHORT_TURBO workload artifacts match the audited source completely.
- Firmware `2.7.26.54e0d8d`, commit `54e0d8d0ab2ff56b3a9ce967e53f79e49af560fb`.
- Fresh package test run: 243 tests in 22 files passed. The payload boundary was absent from those tests.
- Audit scripts, source hashes, byte measurements, and the physical probe are in the ignored `.benchmarks/meshtastic-audit/2026-09-05/` directory. Earlier fleet recordings remain in `.benchmarks/meshtastic-hardware/2026-09-05/`.

Three independent reviewers covered delivery/radio queues, wire encoding, and native routing/profile/joining. Candidates were challenged by another reviewer and checked by the coordinator. The coordinator additionally inspected application acceptance, subscriptions, Core bridging, and recorded packet evidence.

## Confirmed defect: advertised payload exceeds the firmware budget

Severity: medium, P2. Verified independently by the native and wire reviewers, then reproduced by the coordinator on the connected Heltec V3.

[`frame.ts:8`](../src/frame.ts#L8) and [`radio.ts:149,284`](../src/radio.ts#L149) advertise and accept 233 application bytes. The pinned firmware adds a present `Data.bitfield` before protobuf encoding, then requires encoded Data plus the 16-byte radio header to fit 255 bytes. With `PRIVATE_APP`, the actual plain-channel application ceiling is 231 bytes.

| Physical probe on SHORT_TURBO | Result |
| --- | --- |
| 230 application bytes | Queue accepted |
| 231 application bytes | Queue accepted |
| 232 application bytes | Rejected, `TOO_LARGE`, error 7 |
| 233 application bytes | Rejected, `TOO_LARGE`, error 7 |

The probe used the production radio adapter and the verified Gateway radio, node 2661364956. It sent four raw diagnostic payloads, checked local admission, and closed USB. It did not test application delivery or change the radio profile. Evidence: `hardware-payload-boundary.mts` and `hardware-payload-boundary.json`.

A valid Atlas message that fragments into a 232- or 233-byte frame can therefore fail before RF transmission. Retrying the same oversized frame cannot repair it. The prior fleet and physical comparison used a 227-byte experiment cap, which hides this edge and means this defect does not explain their remaining losses.

The smallest correction is to calculate and enforce the native payload budget at the radio boundary, then use it for fragmentation and joining. The calculation must include optional native fields and PKI overhead, rather than assuming one ceiling for every send.

| Pinned firmware encoding | Maximum application bytes |
| --- | ---: |
| Plain private-channel broadcast | 231 |
| Plain broadcast with native `request_id` | 226 |
| Directed PKI | 219 |
| Directed PKI with native `request_id` | 214 |

The PKI and request-ID limits are protobuf/source proofs, not additional hardware measurements. Lab's 227-byte simulator-wrapper ceiling is a separate bound. Adding a native field requires checking both constraints.

Focused fix validation should check exact encoded sizes at both sides of each boundary, verify the production fragmenter respects the selected send budget, and exercise PKI joining sizes. Existing experiment fixtures that use 227 bytes can remain comparable.

Primary source: firmware [`Router.cpp`](https://github.com/meshtastic/firmware/blob/54e0d8d0ab2ff56b3a9ce967e53f79e49af560fb/src/mesh/Router.cpp#L585), including the size check at line 630 and PKI check at line 658; [`RadioInterface.h`](https://github.com/meshtastic/firmware/blob/54e0d8d0ab2ff56b3a9ce967e53f79e49af560fb/src/mesh/RadioInterface.h#L18). Reproductions: `payload-boundary.mts` and `native-budget-check.mts`.

## What owns delivery today

| Behavior | Owner | Audit conclusion |
| --- | --- | --- |
| Channel access, forwarding, hop count, same-packet duplicate suppression | Meshtastic | Already delegated to firmware. Atlas does not forward overheard packets itself. |
| Native packet retransmission and module response requests | Meshtastic, disabled for normal Atlas sends | Atlas sends `wantAck:false` and `wantResponse:false`. There is no second native reliability loop for these broadcasts. |
| Logical message identity, fragmentation, missing-chunk repair, bounded retries | Atlas Link | Firmware cannot reconstruct or settle the complete Atlas message. |
| Accepting a Task or report | Addressed Atlas application | A firmware ACK cannot establish that the application accepted responsibility. |
| Task execution fencing across restarts and authoritative state | Asset application and Core | Native duplicate suppression is too short-lived and identifies packets rather than Tasks. |

The production adapter creates a fresh native packet ID for each Atlas retry. This permits a retry to traverse relays that saw an earlier packet. Reusing native IDs is unsafe because both the firmware client-input path and relay duplicate cache can discard them. Atlas's stable logical identity remains necessary.

## Where the recorded traffic went

The five-minute, three-Asset priority run recorded 374 Atlas packet admissions and 959 RF transmissions. Every admitted native packet ID appeared in the RF trace. No radio transmitted the same native packet ID twice. The 585 additional transmissions were forwarding copies, giving 2.56 RF transmissions per host-admitted packet.

| Atlas message family | Admitted packets | Admitted application wire bytes |
| --- | ---: | ---: |
| State | 229 | 43,396 |
| Task delivery | 46 | 7,888 |
| Task report | 46 | 7,422 |
| Control | 53 | 6,649 |
| Total | 374 | 65,355 |

There were 322 unique Atlas fragments and 52 retransmission admissions. Of 180 scheduled state publications, 131 used one frame and 49 used two. Those extra fragments increase both airtime and the chance that a best-effort publication remains incomplete. State is about two thirds of admitted wire bytes.

The run still completed only 18/20 command exchanges and confirmed 30/40 command/report legs. These counts identify costs; they do not prove a single cause for each failure. The trace has no complete successful RF-reception denominator, so native packet-loss rate remains unknown. Aggregate airtime is not channel utilization.

### Use native response priority at relays

This is the most direct unused Meshtastic capability found in the audit. Atlas already supplies local queue priority, but that `MeshPacket.priority` field is not carried over RF. Relays usually assign our `PRIVATE_APP` traffic default priority.

Native `Data.request_id` is carried inside the encrypted payload. After a relay decrypts a shared-channel packet, `Router::send()` invokes `MeshPacketQueue::fixPriority()`. A nonzero request ID gives an otherwise unset packet native `RESPONSE` priority 80. That also works for broadcasts.

The first implementation experiment should expose the received native packet ID and attach it to an immediate Atlas confirmation for that exact received packet. Keep both native ACK and module-response requests disabled. Measure whether confirmations pass state backlog at B and complete more command exchanges. Native request-ID metadata costs five protobuf bytes, so use the corrected payload budget.

This improves relay queue ordering. It does not cancel a broadcast flood, acknowledge the Atlas operation, or justify marking unrelated state as a response. Start with one-frame immediate receipts; fragmented messages and delayed reports need explicit causal tracking.

This path was verified by the delivery reviewer, native reviewer, and coordinator. Throughput improvement remains unmeasured. See firmware [`MeshPacketQueue.cpp:41-62`](https://github.com/meshtastic/firmware/blob/54e0d8d0ab2ff56b3a9ce967e53f79e49af560fb/src/mesh/MeshPacketQueue.cpp#L41) and Atlas [`radio.ts:210-216,294-309`](../src/radio.ts#L210).

### Piggyback acceptance on an immediate report

A quiet command exchange currently requires four Atlas message transmissions before mesh forwarding: command, acceptance receipt, Task report, and report receipt. Both receipts have meaning, but the first receipt and report can share one transmission when they are ready together.

The corrected byte experiment uses the 20 fleet workload pairs, random-like deterministic IDs, and decode/reassembly equality checks. It produces:

| Encoding of the acceptance/report pair | Frames | Wire bytes |
| --- | ---: | ---: |
| Current separate messages | 40 | 5,740 |
| Compound retaining both complete outer identities | 40 | 6,551 |
| Candidate sharing report identity and omitting redundant control outer fields | 20 | 3,984 |

The reduced candidate uses one 185-200 byte frame per pair and saves 30.6% of the pair's encoded bytes. Preserving both complete envelopes is worse than sending them separately. This supersedes the preliminary measurements made with compressible fixture IDs.

The reduced form preserves the control payload's exact command operation/message reference and the report body. It omits the receipt's separate outer sequence, operation/message IDs, type, and priority. The current control handler does not use those outer identity values to match an outstanding command, but the new encoding still needs explicit ordering, diagnostics, settlement, and priority rules. A useful implementation would retain independent report delivery tracking and process the embedded receipt explicitly. A report alone must never imply Task acceptance.

This is a versioned wire proposal, not an implemented batching feature or a measured RF saving. It needs a standalone receipt when the report is delayed or the pair does not fit. The three-packet exchange target applies only to an immediate pair that fits, with no retries. Evidence: `compound-control-report-corrected.mts` and `.json`.

### Reduce fragmentation before adding more reliability traffic

`deflate-v1` repeats its nine-byte codec/dictionary prefix and the complete Link identity on every fragment. It compresses fragments independently. The most useful target is eliminating the second packet for common telemetry while preserving every Atlas field, source fence, and loss-recovery rule.

Benchmark tighter stateless header encoding first, then whole-message compression before fragmentation. A smaller continuation header is another option, but introduces missing-first-frame and out-of-order context handling. It cannot by itself make an oversized first frame fit. No proposed codec gain is counted as an achieved fleet result here.

Native radio IDs cannot replace stable Atlas identity without a new binding contract. Native position/telemetry messages are also not lossless substitutes for complete Atlas resources and provenance. Meshtastic does not automatically compress these `PRIVATE_APP` payloads for us.

### Use queue feedback before surrendering work to firmware

The adapter matches queue acceptance but ignores `QueueStatus.free`, `maxlen`, and zero-ID capacity notifications. Firmware has a 16-entry transmit queue and can evict an older lower-priority packet while successfully admitting a new one. It does not identify the evicted packet to the host.

A controlled production-transport probe held RF transmission for more than ten seconds. Atlas admitted the same command at 0, 5,000, and 10,000 ms. Local cancellation then succeeded, while all three admitted copies remained in the simulated firmware queue. This demonstrates the boundary; it does not claim that the recorded fleet had those exact queue delays.

The USB API has no packet-cancellation command. Firmware's internal cancellation function is unavailable to Atlas. Its free-space notification arrives when a previously full queue gains space, not after every packet transmission. Consequently queue feedback can support backpressure, but cannot establish one packet in flight or exact RF completion.

Keep more work in the Atlas queue when capacity is exhausted so it can still coalesce state and reconsider priority. Preserve the distinction between host admission and RF transmission in all diagnostics. The experiment harness already reports this distinction correctly. This is an optimization of a documented limitation, not a violation of the existing cancellation contract in [`delivery-and-priority.md:57`](../../../docs/atlas-meshtastic-link/delivery-and-priority.md#L57).

### Measure topology-specific forwarding changes separately

In the fixed A-Gateway-B-C graph, 257 non-origin transmissions came from degree-one leaves A and C. They account for 41,142 of 153,862 ms of aggregate radio airtime, about 26.7%. Their sole neighbor already transmitted the packet to them, so these leaf relays add no reach in this graph.

`CLIENT_MUTE` would suppress those relays while allowing each leaf to originate its own telemetry. A hop limit of two is also sufficient for this fixed three-edge diameter because forwarding decrements before transmission: A2, Gateway1, B0 reaches C. Neither change establishes a general mobile-mesh policy or guarantees the same counterfactual airtime saving.

The accepted profile specifies CLIENT on every radio and hop limit three. These are separate, reviewable topology experiments that would change that policy, not automatic optimizations for the production fleet. Native unicast is another architecture decision: directed `PRIVATE_APP` packets become PKI/channel 0 on physical firmware, changing both private-channel reception and shared-picture visibility.

## Other duplication and coverage limits

Subscription demand already combines identical selectors from multiple clients and Assets. It does not broadcast one copy per subscriber. Renewal remains a separate confirmed message every 30 seconds per distinct selector, with a 90-second lease. Batching renewals could save packets while retaining lease semantics; native NodeInfo presence cannot prove a Link client's subscription demand.

The field-to-Core-to-field echo is a documented unresolved cost in [`subscriptions.md:40-53`](../../../docs/atlas-meshtastic-link/subscriptions.md#L40). The current fleet workload does not include Core feeds or subscription renewals. It therefore cannot establish their overhead or prove that suppressing Core-confirmed state is safe. A future workload must retain the distinction between provisional field data and authoritative Core results.

Native position, telemetry, NeighborInfo, and MQTT traffic are already disabled by the chosen profile or firmware. NodeInfo supplies public keys used for joining and should not be removed as redundant Atlas discovery. Atlas's join discovery stops after joining; it is not a second steady-state heartbeat.

Completed coverage includes serialization and bounds, reassembly and repair, application settlement, duplicate and session fences, radio admission, cancellation and shutdown boundaries, native forwarding and priorities, profile/joining traffic, subscriptions/Core bridging, and experiment evidence. Physical multihop joining, relay-priority performance, mobility, range, and new codec delivery under loss were not run in this audit. Two attached radios cannot validate the requested physical relay graph.

## Recommended implementation order

1. Correct and test the native payload budget, including PKI and optional metadata.
2. Expose native packet IDs and test native response priority for immediate receipts in the existing fleet scenario.
3. Optimize telemetry framing against the same payloads and seeds, keeping complete Atlas semantics.
4. Define and test receipt piggybacking, with standalone fallback and independent report tracking.
5. Add bounded native-queue behavior to the model and use actual capacity feedback for admission.
6. Compare uniform forwarding with explicit fixed-leaf and hop-budget experiments. Treat any adoption as a change to the documented radio policy.

Each comparison should retain separate results for packet attempts/admission, RF forwarding, complete message acceptance, confirmation, deadline failure, and useful current state. Reducing packet count is valuable only if those application outcomes remain intact.
