1. **Time & Date:** 2026-08-12T22:55:06-04:00
2. **Name:** Command interface copy uses prohibited em dashes
3. **Issue:** Inspector placeholders, formatting helpers, and status descriptions use user-visible em dashes despite the machine-wide visual constraint prohibiting them.
4. **Severity:** S4 (Minor)
5. **Location:** Atlas Command Interface under `atlas_command_interface/src/features/`, `atlas_command_interface/src/atlas/format.ts`, and `atlas_command_interface/src/ui/primitives/StatusPill.tsx`
6. **Expected:** Missing inspector values use the selected compact label `N/A`; prose uses ordinary punctuation with the same meaning and no em dash.
7. **Actual:** Missing-value placeholders and inline status prose display em dashes.
8. **Reproduction:**
   1. Open an asset or track whose optional state, connection, battery, position, or timestamp is absent
   2. Inspect the unavailable field values and status descriptions
9. **Notes:** The replacement copy is selected. Before editing production UI, create three distinct static text mocks showing its presentation in dense inspector rows and status descriptions, present them through the visualization workflow, and stop until the developer selects a mock. Update copy assertions and formatting tests after selection.
