# Whole-message compression comparison

Historical results from the pre-rebase Radio contract. See [validation after rebasing onto main](MAIN-REBASE-VALIDATION.md) for the current contract and fresh comparison.

Measured on 2026-09-06. `message-v1` reduces the cost of fragmented Atlas messages while retaining the existing one-packet path. This is lossless compression: decoded canonical bytes match the original, including all Protocol fields and custom components.

## What changed

The earlier encodings tried one compressed frame, then split the original serialized message and compressed each fragment independently. The new profile compresses the whole message before fragmentation when that produces fewer total wire bytes without increasing packet count. Each fragment compresses only its header; its already-compressed body slice is copied unchanged. The receiver reassembles, decompresses once, and performs ordinary Protocol validation. Receipts, deadlines, priorities, and missing-fragment repair retain their existing behavior.

Messages that already fit one binary-v1 packet return immediately, avoiding an additional compression comparison. The new profile also understands the optional state-delta envelope; deltas remain disabled in this comparison.

Select `serve --frame-encoding message-v1` on all participating services, or set `LinkTransport` option `frameEncoding: "message-v1"`. Compatible software is required throughout the fleet; joining does not negotiate the new encoding. The default remains `canonical-json` for reproducing the original baseline. See [wire protocol](../../../docs/atlas-meshtastic-link/wire-protocol.md) for the versioned envelope and bounds.

## Exact message fixtures

The same 227-byte frame cap and complete identities are used for both profiles. Bytes below are Link frames before native RF overhead or relay retransmissions. Every fixture is validated and checked for exact canonical-byte reconstruction.

| Fixture | Canonical bytes | Binary-v1 packets / bytes | Message-v1 packets / bytes | Wire bytes saved |
| --- | ---: | ---: | ---: | ---: |
| small-telemetry | 539 | 1 / 211 | 1 / 211 | 0.0% |
| small-task | 332 | 1 / 159 | 1 / 159 | 0.0% |
| small-report | 264 | 1 / 145 | 1 / 145 | 0.0% |
| large-entity | 15,414 | 21 / 4,052 | 9 / 1,876 | 53.7% |
| large-task | 3,157 | 5 / 853 | 3 / 588 | 31.1% |
| large-object-content | 8,473 | 50 / 10,655 | 5 / 1,134 | 89.4% |
| large-object-content-incompressible | 11,223 | 71 / 15,642 | 55 / 12,335 | 21.1% |

The object fixtures are explicit-transfer codec measurements, not unsolicited telemetry. The structured object is highly compressible. The pseudo-random object has 8 KiB of deterministic hash-derived content; its remaining savings include compression of its base64 representation and reduced fragment overhead.

## Gateway fleet

240 modeled runs: seeds 1–20, two encodings, SHORT_FAST and SHORT_TURBO, and three workloads. Each run uses the production transport over the same modeled medium, five minutes of traffic, and a 30-second drain. Topology is A ↔ gateway ↔ B ↔ C. Each asset publishes every five seconds with phase staggering. Normal traffic adds one round-robin command every fifteen seconds. The command-dense workload commands all three assets every fifteen seconds. Rich telemetry adds six custom sensor-reading records to each normal publication, with current observation times.

Normal and command-dense workloads produced identical per-seed outcomes, packet counts, bytes, airtime, latency, and freshness across encodings. Their messages already fit one packet. Normal runs completed 400/400 exchanges per preset and encoding; command-dense runs completed 1,198/1,200 on SHORT_FAST and 1,200/1,200 on SHORT_TURBO. This change does not raise capacity for that existing small-message workload.

For rich telemetry, each arm schedules 3,600 publications and 400 exchanges:

| Preset / encoding | Telemetry delivered | Exchanges completed | Command p50 / p95 | Mean RF transmissions per run | Mean modeled airtime per run |
| --- | ---: | ---: | ---: | ---: | ---: |
| SHORT_FAST / binary-v1 | 1,793/3,600 (49.8%) | 394/400 | 3.42 / 11.73 s | 1,167.2 | 200.4 s |
| SHORT_FAST / message-v1 | 2,336/3,600 (64.9%) | 396/400 | 2.42 / 10.82 s | 1,001.6 | 170.6 s |
| SHORT_TURBO / binary-v1 | 3,190/3,600 (88.6%) | 398/400 | 0.96 / 9.56 s | 1,303.0 | 113.0 s |
| SHORT_TURBO / message-v1 | 3,427/3,600 (95.2%) | 400/400 | 0.94 / 9.42 s | 1,096.9 | 94.2 s |

SHORT_TURBO rich telemetry uses 16.6% less modeled airtime. Delivery increases from 88.6% to 95.2%. Command median changes only from 0.96 to 0.94 seconds, and p95 remains about 9.4 seconds. The main gain here is telemetry capacity and freshness; it is not a large command-latency improvement.

For asset C, the mean of the twenty per-run time-weighted telemetry-age p95 values improves from 9.63 to 5.78 seconds on SHORT_TURBO, and from 61.46 to 35.85 seconds on SHORT_FAST. SHORT_FAST remains overloaded for this richer five-second publication rate.

Completed exchanges and confirmations remain separate: the rich SHORT_TURBO message-v1 arm completes 400/400 exchanges but records 798/800 operation confirmations. Packet losses/collisions, telemetry deliveries, and confirmations are separate fields in the artifact. The strict experiment pass criterion requires every expected message and confirmation; only 8/240 runs pass that strict criterion, all in the ordinary SHORT_TURBO workload. Successful benchmark execution does not mean every publication arrived.

## Host timing and practical limits

Framing time is recorded as the median of five samples per fixture; decode timing includes reconstruction and canonical verification. The artifact fields named `encode_cpu_ms` and `decode_verify_cpu_ms` are elapsed wall-clock measurements using `performance.now()`, not process CPU-usage counters. On this host, message-v1 measured roughly 0.1–0.5 ms for small messages and 16–88 ms for the larger fixtures. The first measurements overlapped the package checks, so timing differences between profiles are noisy and do not establish a CPU speedup. The virtual RF clock does not include host CPU time. Compression is synchronous; large submissions can briefly occupy the service event loop.

These are deterministic modeled RF results, not new native-firmware or physical-radio measurements. Sum of transmission airtime includes relay transmissions and is not channel utilization. Range, interference, firmware scheduling, and actual node hardware still require RF testing. Neither radios nor the native Lab configuration were changed in this comparison.

## Validation and reproduction

Focused tests cover whole-message round trips, unknown/custom data, surrogate strings, bounded decoding, exact frame-header boundaries, native payload caps, out-of-order reassembly, a dropped middle fragment, state deltas, and atomic receipt/report delivery. The final package check passed generation drift, formatting, lint, TypeScript, all 388 tests, and build. The first parallel check hit the existing gateway identity-capacity test’s five-second wall-clock timeout; the final check passed when run separately from the matrix.

From the repository root with Node 24:

```sh
node --import tsx packages/meshtastic-link/scripts/compare-message-compression.ts /tmp/atlas-message-compression.json 20 message-v1
npm run check --workspace @the-drunken-coder/atlas-meshtastic-link
```

The output path must be new. The explicit `message-v1` argument retains this comparison now that the script defaults to testing `message-v2`; current output uses schema version 2 and elapsed-time field names. The script records source identity, fixture payload hashes, framing CPU, per-run results, pooled exchange latency, packet metrics, and telemetry freshness.

- Checkout: `72a47ae9b8c2e5143b51ccee1f23287dc1593dfe` plus local changes.
- Source fingerprint: `eee8b4f0c6592159728c464b7b1bbc89762e6d6c04b59379dc6c23c984b23a58`.
- Node: `v24.19.0`.
- Benchmark script SHA-256: `6576793e967022ca3b609e262d378376cf3c468e2c2955c5b3bf2e16dbbb5c80`.
- Local evidence: `.benchmarks/meshtastic-message-compression/2026-09-06/comparison-20-seeds.json` and `package-check-final.log`.
