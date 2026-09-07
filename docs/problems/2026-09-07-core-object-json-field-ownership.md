1. **Time & Date:** 2026-09-07T20:51:16Z
2. **Name:** Core duplicates object JSON field classification
3. **Issue:** The classification of eight Core-owned object JSON keys is manually maintained in both write-side extra filtering and read-side extra filtering. Changing that classification requires coordinating separate field lists.
4. **Severity:** S5 (Note)
5. **Location:** `services/core/internal/actions/json_blob_contracts.go:23-30`, `51-60`, and `116-130`; `services/core/internal/actions/object_json_contracts.go:10-27`; `services/core/internal/models/models.go:273-278`.
6. **Expected:** The common classification of Core-owned object blob fields has one maintenance point. Read serialization can retain its additional metadata exclusions, and write filtering must continue protecting storage-owned fields.
7. **Actual:** `objectPromotedBlobFields` declares `path`, `content_type`, `type`, `size_bytes`, `usage_hints`, `bucket`, `referenced_by`, and `version`. `MediaObject.GetExtra` repeats those same eight keys as string literals. Its three additional exclusions are `object_id`, `created_at`, and `updated_at`, so the complete read and write lists are not interchangeable.
8. **Reproduction:**
   1. Inspect the object field constants and `objectPromotedBlobFields` in `json_blob_contracts.go:23-60`.
   2. Compare their string values with the exclusions in `MediaObject.GetExtra` at `models.go:273-278`. Their intersection contains the eight keys listed above.
   3. Trace `mergeBlobExtraFields` and `removeBlobExtraKeys` to confirm the action list governs writes, then trace `SerializeObject` to `GetExtra` to confirm the second list governs reads. No shared declaration connects the two classifications.
   4. From `services/core`, run `go test -race -count=1 -run '^TestObjectJSONPatchReplacesSelectedExtraFields$' ./internal/actions` and `go test -race -count=1 ./internal/models ./internal/serializers`.
9. **Notes:** Source finding F16b, review sections 5 and 16, verified at `c62cb735a91c780c1fc8a5820dfe3cebf1656841`. Source comparison confirmed the eight-key overlap; the focused action test and model/serializer race tests passed. This is maintenance duplication with no demonstrated current field leak or data corruption. It is separate from F16a's repeated copying and from the broader proposal to redesign metadata types. Avoid introducing a generalized field registry or changing the distinct read/write policies merely to deduplicate this list. Delete this note when fixed or invalidated.
