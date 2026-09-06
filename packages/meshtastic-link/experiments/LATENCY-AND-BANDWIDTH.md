# Latency and bandwidth optimization

Historical results from the pre-rebase Radio contract. See [validation after rebasing onto main](MAIN-REBASE-VALIDATION.md) for the current contract and fresh comparison.

This round implements the proposed Atlas-side improvements and compares them with the previous `deflate-v3` link. Binary encoding reduces airtime and median command latency, but the native runs do not establish a uniform improvement in tail latency or telemetry freshness. Adaptive retries and compact state updates remain optional.

## Implementation

- `binary-v1` replaces repeated schema keys and string values with generated tokens and retains exact numbers, strings, IDs, and full Protocol resources. It selects the smaller lossless frame representation. The 300-message codec fixture uses 52,245 bytes versus 57,674 under v3, a 9.4% reduction, with the same 300 frames. This fixture excludes retries, receipts, relays, and background traffic.
- `settleInboundWithTaskReport` exposes atomic acceptance and report admission through transport, service, HTTP, and SDK. It reserves both entries before accepting, preserves separate receipt/report outcomes, and replays the original admission result for an identical API retry. A delayed report still uses ordinary immediate acceptance followed by a later report. The old experiment application already submitted both synchronously, so this API improvement does not receive an artificial performance credit in the comparison.
- `TelemetryPublisher` provides deterministic per-node phases, fresh sampling, no backlog, and stale async result rejection. The original fleet already staggered telemetry; this makes that behavior available to applications without changing ordinary submission or command latency.
- `--adaptive-retries` learns per-destination, generation/session, and priority RTT from clean single-frame confirmations. Retransmissions and failed radio admissions do not train it. Fixed overrides and application deadlines remain intact.
- `--state-deltas` offers smaller updates against explicit full snapshots and reconstructs complete validated Protocol state. The first publication prepared after the baseline becomes fifteen seconds old is full. Deltas never depend on other deltas. Missing or evicted baselines fail closed; later full snapshots recover. Receiver caches retain latest and previous snapshots for each of 64 resource scopes. Full snapshots replaced before transmission cannot become dependencies.
- Experiment results now include time-weighted telemetry age, freshness gaps, unknown initial state, and a separate drain window. Message delivery, confirmation, and packet counters remain separate.

The default transmission encoding remains the named `canonical-json` baseline. Use `serve --frame-encoding binary-v1` to select the new candidate. Both additional modes are off by default. Matching Link software is required across the fleet; joining does not negotiate these options.

## Comparison design

The four-node topology is A–Gateway–B–C: A and B reach the Gateway directly; C uses B. Every Asset publishes a full valid telemetry observation every five seconds, phased at 0, 1.6, and 3.2 seconds. The normal command load is one fleet-wide round-robin exchange every fifteen seconds. The heavier load submits one command to each Asset every fifteen seconds, deliberately creating simultaneous command bursts. Commands have a fifteen-second delivery deadline; exchange responses have a thirty-second deadline measured from command submission. The active load lasts five minutes, followed by thirty seconds of drain.

The modeled matrix runs 50 seeds × two presets × two loads × five profiles: previous v3, binary, binary plus adaptive retries, binary plus deltas, and all options. It uses production framing, transport, application acceptance, and response generation with deterministic IDs. These are modeled radio results, not physical RF claims.

Native runs use Meshtastic firmware 2.7.26 through Meshtastic Lab's native collision simulator. There are two v3 baseline runs, two binary runs, one binary/adaptive run, and one binary heavier-load run, all on SHORT_TURBO. Native runs use fresh radio state and cryptographic IDs and are not deterministically replayable. Two runs per primary arm give limited evidence about tail behavior. No physical radios were used in this round.

## Native SHORT_TURBO comparison

| Metric, two runs per arm | Previous v3 | Binary |
| --- | ---: | ---: |
| Exchanges completed within 30 s | 39/40 | 39/40 |
| Median received exchange latency | 2.442 s | 2.037 s |
| p95 received exchange latency | 11.244 s | 15.342 s |
| Full telemetry observations delivered | 313/360 | 297/360 |
| Confirmed command/report messages | 75/80 | 73/80 |
| RF transmissions, including background and relays | 1,745 | 1,724 |
| Summed RF airtime | 154.268 s | 141.226 s |
| Host-admitted payload bytes | 98,326 | 91,001 |
| Atlas retransmissions | 40 | 53 |

Binary reduced summed RF airtime by 8.5% and median exchange latency by 16.6%. Tail latency, confirmation coverage, and telemetry delivery worsened in these samples. Asset C's worst per-run time-weighted p95 telemetry age increased from 11.1 to 12.8 seconds. All four runs had zero local radio-send failures, malformed frames, invalid messages, incomplete reassemblies, and duplicate application acceptances. These counters rule out observed codec/reassembly failures; they do not explain every native radio drop.

The single adaptive run completed 19/20 exchanges, delivered 153/180 telemetry observations, and used 70.983 seconds of summed RF airtime. Median exchange latency was 3.939 seconds and p95 was 11.500 seconds. This is not enough evidence to recommend it over fixed retries on native firmware.

The heavier binary run completed 57/60 exchanges within thirty seconds and delivered 135/180 full telemetry observations. Median exchange latency was 8.778 seconds and p95 was 21.723 seconds, with 116.013 seconds of summed RF airtime and 143 Atlas retransmissions. Only 97 of the 120 expected command/report confirmations arrived within their respective deadlines; one command never triggered a report. There were no local submission rejections or duplicate application acceptances. This simultaneous-burst workload does not meet a low-latency target, despite the more optimistic modeled results.

Native RF injection is not proof of successful firmware reception. The packet-loss rate remains unknown; it is not calculated from topology exclusions or inferred from missing application messages. Summed airtime across radios is not channel utilization.

## Final modeled results

Each row aggregates fifty seeds. Latencies include received responses, including late ones; exchange success uses the thirty-second deadline. Airtime is the sum across modeled radio transmissions. Each row schedules 9,000 telemetry observations.
### SHORT_TURBO, one fleet-wide command every fifteen seconds

| Profile | Exchanges | Median | p95 | Telemetry delivered | Summed airtime |
| --- | ---: | ---: | ---: | ---: | ---: |
| Previous v3 | 1000/1000 | 0.916 s | 5.707 s | 8882/9000 | 2862.8 s |
| Binary | 1000/1000 | 0.867 s | 5.635 s | 8904/9000 | 2623.5 s |
| Binary + retries | 1000/1000 | 0.872 s | 3.384 s | 8906/9000 | 2638.0 s |
| Binary + deltas | 999/1000 | 0.886 s | 5.652 s | 8798/9000 | 2455.2 s |
| All options | 1000/1000 | 0.869 s | 3.409 s | 8747/9000 | 2464.0 s |

### SHORT_TURBO, one command per Asset every fifteen seconds

| Profile | Exchanges | Median | p95 | Telemetry delivered | Summed airtime |
| --- | ---: | ---: | ---: | ---: | ---: |
| Previous v3 | 3000/3000 | 1.878 s | 7.484 s | 8697/9000 | 4075.3 s |
| Binary | 3000/3000 | 1.751 s | 7.445 s | 8702/9000 | 3809.6 s |
| Binary + retries | 3000/3000 | 1.756 s | 6.415 s | 8623/9000 | 3933.2 s |
| Binary + deltas | 3000/3000 | 1.741 s | 7.370 s | 8411/9000 | 3629.3 s |
| All options | 2999/3000 | 1.754 s | 6.288 s | 8004/9000 | 3760.4 s |

On SHORT_FAST under the heavier load, binary improved exchange completion from 2,987/3,000 to 2,993/3,000 and p95 latency from 14.049 to 12.038 seconds. Enabling adaptive retries there reduced completion to 2,977/3,000. Smaller updates save further airtime but lose more telemetry when a baseline is missing. The extra modes therefore remain experimental rather than universal improvements.

## Validation and evidence

All generated-contract, formatting, lint, typecheck, 365 tests, and build checks pass. The strict fleet scenario still reports `passed: false` when any scheduled telemetry or required confirmation is missing; successful exchanges do not hide those failures. Focused coverage includes atomic HTTP replay, conflicting replay, capacity failure, queue coalescing, lost-baseline recovery, late full snapshots, bounded cache eviction, lossless codec fallback, fixed retry overrides, failed-send RTT exclusion, and telemetry stop/restart behavior.

Final source fingerprint: `7e0975f7c66abbfabfa48695e705dc10b32b7c7d6400c3ff2d04f0ad9394e8c3` on checkout `72a47ae9b8c2e5143b51ccee1f23287dc1593dfe` with local changes. It was rechecked after the final matrix.

Local raw evidence is under `.benchmarks/meshtastic-latency/2026-09-06/`:

- `baseline-package/` and `baseline-source.json`: frozen previous implementation.
- `final-source.json` and `final-model-50-seeds.json`: final source fingerprint and complete modeled matrix.
- `fleet-before-{1,2}.json`, `fleet-after-{1,2}.json`, `fleet-adaptive-1.json`, `fleet-heavy-1.json`: native evidence, config, and per-run source provenance.
- `native-summary.json`, `native-freshness.json`, and `package-check-final.log`: derived comparison and validation.
- `lab-source.json`: native Lab provenance.

Native runs preceded some final defensive fixes for unusual Unicode IDs, cache churn, failed local admissions, and API replay; their recorded source fingerprints remain separate. The ASCII fleet fixtures did not exercise those edge cases. The final modeled matrix and complete package checks cover the final code. Native runs restore the previous Lab scenario and leave it stopped.
