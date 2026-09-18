# Problem: TUI reset confirmation omits the concrete deployment target

1. **Time & Date:** 2026-09-17T11:38:13-04:00
2. **Name:** TUI reset confirmation omits the selected `ATLAS_CORE_HOME`
3. **Issue:** The interactive reset confirmation does not identify the concrete configuration directory or deployment target that will be destroyed. This matters because the CLI supports selecting different deployments with `ATLAS_CORE_HOME`.
4. **Severity:** S4 (Minor)
5. **Location:** `surfaces/core-cli/src/terminal-ui.tsx:1148-1179,1206-1277`; direct wording in `surfaces/core-cli/src/application.ts:2511-2519`
6. **Expected:** Before asking for confirmation, the TUI should identify the selected deployment with at least its resolved configuration path (and, if available, the Core version or resource namespace), matching the direct CLI's warning.
7. **Actual:** The menu labels the target only `local-engine` (`terminal-ui.tsx:1168`) and the confirmation says `Reset permanently deletes this deployment` followed by generic resource classes (`:1267-1275`). It never displays the resolved `ATLAS_CORE_HOME` path. The direct CLI explicitly prints `... configuration at ${this.#configDir}` (`application.ts:2513-2515`).
8. **Reproduction:**
   1. Use or initialize a deployment with `ATLAS_CORE_HOME=/tmp/atlas-core-a`; the documented CLI allows alternate homes (`surfaces/core-cli/README.md:40-48`).
   2. Start the interactive TUI and select `Reset Atlas Core`.
   3. Observe that the confirmation identifies only “this deployment,” with no `/tmp/atlas-core-a`, container namespace, or other concrete target identity.
   4. Compare `ATLAS_CORE_HOME=/tmp/atlas-core-a atlas-core reset --manual`; its direct confirmation names the exact configuration path before prompting.
   5. Repeat with a second home, such as `/tmp/atlas-core-b`; the TUI confirmation text is otherwise indistinguishable, so a mis-selected environment can lead an operator to confirm the wrong deployment without a final target-identity check.
9. **Notes:** `DeploymentSnapshot` intentionally carries status/detail/version and `canReset`, but no deployment identity (`surfaces/core-cli/src/operator.ts:7-14`). The TUI therefore cannot show the path without a small typed snapshot/operator contract extension. The existing TUI test only waits for the generic data-deletion text (`surfaces/core-cli/test/terminal-ui.test.ts:1165-1177`) and does not assert target identity. The reset operation remains confirmation-gated and its backend ownership checks are separate; this report concerns the last-mile human confirmation, not reset authorization or deletion validation.
