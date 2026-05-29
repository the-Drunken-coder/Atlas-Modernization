# Problem

1. **Time & Date:** 2026-05-29T00:00:00Z
2. **Name:** Model JSON accessors deep-copy the decoded blob on every call
3. **Issue:** `decodedJSON()` on `Entity`, `Task`, and `MediaObject` returns a full `deepCopyMap` of the decoded JSON each time it is called. Serializing a single record calls it through multiple accessors (e.g. `SerializeEntity` → `GetComponents()` *and* `GetExtra()`), so each record is deep-copied at least twice per serialization. Across a list endpoint this multiplies (N records × accessors-per-record deep copies), even though the cache guard avoids re-unmarshalling.
4. **Severity:** S5 (Note) — correctness is fine (the deep copy intentionally prevents aliasing); this is a CPU/allocation cost that only matters under load.
5. **Location:** `Atlas_Core/internal/models/models.go` (`decodedJSON`, `deepCopyMap`, `GetComponents`/`GetExtra`/`GetPayload`/`GetReferencedBy`/etc.), `Atlas_Core/internal/serializers/serializers.go` (`SerializeEntity`/`SerializeTask`/`SerializeObject`)
6. **Expected:** A record's JSON is decoded and copied at most once per serialization; accessors share that work.
7. **Actual:** Every accessor call re-deep-copies the whole map; multi-accessor serialization repeats the copy per field group.
8. **Reproduction:**
   1. Profile (CPU/alloc) `GET /entities?limit=100` against entities with non-trivial `components` + `extra`.
   2. Observe repeated `deepCopyMap` allocations per record.
9. **Notes:** Options: have serializers call `decodedJSON()` once and pass the map to field extractors; or return read-only views and copy only at mutation points; or build the response in a single pass. Keep the anti-aliasing guarantee intact. Related: `Atlas_Core/docs/CPU_RAM_OPTIMIZATIONS.md`, `Atlas_Core/docs/MEMORY_LEAK_FIX.md`.
