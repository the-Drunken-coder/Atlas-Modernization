# Meshtastic hardware validation

Two Heltec V3 radios exposed firmware behavior that the native simulator did not reproduce. The corrected physical one-hop test completes the requested five-minute command workload. The three-Asset native scenario still fails, so the mesh-wide reliability issue is not fully resolved.

## Results

Every load run schedules telemetry every five seconds and a command/report exchange every fifteen seconds for five minutes, followed by a thirty-second observation period. Commands and reports require Atlas confirmation; telemetry is best effort.

| Test | Exchanges within deadline | Confirmed command/report legs | Telemetry delivered |
| --- | --- | --- | --- |
| Physical quiet, including one injected packet drop | 3/3 | 6/6 | None scheduled |
| Physical load before radio-priority fix | 12/20 | 7/39 submitted | 45/60 |
| Physical load with radio-priority fix | **20/20** | **40/40** | **55/60** |
| Native gateway with A, B, and C, current code | 18/20 | 30/40 | 92/180 |

The successful physical load run had no radio send failures, malformed frames, or duplicate application acceptances. Round trips took 1.91–4.99 seconds (median 2.43 seconds). Five telemetry publications did not arrive; this is an application delivery count, not a measurement of RF packet loss. In the quiet recovery run, one of 21 incoming Atlas packets was deliberately dropped before reassembly, yet every application message arrived and was confirmed.

## Confirmed fixes

- **USB framing and shutdown:** replace the SDK parser that mistakes payload bytes for framing and the serial shutdown path that throws an unhandled abort error. Serial and TCP now share a length-based binary parser.
- **Radio configuration:** accept Meshtastic's US transmit-power readback of 30 for the configured default 0; construct missing protobuf module settings when installing a fresh private channel.
- **Private-channel delivery:** retain Meshtastic broadcast for normal Atlas traffic. Real firmware automatically converts native directed PRIVATE_APP packets to PKI on channel 0, while `force_simradio` explicitly skips that conversion. Atlas application destinations and confirmations remain in its own frames.
- **Firmware queue priority:** carry Atlas priority into the radio queue so commands and confirmations can precede telemetry and queued relays. Before this change, firmware treated all Atlas packets as equal priority. A 750 ms spacing-only experiment did not fix the failure and was not adopted.

## Hardware and scope

Both devices run official Meshtastic `2.7.26.54e0d8d`, matching native firmware commit `54e0d8d0ab2ff56b3a9ce967e53f79e49af560fb`. Both reported hardware model 43 (Heltec V3), passed the production Atlas profile readback, and used US / SHORT_FAST / frequency slot 20 / hop limit 3 / CLIENT / LOCAL_ONLY with a shared private secondary channel. The user confirmed attached 915 MHz antennas. The profile retains firmware-default transmit power; configuration 30 does not mean the hardware emits 30 dBm.

This is a strong-signal bench test with two radios, not a range test. It preprovisions membership through the production profile manager and does not validate joining, physical task execution, or the B-to-C relay. Native three-Asset packet history is complete and the saved Lab scenario was restored. The two missing native reports remain an open reliability limit.

All 243 package tests pass, along with generation, formatting, lint, type checking, build, and `git diff --check`. Changes are local.

## Evidence and restoration

Local artifacts are under `.benchmarks/meshtastic-hardware/2026-09-05/` at the repository root. Each result retains workload, executable source fingerprints, message outcomes, packet admissions, and profile evidence:

- `quiet-broadcast-result.json`: physical retry recovery.
- `load-broadcast-result.json`: physical load before radio priority.
- `load-paced-result.json`: rejected spacing-only experiment.
- `load-priority-result.json`: final physical load, including RF receive metadata and local device telemetry.
- `fleet-native-priority.json`: final native three-Asset run.
- `preflight.json`: verified firmware image identities and flash metadata.
- `backups/`: complete, digest-verified 8 MiB MeshCore images for each exact MAC; private and excluded from Git.

Both radios are left on Meshtastic with USB connections closed. Restore MeshCore only from the backup matching that radio's MAC. The detailed chronology and earlier native controls are in [Gateway fleet validation](GATEWAY-FLEET-VALIDATION.md).

## SHORT_TURBO comparison

At the user's request, both radios were changed to `SHORT_TURBO` and passed production profile readback. Only `modem_preset` required a configuration write. The five-minute workload, payload limit, compact encoding, radio priorities, deadlines, and thirty-second drain remained the same.

| Physical result | SHORT_FAST | SHORT_TURBO |
| --- | --- | --- |
| Exchanges within deadline | 20/20 | 20/20 |
| Confirmed command/report legs | 40/40 | 40/40 |
| Telemetry publications delivered | 55/60 | 46/60 |
| Median round trip | 2.43 s | 2.81 s |
| Maximum round trip | 4.99 s | 6.60 s |
| Local radio send failures | 0 | 0 |

SHORT_TURBO did not improve this single bench run: command reliability remained complete, while telemetry delivery and observed latency were worse. These are one run per preset, not a statistical comparison or a range test. RF packet loss is still unmeasured. The Turbo run completed with no runner errors, malformed frames, or duplicate application acceptances.

Evidence: `.benchmarks/meshtastic-hardware/2026-09-05/load-turbo-result.json`, `turbo-config.json`, and `turbo-profile-*.json`. Both radios are now left on verified SHORT_TURBO with their USB connections closed. The earlier SHORT_FAST results above remain unchanged.
