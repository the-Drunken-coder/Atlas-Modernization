1. **Time & Date:** 2026-09-12T23:31:00Z
2. **Name:** Meshtastic queue timers delay normal Link process exit
3. **Issue:** After `startLinkService.close()` finishes, Link processes that used the real `MeshtasticSerialRadio` adapter remain alive until referenced packet-queue timers expire.
4. **Severity:** S3 (Moderate)
5. **Location:** `@meshtastic/core` 2.6.7 `dist/mod.js:12545-12599,13309-13319`, pinned by `packages/meshtastic-link/package.json:35`; detected by `packages/meshtastic-link/acceptance/process-acceptance.ts:224-243`
6. **Expected:** A `SIGTERM` requests the shared lifecycle's ordered cleanup, both compiled Link processes exit normally within the acceptance's 15-second deadline, the event stream closes, and their loopback ports become reusable.
7. **Actual:** Configuration, authenticated joining, public state delivery, and Shared Picture publication succeed. Both process summaries report zero lifecycle-owned active connections and pending writes. After lifecycle close and IPC disconnect, however, each process still reports 11 active `Timeout` resources and misses the normal-exit deadline. The controller's cleanup signal terminates the processes, so it cannot claim normal exit or port-reuse evidence. In `@meshtastic/core` 2.6.7, `Queue.push` schedules a referenced 60-second `setTimeout` for every packet; acknowledgement removes the queue item without cancelling its timer, and `disconnect()` clears queue entries without cancelling those timers.
8. **Reproduction:**
   1. Check out revision `47be6d09bc713310b7a4b2ece0a49248a85fae03` and use Node 24.
   2. Run `npm run test:acceptance --workspace @the-drunken-coder/atlas-meshtastic-link`.
   3. Observe `gateway did not exit` after the 15-second bound.
   4. Inspect `gateway.summary.json` and `asset.summary.json` under `.tmp/link-acceptance/baseline-36b22ea7-f8f6-473e-ab3e-96538fc7d913`; each records 11 `Timeout` resources after IPC disconnect while `lifecycle_cleanup.active_connections` and `pending_writes` are zero.
9. **Notes:** Preserved evidence is at `/tmp/atlas-testing-coordination/evidence-389-shutdown-confirmed`, including checksums and the exact stdout. Issue #389 keeps the normal-exit assertion active. Do not add `process.exit`, unref the observed timers, or weaken the deadline in the test-only PR; repair or update the production dependency lifecycle separately.
