# Audit 18: pre-auth connection badge pointer interception was not reproduced

1. **Time & Date:** 2026-07-30T18:00:00-07:00
2. **Original Audit Number:** 18
3. **Validation Status:** Not reproduced against `main` at `2426bb6`.
4. **Name:** Pre-auth connection badge pointer interception was not reproduced
5. **Affected Surface & Severity:** Command-interface pre-auth `Core unavailable` screen at desktop and mobile sizes; **S5 (Note)** because the reported pointer failure does not occur on current main.
6. **Issue:** The audit hypothesized that the centered error panel intercepts pointer input intended for the connection badge. Real Chromium hit-testing and pointer clicks at six viewport sizes disproved the claim on the audited commit.
7. **Current vs Expected:**
   - **Current:** `AuthGate` renders `ConnectionBadge` and then a centered `login-panel`, and CSS assigns both direct children to the same grid area. Despite that superficially suspicious structure, the absolutely positioned badge with `z-index: 30` remains above and outside the centered panel. Browser hit-testing resolves to the badge, and real pointer clicks open it at all tested viewports.
   - **Expected:** The visible connection-error badge and its detail/retry dialog are pointer- and keyboard-accessible at supported desktop and mobile viewports, with no overlapping panel receiving the click.
8. **Concrete Source Evidence:** `atlas_command_interface/src/auth/ui/AuthGate.tsx:70-90` renders the badge before the panel. `atlas_command_interface/src/ui/styles/layout.css:39-62` centers the grid and assigns `.connection-badge__anchor` and `.login-panel` to `grid-area: 1 / 1`. Crucially, `atlas_command_interface/src/ui/styles/map.css:42-68` absolutely positions the badge at 12 px from the top/left, gives it `z-index: 30`, and enables pointer events on the button. `ConnectionBadge.tsx:97-185` confirms the trigger opens the detail dialog. Existing `AuthGate.test.tsx:91-108,145-163` also protects the keyboard/focus path.
9. **Reproduction / Static Proof:**
   1. A clean same-SHA checkout at `2426bb66c59466f142f101500f85016b9d6f76d4` was served with Vite and exercised in headless Chromium. The dependency-runtime worktree was used because this documentation worktree intentionally had no `node_modules`; application source was identical.
   2. Viewports tested: `1280x800`, `390x844`, `844x390`, `320x568`, `568x320`, and `320x240`.
   3. At every viewport, the visible button bounding box was approximately `x=12, y=12, width=155.95, height=23`; the centered panel did not overlap it.
   4. `document.elementFromPoint` at the button center hit the button's child span, and a real `page.mouse.click` changed `aria-expanded` to `true` at every viewport. Keyboard Enter also opened it.
10. **Root Cause:** None on current main. The audit likely inferred interception from the shared grid cell and DOM order without accounting for the badge's actual absolute position, z-index, and browser hit-testing.
11. **Simplest Correct Proposed Solution:** Close/remove this finding. Do not add stacking or pointer-event CSS for a failure that current browser evidence disproves.
12. **Acceptance Criteria / Regression-Test Plan:**
   - No runtime change is accepted for this audit item.
   - If a future regression is reported, reproduce it with real `elementFromPoint` and pointer clicks at desktop/mobile/landscape sizes before editing CSS.
   - Existing keyboard focus/Enter/Escape tests remain green.
13. **Scope / Non-Goals:** No login-shell redesign, responsive design overhaul, or change to authenticated map badge placement. This conclusion is based on real Chromium input, not jsdom dispatch.
14. **Overlaps:** Finding 5 covers sanitization of the detail text shown here. No other finding owns this pointer/stacking behavior.
