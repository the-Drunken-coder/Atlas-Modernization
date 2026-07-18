# JavaScript maintainability complexity is mostly outside enforced lint gates

1. **Time & Date:** 2026-07-18T08:27:38-04:00
2. **Name:** JavaScript maintainability complexity is mostly outside enforced lint gates
3. **Issue:** The JavaScript lint baseline strongly enforces correctness and promise safety, but cognitive-complexity checks are scoped to a few known files and are warnings rather than a source-wide ratchet.
4. **Severity:** S4 (Minor)
5. **Location:** `biome.json`, `atlas_sdk/biome.json`, `atlas_asset_runtime/biome.json`, `atlas_command_interface/biome.json`, `atlas_simulations/biome.json`
6. **Expected:** New production code cannot silently add substantially more branching complexity, while existing intentional parsers and coordinators can be reduced incrementally.
7. **Actual:** Normal workspace lint passes despite many production functions exceeding cognitive complexity 15. Representative diagnostics include `AtlasProvider` at 30, `CommandForm` submission at 27, `MapConsole` at 20, and the simulations HTTP request dispatcher at 37.
8. **Reproduction:**
   1. Run `../node_modules/.bin/biome lint --config-path biome.json --only=complexity/noExcessiveCognitiveComplexity --max-diagnostics=200 .` from each JavaScript workspace
   2. Compare the diagnostics with `npm run lint --workspaces --if-present` from the repository root
   3. Observe that only explicitly configured hotspot files report complexity during the normal lint command
9. **Notes:** Do not enable every Biome style rule or fail the entire existing backlog at once. A source-only warning baseline followed by a changed-code or per-file ratchet would preserve the current low-churn approach.
