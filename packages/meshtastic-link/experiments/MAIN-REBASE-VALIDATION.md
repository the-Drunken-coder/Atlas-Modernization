# Validation after rebasing onto main

Measured on 2026-09-06 after rebasing the full implementation onto main commit `503754eb`. These results supersede earlier reports for the current Radio contract. Earlier reports retain their original source fingerprints and remain useful historical comparisons.

Main advances the Atlas Protocol revision. The generated Radio contract now follows that revision, while `wire/codec-v1.json` freezes the existing compression dictionary and token indexes. This preserves the meaning of existing frame markers. New Protocol words use literal encoding. The current contract revision string is no longer the string embedded in the dictionary, which increases encoded message size and can add packets. The earlier capacity estimates must not be applied to this contract unchanged.

## Validation

- Clean workspace dependency installation and SDK build passed on Node 24.19.0.
- The Link package passed generation checks, formatting, lint, TypeScript, all 411 tests, and build.
- SDK checks passed lint, formatting, type contracts, 471 Node tests with coverage, 471 browser tests, and packed-consumer validation.
- The fixed compression golden vector retains its original payload revision. Behavioral tests check messages across fragmentation and allow the documented adaptive frame choices.

## Compression fixtures

Complete Link frames at the same 227-byte cap. Every result reconstructs the exact canonical message. Bytes exclude native packet headers and relay transmissions.

| Fixture | Message-v1 packets / bytes | Message-v2 packets / bytes | Additional bytes saved |
| --- | ---: | ---: | ---: |
| small-telemetry | 2 / 332 | 2 / 327 | 1.5% |
| small-task | 1 / 217 | 1 / 217 | 0.0% |
| small-report | 1 / 198 | 1 / 198 | 0.0% |
| large-entity | 9 / 1,932 | 8 / 1,646 | 14.8% |
| large-task | 3 / 631 | 3 / 610 | 3.3% |
| large-object-content | 6 / 1,241 | 5 / 1,009 | 18.7% |
| large-object-content-incompressible | 55 / 12,377 | 55 / 12,351 | 0.2% |

Fixture encoding time is recorded as a median of five elapsed-time samples; decode and Protocol verification are a single sample. The detailed timings remain in the JSON artifact. Compression is synchronous, and the RF model does not include this host processing time.

## Modeled fleet

240 runs cover seeds 1–20, two encodings, SHORT_FAST and SHORT_TURBO, and three workloads. The topology is gateway ↔ A, gateway ↔ B, and B ↔ C. Every asset publishes every five seconds. Normal and rich telemetry use one round-robin command every fifteen seconds; the command-heavy case commands every asset every fifteen seconds. Rich telemetry adds six custom sensor records. Each run has five minutes of traffic and a thirty-second drain. State deltas and adaptive retry timing are disabled.

| Workload / preset | Encoding | Delivered telemetry | Completed exchanges | Confirmed operations | Command p50 / p95 | Mean modeled airtime |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| normal / SHORT_FAST | message-v1 | 2,473/3,600 | 397/400 | 788/800 | 3.03 / 9.69 s | 160.5 s |
| normal / SHORT_FAST | message-v2 | 2,516/3,600 | 398/400 | 790/800 | 2.81 / 10.78 s | 159.7 s |
| normal / SHORT_TURBO | message-v1 | 3,484/3,600 | 400/400 | 800/800 | 1.14 / 6.21 s | 85.5 s |
| normal / SHORT_TURBO | message-v2 | 3,494/3,600 | 400/400 | 799/800 | 1.14 / 6.13 s | 85.3 s |
| commands-per-asset / SHORT_FAST | message-v1 | 1,725/3,600 | 933/1,200 | 1,434/2,400 | 10.62 / 24.51 s | 211.7 s |
| commands-per-asset / SHORT_FAST | message-v2 | 1,689/3,600 | 923/1,200 | 1,452/2,400 | 10.20 / 23.89 s | 211.8 s |
| commands-per-asset / SHORT_TURBO | message-v1 | 3,162/3,600 | 1,200/1,200 | 2,393/2,400 | 2.40 / 8.98 s | 114.9 s |
| commands-per-asset / SHORT_TURBO | message-v2 | 3,193/3,600 | 1,199/1,200 | 2,394/2,400 | 2.38 / 9.08 s | 114.9 s |
| rich-telemetry / SHORT_FAST | message-v1 | 2,108/3,600 | 395/400 | 771/800 | 3.65 / 12.31 s | 191.6 s |
| rich-telemetry / SHORT_FAST | message-v2 | 2,127/3,600 | 396/400 | 772/800 | 3.45 / 12.16 s | 191.0 s |
| rich-telemetry / SHORT_TURBO | message-v1 | 3,400/3,600 | 398/400 | 794/800 | 1.19 / 6.57 s | 104.7 s |
| rich-telemetry / SHORT_TURBO | message-v2 | 3,394/3,600 | 399/400 | 794/800 | 1.22 / 6.46 s | 104.7 s |

None of the 240 runs meets the strict criterion requiring every expected delivery and confirmation. A completed experiment is not a successful delivery of every publication. Packet losses, final message delivery, confirmations, and freshness remain separate in the JSON artifact.

These runs use the production Atlas transport on the deterministic modeled medium. They are not new native-firmware or physical-radio tests. The model excludes host encoding time, and summed airtime includes relay transmissions rather than directly measuring channel utilization. The current measurements do not establish guaranteed fleet capacity.

## Reproduction and evidence

```sh
node --import tsx packages/meshtastic-link/scripts/compare-message-compression.ts /tmp/atlas-main-rebase.json 20 message-v2
npm run check --workspace @the-drunken-coder/atlas-meshtastic-link
```

Use a new output path and Node 24.6 or newer within Node 24.

- Executed revision: `44a439df6f939a63ddd40a539dd24eb65733575b`.
- Source fingerprint: `86c77f0d7cd0d36fb1cb6f74473bef5a0479945f8ebde07c875d6ae1ff96105d`.
- Runtime: `v24.19.0`.
- Benchmark script SHA-256: `b51e3ebbe5f40fab68d23837465a64e5d431e53780dd35ff71dde39cd3661ae5`.
- Local artifact: `.benchmarks/meshtastic-main-rebase/2026-09-06/comparison-20-seeds.json`.
