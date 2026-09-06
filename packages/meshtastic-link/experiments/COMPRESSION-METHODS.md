# Compression method comparison

Measured on 2026-09-06. The opt-in `message-v2` profile compares additional lossless value encodings and compressors against `message-v1`. Selection uses complete framed bytes and packet count. Every fixture reconstructs the exact original canonical Atlas payload.

The strongest additional gains are in larger transfers: 17.4% fewer framed bytes for the large Entity and 20.4% for the structured Object. Routine fleet capacity barely changes. This comparison does not justify switching routine telemetry to the new profile solely for latency.

## Implementation

- Compare original bytes, the existing binary-v1 value encoding, and compact-value-v1.
- Compare dictionary DEFLATE level 9, Brotli quality 4, and dictionary Zstandard level 9 for each eligible representation.
- Compact values pack safe integers, exactly representable float32 values, lowercase UUIDs, and up to 32 per-message string references. Other numbers retain float64 precision; all fields and string code units survive.
- Compare joint header/body compression for single packets and whole-message compression before fragmentation for larger payloads. Retain the previous encoding whenever it is smaller or avoids additional packets.
- Decode only the selected method. Fragmented bodies are reassembled before decompression. References do not depend on other messages.

Enable with `serve --frame-encoding message-v2`, or `frameEncoding: "message-v2"` in `LinkTransport`. The default remains `canonical-json`. Compatible Link software is required on every participant; joining does not negotiate this option. See the [wire protocol](../../../docs/atlas-meshtastic-link/wire-protocol.md) for markers, mode assignments, and bounds.

The implementation uses Node built-ins, with no new dependency. The package now requires Node 24.6 or newer within Node 24 for Zstandard dictionary support; validation used v24.19.0. Node labels its Zstandard API experimental ([Node 24 documentation](https://nodejs.org/download/release/v24.16.0/docs/api/zlib.html)). Decoding verifies a complete standard Zstandard frame before calling Node, since input consumption alone did not reliably detect truncation. The ordinary decompression, dictionary, window, and restored-size checks still apply.

## Complete message fixtures

Both profiles use the same 227-byte Link frame cap and full identities. Bytes exclude native RF overhead and relay retransmissions. The structured Object is compressible; the pseudo-random Object contains 8 KiB of deterministic hash-derived data. These Object fixtures measure explicit transfers, not periodic telemetry.

| Fixture | Canonical bytes | Message-v1 packets / bytes | Message-v2 packets / bytes | Bytes saved | Selected method / representation |
| --- | ---: | ---: | ---: | ---: | --- |
| small-telemetry | 539 | 1 / 211 | 1 / 207 | 1.9% | deflate-9 / compact-v1 |
| small-task | 332 | 1 / 159 | 1 / 159 | 0.0% | previous / previous |
| small-report | 264 | 1 / 145 | 1 / 145 | 0.0% | previous / previous |
| large-entity | 15,414 | 9 / 1,876 | 7 / 1,549 | 17.4% | zstd-9 / compact-v1 |
| large-task | 3,157 | 3 / 588 | 3 / 561 | 4.6% | zstd-9 / original |
| large-object-content | 8,473 | 5 / 1,134 | 4 / 903 | 20.4% | zstd-9 / original |
| large-object-content-incompressible | 11,223 | 55 / 12,335 | 54 / 12,236 | 0.8% | zstd-9 / original |

## Gateway fleet

240 deterministic modeled runs: seeds 1–20, two profiles, two presets, and three workloads. Each run has five minutes of traffic and a 30-second drain, using production Atlas transport on a modeled radio medium. Links are gateway ↔ A, gateway ↔ B, and B ↔ C. Every asset publishes every five seconds with phase staggering.

- Normal: one round-robin command exchange every fifteen seconds.
- Commands per asset: a command exchange with each of the three assets every fifteen seconds.
- Rich telemetry: normal command cadence plus six custom sensor-reading records in every state publication.

State deltas and adaptive retry timing remain disabled. Packet failures, final message delivery, completed exchanges, and operation confirmations remain separate measurements.

| Workload / preset | Profile | Telemetry delivered | Exchanges completed | Command p50 / p95 | Mean modeled airtime per run |
| --- | --- | ---: | ---: | ---: | ---: |
| normal / SHORT_FAST | message-v1 | 3,456/3,600 (96.0%) | 400/400 | 1.77 / 6.58 s | 103.5 s |
| normal / SHORT_FAST | message-v2 | 3,464/3,600 (96.2%) | 400/400 | 1.79 / 6.65 s | 104.0 s |
| normal / SHORT_TURBO | message-v1 | 3,560/3,600 (98.9%) | 400/400 | 0.84 / 5.69 s | 52.5 s |
| normal / SHORT_TURBO | message-v2 | 3,561/3,600 (98.9%) | 400/400 | 0.85 / 5.60 s | 52.3 s |
| commands-per-asset / SHORT_FAST | message-v1 | 3,035/3,600 (84.3%) | 1,198/1,200 | 4.47 / 11.87 s | 157.4 s |
| commands-per-asset / SHORT_FAST | message-v2 | 3,009/3,600 (83.6%) | 1,196/1,200 | 4.46 / 11.83 s | 157.5 s |
| commands-per-asset / SHORT_TURBO | message-v1 | 3,490/3,600 (96.9%) | 1,200/1,200 | 1.74 / 7.36 s | 76.2 s |
| commands-per-asset / SHORT_TURBO | message-v2 | 3,482/3,600 (96.7%) | 1,200/1,200 | 1.77 / 7.20 s | 76.0 s |
| rich-telemetry / SHORT_FAST | message-v1 | 2,336/3,600 (64.9%) | 396/400 | 2.42 / 10.82 s | 170.6 s |
| rich-telemetry / SHORT_FAST | message-v2 | 2,369/3,600 (65.8%) | 395/400 | 2.46 / 9.70 s | 171.1 s |
| rich-telemetry / SHORT_TURBO | message-v1 | 3,427/3,600 (95.2%) | 400/400 | 0.94 / 9.42 s | 94.2 s |
| rich-telemetry / SHORT_TURBO | message-v2 | 3,427/3,600 (95.2%) | 399/400 | 0.96 / 9.24 s | 94.0 s |

Small reductions in packet length change modeled scheduling and collisions, so fewer bytes per message do not guarantee better aggregate delivery. The command-heavy SHORT_FAST arm falls from 1,198 to 1,196 completed exchanges; rich SHORT_TURBO falls from 400 to 399 while telemetry delivery remains unchanged. Host encoding also costs more. Keep this profile opt-in, especially when routine command latency is the priority.

The following table retains transmission and confirmation counts so an arrived command/report exchange is not conflated with all confirmations arriving:

| Workload / preset | Profile | Mean RF transmissions | Confirmed operations | Mean host bytes | Mean asset-C time-weighted telemetry age p95 |
| --- | --- | ---: | ---: | ---: | ---: |
| normal / SHORT_FAST | message-v1 | 612.4 | 799/800 | 41,654.9 | 8.14 s |
| normal / SHORT_FAST | message-v2 | 617.2 | 796/800 | 41,737.0 | 7.72 s |
| normal / SHORT_TURBO | message-v1 | 620.2 | 800/800 | 41,572.1 | 5.31 s |
| normal / SHORT_TURBO | message-v2 | 619.3 | 800/800 | 41,384.0 | 5.31 s |
| commands-per-asset / SHORT_FAST | message-v1 | 993.0 | 2,377/2,400 | 62,095.4 | 13.98 s |
| commands-per-asset / SHORT_FAST | message-v2 | 995.6 | 2,373/2,400 | 62,376.3 | 13.36 s |
| commands-per-asset / SHORT_TURBO | message-v1 | 947.2 | 2,399/2,400 | 57,981.0 | 5.98 s |
| commands-per-asset / SHORT_TURBO | message-v2 | 946.4 | 2,400/2,400 | 57,868.7 | 6.13 s |
| rich-telemetry / SHORT_FAST | message-v1 | 1,001.6 | 780/800 | 77,652.4 | 35.85 s |
| rich-telemetry / SHORT_FAST | message-v2 | 1,006.4 | 787/800 | 77,630.8 | 32.17 s |
| rich-telemetry / SHORT_TURBO | message-v1 | 1,096.9 | 798/800 | 76,575.5 | 5.78 s |
| rich-telemetry / SHORT_TURBO | message-v2 | 1,096.5 | 797/800 | 76,428.0 | 5.80 s |

The strict experiment criterion requires every expected delivery and confirmation: 8/240 runs meet it. Completing the benchmark and passing software tests does not imply that every scheduled telemetry publication arrived.

These are modeled results, not new native-firmware or physical-radio measurements. The virtual RF clock excludes host compression time. Summed transmission airtime includes relays and is not a direct channel-utilization measurement. Results do not establish maximum fleet capacity or physical range.

## Host processing cost and alternatives

Framing timings below are medians of five elapsed-time samples per fixture. Decode/verification is one sample including reconstruction and Protocol validation, so it is especially noisy. These are wall-clock measurements, not process CPU counters. Package tests were completed before this matrix. Compression is synchronous, so the largest messages can briefly occupy the service event loop.

| Fixture | Message-v1 encode | Message-v2 encode | Message-v1 decode + verify | Message-v2 decode + verify |
| --- | ---: | ---: | ---: | ---: |
| small-telemetry | 0.26 ms | 0.87 ms | 0.97 ms | 0.84 ms |
| small-task | 0.11 ms | 0.62 ms | 0.22 ms | 0.16 ms |
| small-report | 0.10 ms | 0.55 ms | 0.11 ms | 0.15 ms |
| large-entity | 47.68 ms | 53.06 ms | 2.63 ms | 2.81 ms |
| large-task | 14.78 ms | 17.96 ms | 0.87 ms | 0.73 ms |
| large-object-content | 72.84 ms | 75.92 ms | 0.54 ms | 0.42 ms |
| large-object-content-incompressible | 80.37 ms | 91.33 ms | 1.60 ms | 1.70 ms |

The research compared DEFLATE levels/strategies, Brotli qualities 1/4/6/9/11, and dictionary Zstandard levels 1/3/9 on canonical, binary, and joint header/body inputs. Brotli quality 11 was excluded because its encode time was substantially higher for limited extra savings. Quality 4 remains a candidate even when another method wins these final fixtures, because payload shape changes the winner.

Packing frame identifiers was also measured separately. It saved only 254 bytes across 220 complete representative fleet frames (0.56%), without eliminating a packet, so that additional wire format was not added. Cross-message compression dictionaries were not introduced; packet loss cannot invalidate a later message through compression context.

## Validation and reproduction

All 120 message-v1 baseline runs exactly reproduce the previous comparison, and the final source fingerprint matches the matrix. The full package check passed generation drift, formatting, lint, TypeScript, all 411 tests, and build. Focused coverage includes all nine modes, exact value reconstruction and numeric precision, Unicode/surrogates, bounded aggregate string expansion, malformed/truncated/trailing input for all compressors, complete-frame size comparisons, out-of-order assembly, dropped-fragment repair, state deltas, and compound receipts.

With Node 24.6 or newer in the supported Node 24 line, from the repository root:

```sh
node --import tsx packages/meshtastic-link/scripts/compare-message-compression.ts /tmp/atlas-compression-methods.json 20 message-v2
npm run check --workspace @the-drunken-coder/atlas-meshtastic-link
```

Use a new output path. The JSON contains per-run results, packet failures, freshness, payload hashes, selected compression methods, and source identity. The earlier [whole-message comparison](MESSAGE-COMPRESSION.md) remains the binary-v1 versus message-v1 measurement.

- Checkout: `72a47ae9b8c2e5143b51ccee1f23287dc1593dfe` plus local changes.
- Source fingerprint: `20de45ad77debabf9f76c5fbb595f63482e56afda1aed0e2a23c8f43aa88dbb5`.
- Node: `v24.19.0`.
- Benchmark script SHA-256: `b51e3ebbe5f40fab68d23837465a64e5d431e53780dd35ff71dde39cd3661ae5`.
- Local evidence: `.benchmarks/meshtastic-compression-methods/2026-09-06/comparison-20-seeds.json`, `package-check-verified.log`, `final-source.json`, and `research/`.
