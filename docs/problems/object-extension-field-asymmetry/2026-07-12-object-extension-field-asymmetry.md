# Object Extension Data Changes Names Across the API Boundary

1. **Time & Date:** 2026-07-12T22:15:00-04:00
2. **Name:** Object writes use `extra` while reads expose the same data as `payload`
3. **Issue:** Extension metadata uses a different public field name for objects than for entities and tasks, creating a surprising integration contract for direct API consumers.
4. **Severity:** S5 (Note)
5. **Location:** Atlas Protocol object request/response definitions, `Atlas_Core/internal/serializers/`, `atlas_sdk/src/`
6. **Expected:** Extension metadata should either use a consistent field name across write/read resource shapes or be explicitly highlighted wherever direct API integrations are documented.
7. **Actual:** Object create/update requests accept extension fields under `extra`, while object responses expose them under `payload`. Entity and task integrations round-trip comparable extension data under `extra`.
8. **Reproduction:**
   1. Create an object with a non-empty `extra` field
   2. Fetch the object through the Core API
   3. Observe the extension data under `payload` rather than `extra`
   4. Compare with equivalent entity or task extension metadata
9. **Notes:** The SDK compensates with its object response types, so the tested SDK flow worked. The asymmetry primarily affects curl users, non-TypeScript clients, and new integration authors.
