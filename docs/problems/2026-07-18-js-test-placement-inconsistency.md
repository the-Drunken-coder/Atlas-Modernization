# JavaScript workspaces disagree on test file placement

1. **Time & Date:** 2026-07-18T08:29:35-04:00
2. **Name:** JavaScript workspaces disagree on test file placement
3. **Issue:** The command interface colocates all test files next to source under `src/`, while the SDK, asset runtime, and simulations keep tests in a separate `test/` directory, so agents moving between packages follow different conventions.
4. **Severity:** S5 (Note)
5. **Location:** `atlas_command_interface/src/` (40 colocated `*.test.*` files), `atlas_sdk/test/`, `atlas_asset_runtime/test/`, `atlas_simulations/test/`
6. **Expected:** One convention across the workspace, or a recorded decision that the divergence is intentional (e.g. component tests colocate, package tests live in `test/`).
7. **Actual:** Each package is internally consistent but the workspace is split two ways with no recorded rationale.
8. **Reproduction:**
   1. Run `find atlas_command_interface -name '*.test.*' -not -path '*/node_modules/*' | head`
   2. Run `ls atlas_sdk/test atlas_simulations/test`
9. **Notes:** Cosmetic; no action needed until it causes confusion. If a convention is chosen, record it in `docs/design-decisions/` rather than moving files speculatively.
