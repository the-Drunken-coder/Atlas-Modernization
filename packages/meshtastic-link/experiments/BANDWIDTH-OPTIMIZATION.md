# Meshtastic bandwidth improvements, 2026-09-06

Implemented three changes from the [audit](BANDWIDTH-AUDIT.md): accurate native payload budgets, causal native response metadata, and a smaller lossless frame prefix. The measured wire change removes repeated codec metadata without dropping Atlas fields or relying on shared reassembly context.

## Implementation

- **Payload budgets:** the production adapter accepts 231 application bytes for ordinary `PRIVATE_APP` broadcasts and 219 for directed/PKI sends. A native request ID reduces these to 226 and 214. Transport, joining, the configuration gate, and experiment wrappers use the per-send limit. The packet model applies those limits too.
- **Native response priority:** an application receipt references the last available native packet ID from the complete received Atlas message. Fragment-repair and overload-rejection controls also reference their causal packet. This lets a real relay derive Meshtastic `RESPONSE` priority. Acceptance still requires explicit application settlement. Retries get another receipt without another application acceptance. Native `wantAck` and `wantResponse` remain false.
- **Lossless `deflate-v2`:** marker `a3` selects one exact dictionary and replaces the nine-byte v1 prefix. Both encoder and decoder reject dictionary drift. Every Link identity field and original canonical Atlas byte survives; fragmented messages remain independently decodable. JSON and `deflate-v1` remain available. Select `serve --frame-encoding deflate-v2` uniformly for an experimental fleet; JSON remains the default.

The fixed CLIENT profile, hop limit three, private shared-channel broadcasts, Atlas delivery deadlines, and application confirmations remain in use. Receipt/report piggybacking, native queue backpressure, role-specific forwarding, and native unicast were not adopted in this change.

## Correcting the comparison boundary

Lab copied `MeshPacket.priority` across its simulated RF boundary. Real Meshtastic headers do not transmit that host-local field. This gave simulated relays priority information that physical relays lack and masked the purpose of `Data.request_id`.

The generic fix is in the separate Meshtastic Lab repository, `backend/app/gateway/node_gateway.py`: clear priority when injecting a simulated received packet, while retaining the on-air request ID and existing timestamp instrumentation. A focused regression confirms the request ID and calculated airtime are unchanged. Both native comparison arms use this corrected runtime.

Lab also bypasses native PKI conversion in SimRadio. The Atlas packet model now represents directed `PRIVATE_APP` sends as PKI on channel zero, including twelve bytes of encryption overhead, and assumes the peer key is known. The fleet comparison uses broadcasts throughout, so this correction does not change its results.

## Matched workload

Four radios form A–Gateway–B–C. All three Assets publish complete telemetry every five seconds for five minutes. Every fifteen seconds the Gateway commands the next Asset; only actual Asset acceptance creates its matching report. Each run schedules 180 state publications and 20 command/report exchanges, with a 330-second observation window. Host frame cap is 227 bytes for the native simulator wrapper, bounded further to 226 for request-ID metadata. Retry jitter is 1,000 ms. The baseline uses the frozen audited implementation and `deflate-v1`; the optimized arm uses all three changes and `deflate-v2`.

The native workload is not deterministic. A fresh run on the old Lab produced 20/20 exchanges, 30/40 confirmations, and 100/180 state deliveries; it is retained as a diagnostic and excluded from the matched comparison. Older recorded results are not mixed into the corrected-Lab comparison.

## Native firmware result

The native comparison ran two repetitions of each implementation on SHORT_FAST, in baseline–optimized–optimized–baseline order. Each repetition was a fresh native simulation with the same configuration, firmware, Lab build, and workload.

| Run order | Exchanges | Confirmations | State delivered | RF transmissions | Aggregate airtime |
| --- | ---: | ---: | ---: | ---: | ---: |
| Baseline 1 | 18/20 | 30/40 | 92/180 | 947 | 153.903 s |
| Optimized 1 | 19/20 | 29/40 | 109/180 | 879 | 147.729 s |
| Optimized 2 | 19/20 | 29/40 | 111/180 | 890 | 149.648 s |
| Baseline 2 | 19/20 | 28/40 | 85/180 | 968 | 156.687 s |
| Baseline total | 37/40 | 58/80 | 177/360 | 1,915 | 310.590 s |
| Optimized total | 38/40 | 58/80 | 220/360 | 1,769 | 297.377 s |

The optimized runs delivered 43 more telemetry updates, a 24.3% relative increase (49.2% to 61.1% of scheduled updates). RF transmissions fell 7.6%, aggregate airtime fell 4.3%, host packet admissions fell from 750 to 669 (10.8%), and admitted application bytes fell from 132,134 to 122,351 (7.4%). State used 443 frames before and exactly 360 afterward: all 83 extra telemetry fragments disappeared.

Atlas retransmission admissions barely changed, 112 to 110. Returned confirmations were unchanged at 58/80. Median round-trip time among completed exchanges was 7.044 seconds before and 6.366 seconds afterward; this excludes failed exchanges and is descriptive, not a statistical latency claim. The native evidence supports a bandwidth improvement, but does not establish a confirmation-reliability benefit from response metadata.

All four observation windows and packet histories completed, with no duplicate application acceptance, local radio-send rejection, or runner error. Each run restored the saved Lab scenario. The strict all-messages experiment verdict remains **false** because some telemetry and confirmed operations missed their expectations. Neither version is a field-ready reliability result. Two repetitions per implementation establish a small observed comparison, not a statistical guarantee.

## Modeled results

Ten identical medium seeds per preset, with deterministic random-like message IDs supplied only inside the benchmark process, exercise the same production transport. There are 200 scheduled exchanges, 400 expected application confirmations, and 1,800 state updates per row. Results include deadline checks.

| Preset / implementation | Exchanges | Confirmations | State delivered | RF transmissions | Aggregate airtime |
| --- | ---: | ---: | ---: | ---: | ---: |
| SHORT_FAST / baseline | 199/200 | 397/400 | 1,580/1,800 | 7,532 | 1,266.426 s |
| SHORT_FAST / native metadata only | 199/200 | 399/400 | 1,563/1,800 | 7,572 | 1,269.132 s |
| SHORT_FAST / optimized | 200/200 | 399/400 | 1,666/1,800 | 6,605 | 1,171.871 s |
| SHORT_TURBO / baseline | 200/200 | 399/400 | 1,763/1,800 | 7,846 | 661.329 s |
| SHORT_TURBO / native metadata only | 200/200 | 399/400 | 1,765/1,800 | 7,829 | 663.019 s |
| SHORT_TURBO / optimized | 200/200 | 400/400 | 1,783/1,800 | 6,739 | 601.355 s |

Relative to the frozen baseline, the complete optimization reduces transmissions by 12.3% on SHORT_FAST and 14.1% on SHORT_TURBO, and aggregate airtime by 7.5% and 9.1%. There are no duplicate application acceptances in any modeled run.

The metadata-only arm includes corrected budgets and causal request IDs while retaining v1 framing. Its modeled airtime is slightly higher. The packet model includes the five-byte metadata cost but does not model firmware priority queues or eviction, so it cannot establish a native relay-priority benefit. Most of the demonstrated modeled gain comes from v2 framing.

A separate byte benchmark uses all 220 workload records and preserves every identity and payload byte. At the 227-byte cap, v1 uses 265 frames and 49,862 bytes; v2 uses 220 frames and 45,585 bytes. All 45 two-frame state records become one frame, saving 4,277 bytes (8.58%) before retry and forwarding effects. The exact count varies with random IDs in native runs; this is a fixed fixture measurement.

## Validation and limits

- Full package check: generated contract, formatting, lint, typecheck, **278 tests**, and build passed on Node 24.
- The six semantic scenarios run under all three encodings: quiet delivery, recoverable loss, no delivery, lost confirmation, duplicate suppression, and state fanout.
- Codec tests cover fixed dictionary identity, a golden decode fixture, complete round trips, out-of-order fragment decoding, invalid/truncated input, and decompression limits.
- Radio/transport tests cover both sides of native size boundaries, PKI joining, request-ID validation, causal fragmented receipts, missing optional packet IDs, replay without duplicate application acceptance, and dynamic budget forwarding.
- Lab: 32 focused gateway/medium/airtime tests and Ruff passed. The running image was rebuilt from a clean isolated validation checkout; the original Lab branch contains the uncommitted source fix.
- Canonical JSON baseline fixtures were intentionally refreshed for the corrected packet model; their load/deadline failures remain visible. They are separate from the frozen before/after fleet artifacts.

Review also identified an existing join-configuration limit outside the preprovisioned fleet workload: membership initialization accepts arbitrarily long Gateway IDs, while acceptance is a single unfragmented PKI packet. With a 32-character join attempt, 32-byte channel key, and one-digit generation, 29 ASCII Gateway-ID characters fit the 219-byte budget and 30 do not; escaping and larger generation values reduce that space. The new budget correctly rejects an oversized acceptance before radio submission, but `gateway-init` still needs an acceptance-size preflight. This comparison does not claim to fix that configuration gap.

These runs establish software behavior and simulator results. They do not establish physical multihop capacity, range, mobility, or a field-ready delivery guarantee. Native RF packet-loss rate remains unknown because Lab does not expose a complete successful-reception denominator. Aggregate radio airtime includes forwarding and is not channel utilization. The two physical radios were not used or reconfigured during this implementation comparison.

## Provenance and reproduction

Atlas branch `codex/meshtastic-lab-experiments`, base HEAD `72a47ae9b8c2e5143b51ccee1f23287dc1593dfe`, including uncommitted work:

- Frozen baseline source SHA-256: `8755f75193582f3260cea70774294046d3572e88a7ac707fa70063168ad28016`.
- Optimized source SHA-256: `26fced407980a620da32a060048a1191dacbfbedad5179862e801ce632927d42`.
- Native firmware: `54e0d8d0ab2ff56b3a9ce967e53f79e49af560fb`.
- Corrected Lab isolated validation commit: `6f096a5555a755afa0661d469b833686d9cddfee`, based on local Lab `c162c248789bcefa275de10ffa64e972fa5f9fb7`.
- Lab patch SHA-256: `bbbf9b827db22383557753aaa366681c3c4abbe890d8637aa55e410db10b8740`.

Ignored local artifacts live in `.benchmarks/meshtastic-optimization/2026-09-06/`: `baseline-package/`, `baseline-source.json`, `stateless-wire-benchmark.mts/json`, `modeled-comparison.json`, `fleet-baseline-corrected-1.json`, `fleet-baseline-corrected-2.json`, `fleet-optimized-corrected-1.json`, `fleet-optimized-corrected-2.json`, `native-comparison-summary.json`, `lab-source.json`, `lab-priority-fix.patch`, `lab-validation-checkout/`, and `package-check.log`. The isolated validation commit is local only; neither working branch was committed or pushed.

From the Atlas repository root, with Node 24 on PATH:

```sh
npx --no-install tsx .benchmarks/meshtastic-optimization/2026-09-06/run-native.mts baseline new-baseline-name
npx --no-install tsx .benchmarks/meshtastic-optimization/2026-09-06/run-native.mts optimized new-optimized-name
npx --no-install tsx .benchmarks/meshtastic-optimization/2026-09-06/run-modeled.mts
npm run check --workspace @the-drunken-coder/atlas-meshtastic-link
```

Native runs require stopped Lab on loopback port 8080 and restore its saved scenario afterward. Run them sequentially. The modeled script writes `modeled-comparison.json` exclusively; preserve or rename an existing result before rerunning. Each artifact includes configuration, outcome records, and source fingerprints.
