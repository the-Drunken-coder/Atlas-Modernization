1. **Time & Date:** 2026-09-07T20:51:16Z
2. **Name:** Core serializers repeatedly copy the same JSON document
3. **Issue:** Resource serialization calls several model accessors that each deep-copy the entire decoded JSON document. The cache avoids repeated decoding but does not avoid repeated whole-document copying within one serialization.
4. **Severity:** S5 (Note)
5. **Location:** `services/core/internal/models/models.go:79-112`, `150-172`, and `223-296`; `services/core/internal/serializers/serializers.go:28-51` and `113-195`.
6. **Expected:** One serialization reads the stored document once, with at most one defensive whole-document copy, while preserving numeric precision, cache invalidation, and isolation from mutations through returned data.
7. **Actual:** Full object serialization calls `GetUsageHints`, `GetExtra`, `GetSizeBytes`, `GetReferencedBy`, and `GetBucket`. Each calls the cache accessor and copies its complete document. A disposable coverage-count probe of one full serialization measured one cold-cache copy and four cache-hit copies. Source tracing also shows three copies for object lists, four for object feed resources, and two for entities with valid JSON.
8. **Reproduction:**
   1. Follow the five getter calls in `serializers.go:113-142` into `models.go`. Both successful branches of `jsonBlobCache.decoded` return `deepCopyMap(c.data)`.
   2. To repeat the execution, create a disposable `serializers_test` overlay test that constructs one `models.MediaObject` with JSON `{"size_bytes":7,"usage_hints":["inspection"],"bucket":"review-only","referenced_by":[{"entity_id":"review-asset"}],"extension":{"nested":[1,2,3]}}` and invokes `serializers.SerializeObject` exactly once.
   3. From `services/core`, run that test alone with `go test -overlay=<overlay.json> -count=1 -covermode=count -coverpkg=./internal/models -coverprofile=<coverage.out> -run '^TestReviewF16aSingleObjectSerialization$' ./internal/serializers`.
   4. Inspect the coverage counts for `models.go`. The cache-hit return at line 87 executes four times; the initial successful return block at lines 110-112 executes once.
9. **Notes:** Source finding F16a, review section 16, verified at `c62cb735a91c780c1fc8a5820dfe3cebf1656841`. The probe and existing model/serializer race tests passed. This is confirmed redundant work, without a measured application-latency claim. Simply returning the cache's mutable map would remove an existing isolation guarantee; retain that guarantee when consolidating reads. Delete this note when fixed or invalidated.
