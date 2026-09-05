# Simulation client duplicates the run-status guard

1. **Time & Date:** 2026-09-04T23:55:26+00:00
2. **Name:** Simulation client duplicates the run-status guard
3. **Issue:** The simulations client defines the same five-value `RunStatus` guard independently in the API response validator and the run-event parser. This is a concrete duplication of the maintenance point for the shared `RunStatus` contract.
4. **Severity:** S5 (Note)
5. **Location:** `simulations/src/client/api.ts:256-282`, `simulations/src/client/run-state.ts:148-229`, and the shared status type at `simulations/src/shared/types.ts:65`
6. **Expected:** A single typed `isRunStatus(value: unknown): value is RunStatus` guard beside `RunStatus` is reused by both client validation paths.
7. **Actual:** `api.ts` has a boolean `isRunStatus` guard at lines 278-282, while `run-state.ts` has a separately maintained typed guard at lines 225-229. Both currently accept exactly `running`, `completed`, `failed`, `cancelled`, and `abandoned`.
8. **Reproduction:**
   1. Check out `cf90a53ad03b4796ea47c649b525f0cb282c1a14`.
   2. Run `rg -n -A4 '^function isRunStatus' simulations/src/client/api.ts simulations/src/client/run-state.ts`.
   3. Compare the two function bodies with the `RunStatus` union in `simulations/src/shared/types.ts`; the predicates are identical and are maintained in separate files.
9. **Notes:** Source mapping: F04, Slopo cluster 24, hash `bceb436730fa`. This is a deterministic maintenance duplication confirmed by source inspection, not a current runtime defect. Parent verification executed both exact predicates with five valid and seven invalid values; all results were equivalent. `simulations/test/client/api.test.ts` covers malformed API run responses, and `simulations/test/client/run-state.test.ts` covers valid and invalid status events. The focused test command could not execute in this checkout because `vitest` is not installed. The cleanup should preserve both boundary behaviors while centralizing the typed guard.
