# Gateway fleet validation, 2026-09-05

The workload has exactly three bidirectional edges: A–Gateway, Gateway–B, and B–C. Each Asset submits position telemetry every five seconds. Every fifteen seconds the Gateway submits a Task assignment, rotating A, B, C. An Asset that accepts the exact command immediately submits a synthetic completion report. No physical action or Core lifecycle is simulated.

There are 180 telemetry publications, 20 commands, and up to 20 triggered reports over five minutes, followed by a thirty-second drain. Command delivery allows fifteen seconds; the complete exchange allows thirty seconds from the command schedule. All radio settings, payload sizes, and expected outcomes remain in each artifact.

## Historical baseline before the radio-usage fixes

The baseline modeled run delivered two telemetry publications from A and none from B or C. One command arrived late, triggered a response, and completed an application round trip within thirty seconds. Neither leg received transport confirmation. All 200 scheduled messages and the one triggered response were admitted locally. Queued telemetry was superseded under load. These results expose overload with the current ordinary JSON encoding and modeled contention; they are not native RF loss measurements.

A separate quiet-link test completes the command and report with both transport confirmations. Production-transport tests also verify duplicate-command suppression and that a dropped command cannot produce a response. Nine new tests cover the reactive application, result accounting, config validation, cadence, and topology. All 227 package tests, generation, format, lint, type checking, and build passed. Focused tests and build also passed after the final modeled-runner reporting adjustment.

The SDK adapter now includes the radio's configured hop limit in outbound packets. Previously the protobuf default was zero, which prevented this experiment from exercising the intended relaying. The real-SDK adapter test checks the encoded packet's hop limit.

## Artifacts and scope

Local config, modeled and native reports, and the native client log are under `.benchmarks/meshtastic-lab/gateway-fleet/`. The directory is ignored by Git. Reports retain source fingerprints; earlier development artifacts remain identifiable separately. `modeled-current.json` is the final modeled report. Failed workloads retain their failed verdicts.

Telemetry age is measured from its scheduled sample time through the end of the observation window, including the drain. The modeled medium and native firmware have different scheduling and collision behavior. One run does not establish a sustainable rate or physical radio reliability.

The first native attempt was interrupted by the SDK input-framing parser treating the `94 c3` marker inside a binary payload as framing. Its parser then failed to make progress and repeatedly logged the same bytes. The stalled process was terminated, the log was reduced to its first and last 16 KiB, and the lab was stopped and restored to the five-node full-mesh preset. `native.json` records an incomplete integration failure, not capacity evidence.

The lab TCP adapter now parses payloads strictly by the advertised frame length, preserving embedded markers. Six focused framing cases cover arbitrary TCP chunk boundaries, coalesced frames, embedded markers, and invalid/truncated input. It retains at most one partial uint16-length frame. `native-2.json` is the rerun using this adapter.

## Native sustained workload

The repaired-framing native run completed its entire observation window with complete packet history, no runner errors, and successful lab restoration. It delivered zero of 180 telemetry publications and zero of 20 commands. No Task report was triggered. All 200 scheduled messages were admitted to the Link; firmware send failures and incomplete reassemblies remained visible in node metrics.

The medium recorded 2,378 RF transmissions and 421.4 seconds of aggregate airtime across radios. This aggregate is not channel utilization. Packet IDs observed first from C with hop limit 3 were subsequently transmitted by B with hop limit 2, confirming that the intended relay path was exercised. Native packet-loss rate remains unknown because injection does not prove firmware reception; topology exclusions are not counted as losses.

This native snapshot preceded the final removal of the test application's late-command response gate. No command was accepted in that run, so that branch was never exercised. The final late-command behavior is covered by a focused test and `modeled-current.json`, which records a late command followed by a delivered response without transport confirmations. The workload, topology, radio configuration, and framing are unchanged between these snapshots.

## Quiet native control

`reactive-quiet.json` uses the final code, the same SHORT_FAST preset and configured three-hop limit, two nodes, and one command with a conditional report. It also failed to deliver the complete command. The Asset received ten fragments and sent one repair request; the Gateway received only one return fragment. Neither side recorded malformed Atlas frames or invalid complete messages. The lab restored successfully.

At that point, the native sustained failure could not be attributed solely to the requested fleet load. Native relay-enabled transport reliability was unresolved in that baseline. The new reactive application is covered by successful modeled production-transport exchanges, including duplicate-command handling, late commands, and loss accounting; those baseline artifacts do not claim successful native command/result completion.

## Radio-usage fixes

The earlier candidate used native unicast for resolved destinations, opt-in lossless `deflate-v1` framing, and the native firmware wrapper's six-byte reservation. The physical comparison below invalidates native unicast for normal private-channel traffic; current code uses private-channel broadcast. The generated fleet staggers telemetry at offsets 0/1.6/3.2 seconds while preserving each Asset's five-second cadence. Simultaneous telemetry remains an explicit stress option. All radios remain CLIENT with native collisions enabled.

The initial compact/unicast quiet native test completed and confirmed both legs in 1.53 seconds. After refining the compact header and using the 227-byte native limit, the quiet two-hop test passed all three exchanges through B, with round trips of 4.21, 9.09, and 4.57 seconds. The middle exchange deliberately dropped one command packet before Atlas reassembly. Atlas retransmitted it, the final message arrived, and both legs were confirmed. Its measured injected packet-drop rate was 1/13 while application exchange failure was 0/3. Native radio packet-loss rate remains unknown.

Before retry jitter, the compact staggered native fleet completed 18/20 round trips and delivered 105/180 telemetry publications (A 32, B 48, C 25). It recorded 842 native transmissions and 138.956 seconds of aggregate radio airtime, compared with the baseline's 2,378 transmissions and 421.4 seconds. The strict complete-workload verdict remained failed. One telemetry message can still require two packets when its identifiers or payload are larger; no universal one-packet claim is made.

A focused transport test reproduces a repeating five-second interference window: fixed-period retries never deliver, whereas bounded retry jitter delivers within the same fifteen-second deadline. The ten-seed modeled fleet sweep improved from 198/200 to 200/200 complete application round trips after enabling up to one second of retry jitter. Of 400 confirmed message legs, 395 received their transport confirmation. Best-effort telemetry loss remains separate; these runs do not establish physical radio reliability.

Current diagnostic artifacts are under `.benchmarks/meshtastic-lab/diagnosis/`: `optimized-quiet.json`, `two-hop-native.json`, `current-fleet-native.json`, and `jitter-seed-sweep.json`. Every artifact retains its config and code fingerprint. Test-only additions after a run may change the aggregate source fingerprint; the executable file hashes retain the exact runtime evidence.

The first native fleet run with jitter completed 19/20 application round trips and delivered 109/180 telemetry publications (A 37, B 50, C 22). It confirmed only 22/40 message legs, versus 33/39 in the preceding non-jitter run. All 20 commands reached their Assets; one response never reached the Gateway. This is not evidence that jitter improves native confirmation reliability. It retains a failed strict verdict, complete packet history, no runner errors, and successful restoration in `jitter-fleet-native.json`.

A diagnostic 750 ms packet-spacing run (`paced-fleet-native.json`) completed 19/20 round trips, confirmed 31/39 submitted message legs, and delivered 108/180 telemetry publications. Its spacing override is recorded separately in the artifact and is not a production default. This run also failed the strict workload, retained complete evidence, and restored the lab. Fixed pacing alone did not resolve the sustained workload.

## Current disposition

The package's complete check passes: generation, formatting, lint, type checking, 243 tests, and build. Canonical normal/stress benchmark snapshots remain unchanged. The compact codec, native payload bound, and bounded retry jitter are implemented and covered. Native unicast was removed after the physical firmware mismatch described below. The five-minute native fleet remains a failed capacity experiment, not a completed reliability fix. Native packet loss remains unknown; controlled injected loss and final message failures remain separate.

The physical comparison below now isolates a real firmware/simulator mismatch. The earlier unicast results remain historical evidence and do not validate the corrected broadcast transport. Two radios cannot independently validate the B-to-C relay.

## Physical radio findings

Both Heltec V3 radios were backed up in full, independently verified, and flashed with the official `2.7.26.54e0d8d` release matching native firmware commit `54e0d8d0ab2ff56b3a9ce967e53f79e49af560fb`. The attached 915 MHz antennas were confirmed. Bench artifacts and private MeshCore backups are under `.benchmarks/meshtastic-hardware/2026-09-05/`.

Physical startup reproduced three adapter defects: the SDK serial transport crashes on normal disconnect and uses the same unsafe binary parser as TCP; US firmware expands transmit power 0 to configuration value 30 before readback; and a fresh secondary channel may omit protobuf module settings. The serial adapter now uses the shared length-based parser and clean port closure, profile verification accepts the documented US default expansion, and channel updates construct missing nested protobuf messages. Focused tests cover each case.

The first physical quiet run (`quiet-result.json`) accepted no application messages, despite ten intact command packet receptions at the Asset and successful local queue admission. The matching native unicast control (`quiet-native.json`) passed. Firmware `src/mesh/Router.cpp` automatically converts directed PRIVATE_APP packets to PKI on channel 0; its `force_simradio` branch explicitly skips that conversion. Atlas correctly rejects channel 0 for private-channel application traffic. Normal Link sends now retain private-channel broadcast and carry application destinations inside Atlas frames. Joining keeps its separate PKI exchange.

Bench tests preprovision the private channel through the production profile manager. They do not test joining, physical execution, range, or the B-to-C relay. Queue acceptance is not RF delivery, controlled drops occur after firmware reception, and physical RF packet loss remains unmeasured.

The corrected physical quiet run (`quiet-broadcast-result.json`) completed all three round trips in 3.210, 7.639, and 3.546 seconds. All six command/report legs arrived and were confirmed within their deadlines. One of 21 observed incoming Atlas packets was deliberately dropped after firmware reception (4.76% injected packet loss), while final message and exchange failure rates were both zero. All recorded packet headers used channel 1 without PKI; no malformed frames, duplicate application acceptances, or runner errors were recorded.

The first corrected broadcast load comparison still failed: physical one-hop completed 12/20 round trips within 30 seconds, delivered 19/20 commands and 18/19 submitted reports eventually, and confirmed only 7/39 legs within their fifteen-second transport deadlines. It delivered 45/60 telemetry publications. There were 41 local radio send failures, no malformed frames, and no runner errors. Native one-hop completed 20/20 exchanges, confirmed 36/40 legs, and delivered 45/60 telemetry publications. The full native three-Asset broadcast run completed 16/20 exchanges, confirmed 23/39 submitted legs, and delivered 99/180 telemetry publications. Artifacts are `load-broadcast-result.json`, `load-native-broadcast.json`, and `fleet-native-broadcast.json`.

A physical diagnostic with 750 ms packet spacing completed only 10/20 exchanges and confirmed 8/40 legs. Rejections reported firmware error 32 (`ERRNO_UNKNOWN`), consistent with the radio transmit queue's refusal path. Fixed spacing was not adopted as a production default.

Firmware queue inspection found that Atlas discarded its host scheduling priorities at the radio boundary. Normal Atlas packets all arrived as `UNSET`, which firmware promoted to `DEFAULT`; for equal priority, firmware prefers relayed packets over local ones. Current code maps Atlas safety/confirmation traffic to `ACK`, tasks to `HIGH`, requests to `RELIABLE`, live state to `DEFAULT`, and bulk traffic to `BACKGROUND`. This is local radio queue scheduling, not an RF relay priority guarantee. Six serialization cases verify the priority mapping.

The physical priority run (`load-priority-result.json`) completed all 20/20 exchanges and confirmed all 40/40 command/report legs. Round trips ranged from 1.912 to 4.985 seconds, with a 2.425-second median. It delivered 55/60 best-effort telemetry publications. There were zero local radio send failures, zero malformed frames, zero duplicate application acceptances, and no runner errors. One report packet was retransmitted by Atlas. All 141 received Atlas packet headers used the private channel without PKI. These results support the local queue priority fix; they are one five-minute bench run, not a field reliability guarantee.

The final native three-Asset priority run (`fleet-native-priority.json`) completed 18/20 exchanges, confirmed 30/40 legs, and delivered 92/180 telemetry publications. All 20 commands arrived, but two reports never reached the Gateway. The run completed its observation window with no runner errors and restored the saved lab scenario. The strict fleet verdict remains failed. The ten-seed broadcast model sweep, performed before the radio-priority mapping, completed 200/200 exchanges and confirmed 398/400 legs; that model does not represent native firmware queue priority.

Current disposition: physical one-hop command/report delivery and confirmation work at the requested cadence after the adapter and queue-priority fixes. Best-effort telemetry loss and native three-Asset reliability remain unresolved. Two physical radios cannot verify the relay topology. Both radios remain on the verified Atlas Meshtastic profile; their USB connections are closed, and complete private MeshCore backups are retained.
