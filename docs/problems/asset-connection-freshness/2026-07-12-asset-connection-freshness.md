# Asset Connection State Ignores Heartbeat Freshness

1. **Time & Date:** 2026-07-12T22:15:00-04:00
2. **Name:** Never-seen asset can appear unconditionally connected
3. **Issue:** The command interface presents a self-reported communications flag as current connection truth without qualifying it with heartbeat freshness.
4. **Severity:** S2 (Major)
5. **Location:** `atlas_command_interface/src/atlas/entities.ts`, `atlas_command_interface/src/features/`, `atlas_command_interface/src/ui/`
6. **Expected:** Connection status should distinguish a fresh confirmed asset from a resource that merely contains `components.communications.link_state="connected"`. Missing or stale heartbeat evidence should be visible to the operator.
7. **Actual:** An entity that has never checked in immediately receives a green connected indicator in the asset list and a green `Connected` pill in the inspector, while its heartbeat is displayed as `-`.
8. **Reproduction:**
   1. Create an asset entity with `components.communications.link_state` set to `connected`
   2. Do not send an entity check-in or heartbeat update
   3. Open Assets in the command interface
   4. Select the new entity
   5. Observe the green connected state alongside a missing heartbeat
9. **Notes:** This does not corrupt Core data, but it can materially mislead an operator. A qualified state such as `Reported connected - never checked in` would preserve the reported value without claiming freshness.
