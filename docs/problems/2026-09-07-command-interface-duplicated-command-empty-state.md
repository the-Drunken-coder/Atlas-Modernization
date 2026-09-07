# Asset and command panels duplicate empty-state policy

1. **Time & Date:** 2026-09-07T08:15:44Z
2. **Name:** Asset and command panels duplicate empty-state policy
3. **Issue:** The asset inspector and command-list workspace separately own the same six-branch command empty-state decision and wording.
4. **Severity:** S5 (Note)
5. **Location:** `surfaces/command-interface/src/features/assets/AssetInspector.tsx:58-68` and `surfaces/command-interface/src/features/MapConsole.tsx:808-819`.
6. **Expected:** The shared command availability explanation has one maintenance point, while each panel retains its intended targeting filter and layout.
7. **Actual:** Both locations independently check missing catalog, empty catalog, loading manifest, unavailable manifest, empty manifest, and missing operator inputs, with the same messages in the same order. Source comparison found identical expressions after normalizing the selected-entity variable name and whitespace. Executing the extracted expressions for all six branches returned equal output pairs.
8. **Reproduction:**
   1. Run `sed -n '58,68p' surfaces/command-interface/src/features/assets/AssetInspector.tsx` and `sed -n '808,819p' surfaces/command-interface/src/features/MapConsole.tsx`.
   2. Compare the conditional expressions, treating `entity` and `selectedEntity` as the same input. The predicates, precedence, and all six messages are duplicated.
   3. Exercise missing catalog, empty catalog, loading, unavailable, ready with no manifest entries, and ready with manifest entries but no registered input. Both expressions return the same explanation in each case.
9. **Notes:** Source finding F19, from the writing and conventions discussion. Verified at `c62cb735a91c780c1fc8a5820dfe3cebf1656841` with a disposable Node evaluation of the exact extracted expressions; existing command and asset-inspector tests passed. This is current maintenance duplication, not currently inconsistent wording. The asset inspector combines map-point and untargeted commands, while the command list requests untargeted commands; sharing an explanation must preserve those distinct filters.
