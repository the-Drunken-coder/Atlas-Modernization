# Native experiment validation, 2026-09-05

These are integration measurements of the new Atlas-owned runner, not field performance or capacity claims. The lab was unchanged. Each run saved its config, code fingerprint, native firmware provenance, packet events, and per-node transport metrics.

The source CLI ran the six initial scenarios. The built CLI ran the recovery repeat. Reports reflect the code fingerprint captured during each development run; the JSON files retain the full identities.

| Scenario | Injected drops | Injected duplicates | Last receiver acceptance | Sender confirmation | Expectation passed |
| --- | ---: | ---: | ---: | ---: | --- |
| quiet | 0 | 0 | 2.73 s | 4.62 s | Yes |
| recover-loss | 1 | 0 | Not delivered | Not confirmed | No |
| recover-loss-repeat | 1 | 0 | 12.53 s | Not confirmed | No |
| no-delivery | 19 | 0 | Not delivered | Not confirmed | Yes |
| lost-confirmation | 2 | 0 | 12.87 s | Not confirmed | Yes |
| duplicate | 0 | 9 | 6.69 s | 8.72 s | Yes |
| state-fanout | 0 | 0 | 3.14 s | Not required | Yes |

Every observed Task was accepted at most once. The complete-loss scenario passed its negative expectation while reporting 100% message-delivery failure. The lost-confirmation scenario reported 0% message-delivery failure and 100% confirmation failure.

The recovery case failed its positive expectation in both native trials for different reasons. The first never completed delivery. The second recovered the message within the delivery deadline, but sender confirmation timed out. Those outcomes remain distinct; neither result was relabeled as a pass. The same controlled fault is repaired and confirmed in the deterministic production-Link tests.

All runs used the declared 200-byte fragment ceiling and SHORT_FAST. The Task observation window was 20 seconds, with a 15-second delivery/confirmation deadline. State fanout used a 35-second observation window and a 30-second deadline. Native scheduling and additional RF losses vary between runs.

The initial 233-byte connection trial exposed firmware TOO_LARGE rejections despite queue acceptance. A 230-byte trial still failed complete reassembly. The successful 200-byte trial also required correcting the existing Atlas adapter to read the SDK protobuf payloadVariant oneof; a real-SDK inbound-frame test covers that correction.

Validation completed:

- Package generation, formatting, lint, type checking, all 211 tests, and build passed. The focused nine semantic tests also passed after aligning their payload ceiling with the native configs.
- The public experiments export imported from the built package and produced a source fingerprint.
- The built CLI saved a failure artifact for an unavailable lab and refused to overwrite an existing result.
- Every native report recorded successful lab restoration. The final live API check confirmed the simulation was stopped.

Local full artifacts and client logs are under `.benchmarks/meshtastic-lab/2026-09-05/` at the Atlas repository root. This directory is ignored by Git. No raw results are represented as deterministic baselines.

Native firmware commit: `54e0d8d0ab2ff56b3a9ce967e53f79e49af560fb`. The artifacts retain the binary hash and the running lab image revision separately from the local lab checkout.

## Recovery investigation

The unchanged recovery scenario passed a fresh baseline trial at 8.96 seconds to confirmation, establishing that the original failure was intermittent. Inspection also found that the default ten-second idle repair timer and its remaining-time guard prevented a missing-fragment request for a Task with a fifteen-second deadline. Recovery depended on full-message retries.

The transport now starts a repair wait of at most one second when the final fragment of an addressed confirmed Task or safety message arrives with earlier fragments missing. It keeps the ordinary timeout before that final fragment arrives and between unanswered repair requests. The deadline, workload, injected fault, and success criteria are unchanged.

A focused test failed on the original code and passes with the change. It checks that the receiver waits for the final fragment, requests only the missing first fragment, avoids repeated repair requests during the exchange, and accepts the completed Task once. All 212 package tests pass with two workers, alongside generation, format, lint, type checking, and build checks. A full-concurrency run hit an existing capacity test's five-second timeout; the complete suite passed with two workers without changing that timeout. Regenerating the deterministic normal and stress baselines produced no changes.

Native investigation artifacts are under `.benchmarks/meshtastic-lab/recovery-investigation/`. Each report retains its exact source fingerprint. Intermediate timing experiments are preserved there, including an unsuccessful trial that added repair traffic during a full retry; they are not final-code validation.

Two consecutive runs on the final source fingerprint `18abd7c9007acc8810ea13ae9f1d7ffb7165fafd52d486d8b6a066645b3efcd0` passed:

| Report | Receiver acceptance | Sender confirmation | Task packet admissions | Repair requests received by sender |
| --- | ---: | ---: | ---: | ---: |
| final-2.json | 11.25 s | 13.12 s | 16 | 1 |
| final-3.json | 5.97 s | 7.86 s | 8 | 1 |

Both injected exactly one drop, accepted the Task exactly once, and restored the stopped lab. The faster run admitted the seven original fragments plus only the missing fragment. The slower run also required a full retry. These are successful native recovery trials, not an estimate of long-term reliability. The six deterministic semantic scenarios also pass; the other five native scenarios were not rerun during this investigation.
