# Asset inspection repeats task derivation on clock updates

1. **Time & Date:** 2026-09-07T08:15:44Z
2. **Name:** Asset inspection repeats task derivation on clock updates
3. **Issue:** Asset inspection derives active, queued, and historical tasks on every render, including its one-second clock updates when the task map has not changed.
4. **Severity:** S5 (Note)
5. **Location:** `surfaces/command-interface/src/features/assets/AssetInspector.tsx:44-54`, `surfaces/command-interface/src/features/useHeartbeatClock.ts`, and `surfaces/command-interface/src/atlas/selectors.ts:30-46`.
6. **Expected:** Clock-only updates refresh relative-time and heartbeat presentation without repeating unchanged task derivations. A task-map or selected-asset change must refresh all sections and preserve each section's existing ordering.
7. **Actual:** The inspector invokes three selectors on each render. Each independently enumerates the complete task map and sorts its matching tasks. The history path additionally sorts all tasks for the asset before retaining terminal tasks and limiting to 25. A disposable probe of the three actual selectors counted three `Object.values` enumerations of the same task map for one inspector derivation.
8. **Reproduction:**
   1. Run `sed -n '44,54p' surfaces/command-interface/src/features/assets/AssetInspector.tsx` and `sed -n '30,46p' surfaces/command-interface/src/atlas/selectors.ts`.
   2. Create a fixed snapshot with `entityFixture` and `taskFixture`. Spy on `Object.values`, invoke `activeTasks`, `queuedTasks`, and `tasksForAsset` as the inspector does, and count calls whose argument is that snapshot's task map. The count is three.
   3. Trace the inspector's `useHeartbeatClock()` call to its 1,000 ms interval. The task derivations are ordinary render-time calls with no memoization, so the same work repeats when only the clock changes.
9. **Notes:** Source finding F07b, from the entity-browsing row and selector discussion. Verified at `c62cb735a91c780c1fc8a5820dfe3cebf1656841`. The selector-count probe and existing asset-inspector tests passed. This is redundant computation, not a measured latency defect. Memoizing the derived sections using the task-map identity and asset ID is a narrow option. Do not force active/queued task order and history recency into one sorting policy. F07a concerns sorting unrelated entity kinds and has a separate report.
