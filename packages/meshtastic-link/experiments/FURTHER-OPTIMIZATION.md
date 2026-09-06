# Further Meshtastic bandwidth improvements

Historical results from the pre-rebase Radio contract. See [validation after rebasing onto main](MAIN-REBASE-VALIDATION.md) for the current contract and fresh comparison.

This round builds on [the first optimization](BANDWIDTH-OPTIMIZATION.md). The workload stays A–Gateway–B–C: three Assets publish telemetry every five seconds, and the Gateway exchanges a command and Task report with one Asset every fifteen seconds. All radios remain CLIENT with hop limit 3. Atlas still distinguishes radio submission, application delivery, and application confirmation.

## Changes

- **Combine explicit receipts with immediate reports.** Experimental `deflate-v3` carries the complete operation and message references of a confirmation alongside an addressed, single-frame Task report. A report never implicitly acknowledges a command. Transport combines only messages already queued together and only if the combined frame fits the real per-send budget. Delayed reports retain immediate standalone receipts. Applications making separate HTTP calls may not queue both messages in time to combine them. Report rejection, retry, cancellation, and receipt settlement retain separate outcomes. Ordinary messages retain the v2 encoding; v3 is used only when receipt metadata is present, avoiding overhead on telemetry. Physical packet/byte metrics count the compound once as a Task report; the embedded receipt still gets its own logical sent result.
- **Use soft leases for renewal recovery.** A subscription renewal is best effort. Adds and explicit removes remain confirmed. Thirty-second refreshes and ninety-second expiry stay unchanged; no telemetry samples or Task transitions are removed. The Gateway retains inactive subscription transition fences instead of evicting them under pressure. At 4,096 distinct source/selector pairs it rejects new pairs while preserving updates to existing pairs.
- **Fit join acceptance and preflight before persistence.** A versioned binary acceptance preserves UTF-8 identities, safe-integer generations, the full contract digest, and the channel key. Gateway initialization and startup check a representative acceptance. Each real admission checks its exact encoded acceptance under the membership mutation lock before writing the next Asset generation. Existing JSON acceptances remain decodable.
- **Enforce the decoded payload limit.** The compressed decoder checks the 128 KiB payload limit before converting its payload for further processing. Valid boundary-sized payloads remain supported.
- **Record native queue observations.** Experiment results now include bounded queue-status counts, minimum/latest free slots, full observations, and matched local admissions/rejections. A local admission does not prove transmission or remote reception.
- **Make modeled runs repeatable.** The model supplies seed-derived per-node identities through `TransportOptions.createID`; production uses cryptographic randomness. Whole-result tests cover reproducibility. `scripts/compare-fleet.ts` compares v2/v3 using ten seeds for each modem preset.

## Research choices

| Candidate | Decision and evidence |
| --- | --- |
| Explicit receipt/report combination | Implemented. A prototype using twenty recorded pairs reduced forty frames to twenty and 5,420 bytes to 3,823 bytes. Whole-exchange and fleet results below account for the command, report receipt, retries, and unrelated traffic too. |
| Renewal acknowledgments | Removed. In a seventy-second real-Link modeled lease probe, v2 used six transmissions, 753 bytes, and 776.448 ms; best-effort renewal used four, 501 bytes, and 512.512 ms. This separate probe retains random service/message IDs; frame counts are stable but compressed byte totals can vary slightly. These are modeled totals, not measured physical airtime. |
| Compact join acceptance | Implemented. A thirty-byte ASCII Gateway ID exceeded the old JSON acceptance's 219-byte PKI limit. Binary acceptance is 140 bytes, or 147 with the largest safe generation. Oversized attempts fail without consuming persisted generations. |
| Queue-aware admission | Observe first. The pinned native queue has sixteen slots and may evict lower-priority packets. Stale capacity reports can make a naive free-slot gate wait forever; a zero failure count does not establish an empty queue. |
| More even telemetry phases | Deferred. Across twenty modeled seeds, changing 0/1600/3200 ms to 0/1667/3334 ms yielded only a small improvement. Preserve the workload for this comparison. |
| Command phase changes | Deferred. The tested phases produced no stable improvement. |
| Core echo suppression | Deferred. The documented Core/publication policy is unresolved and the current benchmark callback is not a production Core bridge. Do not change authority or deduplication semantics to optimize a synthetic callback. |
| Firmware traffic management | Not applicable to this pinned build. Do not attribute its behavior to modules found only in newer development firmware. |
| Fragmented lease renewals | Known limitation. A receiver cannot distinguish renewal from add/remove until reassembly; an incomplete multi-frame renewal may solicit a repair the best-effort sender no longer retains. Ordinary compressed selectors fit one frame. Changing every subscription's repair policy would also affect confirmed add/remove, so this remains documented. |
| Native timing model | Follow-up. Modeled relay/backoff timing differs from the pinned firmware's contention and processing delays. Native comparisons remain necessary. |

Combining an immediate receipt and response follows the same general transport pattern described in [RFC 7252, section 5.2](https://www.rfc-editor.org/rfc/rfc7252#section-5.2); Atlas keeps its own explicit application identities and deadlines. Native queue and timing research used firmware commit [`54e0d8d`](https://github.com/meshtastic/firmware/tree/54e0d8d0ab2ff56b3a9ce967e53f79e49af560fb), especially `MeshPacketQueue`, `RadioLibInterface`, `MeshService`, and `Router`. Current native Lab provenance remains the same as the first optimization's corrected priority run.

## Native firmware comparison

Two before and two after runs used SHORT_FAST, the same 330-second configuration, the same corrected Lab image, and the same pinned firmware. All four observation windows completed, captured complete Lab evidence, reported no harness errors, and restored the previous Lab scenario.

| Total across two runs | Before: v2 | After: selective v3 |
| --- | ---: | ---: |
| Command exchanges delivered within deadline | 35 / 40 | 40 / 40 |
| Commands and reports confirmed within deadline | 60 / 80 | 67 / 80 |
| Telemetry samples delivered within deadline | 219 / 360 | 224 / 360 |
| RF transmissions, including relays | 1,756 | 1,624 |
| Summed RF airtime | 296.265 s | 283.088 s |
| Atlas packet admissions | 662 | 577 |
| Atlas admitted bytes | 121,581 | 111,274 |
| Atlas retransmission admissions | 113 | 72 |
| Local radio send failures | 0 | 0 |
| Duplicate application acceptances | 0 | 0 |
| Median successful command round trip | 7.078 s | 5.303 s |

RF transmissions fell 7.52%, summed airtime 4.45%, admitted bytes 8.48%, and Atlas retransmissions 36.28%. The median uses successful exchanges; the sets differ, so it is descriptive rather than a paired latency estimate. Native runs are not deterministic and two trials per side are a small sample.

Per-run exchange/confirmation/telemetry results were 17/29/113 and 18/31/106 before, then 20/32/116 and 20/35/108 after. The fleet stress scenario still reports `passed: false`: it expects every telemetry sample and confirmed operation to succeed. These results do not establish that expectation.

Both optimized runs observed at least twelve free native queue slots out of sixteen, zero full-queue observations, and zero matched local rejections. Status snapshots cover connection setup as well as the workload; they cannot rule out unobserved transient pressure. The measurements do not support adding a queue throttle as the next optimization.

Freshness is not uniformly better. The first optimized run held all three final scheduled telemetry samples. The second ended with Asset C's latest sample thirty seconds behind its final scheduled sample; the second baseline run was twenty seconds behind. The other Assets' final samples arrived in every run. Optimizing packet count alone does not solve this remaining telemetry gap.

## Modeled comparison

The final matrix contains 200 runs: fifty seeds, two modem presets, and two encoding profiles. It uses the current production implementation on both sides and changes only the encoding profile. Each group schedules 1,000 exchanges, 2,000 confirmed messages, and 9,000 telemetry samples.

| Preset and encoding | Exchanges delivered | Messages confirmed | Telemetry delivered | RF transmissions | Summed modeled airtime |
| --- | ---: | ---: | ---: | ---: | ---: |
| SHORT_FAST v2 | 1,000 | 1,992 | 8,311 | 32,910 | 5,840.247 s |
| SHORT_FAST selective v3 | 999 | 1,992 | 8,397 | 30,565 | 5,602.561 s |
| SHORT_TURBO v2 | 999 | 1,997 | 8,898 | 33,650 | 3,002.835 s |
| SHORT_TURBO selective v3 | 1,000 | 2,000 | 8,882 | 31,088 | 2,862.770 s |

Selective v3 reduces transmissions by 7.1% on SHORT_FAST and 7.6% on SHORT_TURBO, and modeled airtime by 4.1% and 4.7%. Both profiles deliver 1,999 of 2,000 total exchanges across presets. No duplicate application acceptances occur. SHORT_FAST gains 86 telemetry deliveries; SHORT_TURBO loses 16. These results support a bandwidth reduction, not a universal per-message reliability improvement.

The packet model does not implement native priority queues, eviction, or the firmware's exact backoff timing. Its by-priority counters classify the Atlas frame's logical priority; a compound report remains Task traffic there even though the local native adapter sends it at ACK priority and relays can infer RESPONSE priority from its request reference. Do not interpret those counters as a native queue simulation.

## Reproduction and scope

From the package directory, with Node 24:

```sh
npx tsx scripts/compare-fleet.ts new-comparison.json 50
npm run check
```

The modeled comparison changes only the encoding on the current implementation. It does not pretend that the older production code already had deterministic IDs. Native before runs use a frozen copy of the earlier implementation and v2; after runs use the new implementation and v3. Artifacts live under `.benchmarks/meshtastic-next/2026-09-06/`, including the baseline source fingerprint, frozen package, matched fleet configuration, raw outcomes, and native runner.

These are simulations. Native RF receive success is not directly observable at the injection boundary, so real packet-drop rate remains unknown. Summed RF airtime includes separate radios and is not channel utilization. Two physical radios cannot validate the four-node topology; this round does not reconfigure them. Joining and subscriptions have separate focused tests and are absent from the fleet workload.

## Provenance and review

- Final validated Link/SDK and fifty-seed model fingerprint: `092d8b593ade5522dcee1df9ce3ad8fa69ebf78d3e35da26afa914ae5ae7847d`.
- Baseline Link/SDK content fingerprint: `26fced407980a620da32a060048a1191dacbfbedad5179862e801ce632927d42`.
- Native after run 1 fingerprint: `5a49ca36db89451cd4a5476b8692d08a44005c9e8f2e5084f451eb79f886d976`.
- Native after run 2 fingerprint: `030c7991d246951dbdea3c1a92bea669cad03776b5d2aff3a37da0441aa2233b`.
- Source fingerprints include tests. Between after-run snapshots, tests, the decoded-size guard, and subscription fence retention changed; the fleet's send and receive behavior for valid messages did not. Later callback-stop/cancellation guards and the subscription retention changes are covered by focused tests and the final modeled run; the native fixture never calls those callbacks or uses subscriptions.
- Independent review covered the frame codec, join preflight, queue metrics, receipt lifecycle, and subscription semantics. It found the decoded-size check, callback lifecycle guards, and inactive subscription fence retention issues, which were repaired.
- Native `request_id` is retained for relay response priority. Broadcast replies do not activate directed-message relay cancellation. Explicit sender priority is local metadata and does not replace the on-air request reference at other radios.

Validation: all 316 package tests pass, including codec, join persistence, subscription loss/expiry and capacity, compound receipts, callback cancellation/shutdown, and repeatable modeled results. The package check also verifies generation, formatting, lint, TypeScript, and build.
