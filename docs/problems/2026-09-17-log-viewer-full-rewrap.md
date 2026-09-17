# Problem: Live log appends rebuild every retained display row

1. **Time & Date:** 2026-09-17T15:09:42Z
2. **Name:** Log viewer rewraps the retained buffer on every appended line
3. **Issue:** The live log viewer performs full retained-buffer wrapping work for each incoming log line, even though it only renders the current viewport.
4. **Severity:** S4 (Minor)
5. **Location:** `surfaces/core-cli/src/log-stream.ts:149-191,226-260`; `surfaces/core-cli/src/terminal-ui.tsx:1667-1713,1768-1797`
6. **Expected:** Appending a new line should update the latest display rows with bounded incremental work. Rewrapping retained history should be reserved for a width change or another operation that actually changes historical wrapping.
7. **Actual:** `LogBuffer.append()` adds one record and unconditionally calls `#rebuild()`. `#rebuild()` walks retained records from newest to oldest and calls `wrapAnsi(...).split("\n")` for each record until `MAX_DISPLAY_ROWS`; it does this even when following the latest viewport. The default buffer retains 200 records, each line may be 64 KiB, and the display-row cap is 100,000. The TUI calls `append()` for every framed stream line and increments the render revision; every visible row key includes that revision, so append-driven renders cannot reuse the existing row elements (`terminal-ui.tsx:1792-1793`).
8. **Reproduction:**
   1. Open any service's live log viewer at a terminal width of at least 40 columns.
   2. Stream lines continuously so `LogViewer` receives `onLine` callbacks (`terminal-ui.tsx:1704-1713`).
   3. Observe that each callback invokes `LogBuffer.append()`, and each append traverses and wraps the retained records (`log-stream.ts:186-191,226-245`) rather than only adding the new record's rows.
   4. At the default capacity, after 200 records have accumulated, every further line repeats wrapping work over up to 200 retained records. Long records can drive the loop to the 100,000-row materialization cap before the viewport is sliced (`log-stream.ts:211-218,228-245`).
9. **Notes:** The bounded capacity, 64 KiB per-line tail, 100,000-row cap, and viewport rendering prevent unbounded memory growth. Existing tests cover bounded rows and rewrapping correctness (`surfaces/core-cli/test/log-stream.test.ts:141-181`) but not append-time complexity or row remount churn. This verifies repeated full rebuild work; the stronger claim that a normal chatty API log pins an entire CPU core was not measured and is not asserted here. A runtime benchmark was not practical because workspace dependencies are absent (`npm test --workspace atlas-core` cannot find `vitest`). Audited at detached `43b5928ceba19bc95d00d578cc6ed9c03319167e`; no product code or tests were changed.
