# Map reticle interaction is split by mechanical layer rather than by concept

1. **Time & Date:** 2026-07-18T08:29:35-04:00
2. **Name:** Map reticle interaction is split by mechanical layer rather than by concept
3. **Issue:** The Stage 9 split distributed reticle interaction across five files organized by React mechanism (pointer handlers, effects, state, types, composing hook), so understanding one behavior — how the reticle responds to the pointer — requires reading all five.
4. **Severity:** S5 (Note)
5. **Location:** `atlas_command_interface/src/ui/map/use-map-reticle-pointer.ts` (383 lines), `use-map-reticle-effects.ts` (219), `map-reticle-interaction-state.ts` (113), `use-map-reticle-interaction.ts` (52), `map-reticle-interaction-types.ts` (16)
6. **Expected:** Splits follow conceptual seams (e.g. hover targeting vs. drag/placement vs. keyboard) so a behavior change touches one file whose name says what it does.
7. **Actual:** The seams follow React plumbing layers; the 52-line composing hook and 16-line types file exist mainly to wire the others together, and behavior for a single interaction spans the pointer, effects, and state files.
8. **Reproduction:**
   1. Run `wc -l atlas_command_interface/src/ui/map/use-map-reticle-*.ts atlas_command_interface/src/ui/map/map-reticle-interaction-*.ts`
   2. Trace one behavior (e.g. reticle hover-target resolution) and count the files visited
9. **Notes:** Same underlying pattern as the sync-engine seam split ([2026-07-18-sdk-sync-engine-implicit-state-machine.md](2026-07-18-sdk-sync-engine-implicit-state-machine.md)): size-driven extraction that relocates lines without relocating a concept. Not worth a re-refactor on its own — record so the next map interaction change consolidates toward conceptual seams instead of adding a sixth layer file.
