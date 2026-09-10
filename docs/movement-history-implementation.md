# Movement history implementation

Implemented locally on 2026-09-09 from the [approved interview and sidebar design](movement-history-design-interview.md). This document records the implemented contract and local measurements, not a deployment or production capacity guarantee.

## Capture and ownership

Core captures only explicitly supplied latitude/longitude pairs, speed and altitude from Asset/Track create, update and check-in requests. Missing quantities remain absent. A latitude-only patch may update current telemetry but does not manufacture a historical position. Battery, heading, heartbeat and status alone create no sample. Repeated positions explicitly reported by a source are retained, including stationary reports and numeric zero.

Requests may supply `movement_observed_at` for the movement values in that request. Core records its own arrival time before decoding the HTTP body. Without observation time, the sample uses arrival time and exposes `time_is_arrival: true`. Source times more than five minutes ahead of arrival are rejected; times are normalized to PostgreSQL microsecond precision. Altitude is meters above mean sea level. Source adapters must convert other vertical references; history cannot infer them.

Migration v10 adds `entity_movement_samples` with typed nullable columns, an insertion sequence, sample-ID uniqueness, and indexes for association/time, association/sequence, retention and quantity predecessor reads. An association is the existing Entity ID plus its creation timestamp. Samples may predate creation, but imports must explicitly name the current association. Delete/recreate does not inherit old samples. No identity, reconnect or Track-identification policy is added.

Current Entity writes capture samples in their existing transaction. Imports acquire the same Entity row lock and allocate sequences only afterward. They never modify the Entity, heartbeat, resource version or feed clock. This ordering makes the committed per-Entity sequence a usable pagination boundary. Concurrent current writes and imports are covered by a PostgreSQL test that observes both blocked writers before releasing the row lock.

Retention is 30 days from observation time, or arrival time when unknown. All reads enforce it. The existing dispatcher physically removes up to 10,000 expired rows at most once every 30 seconds. Production migration and backups preserve the table; development scratch reset clears it. Expired samples are not restored on retry.

## API and SDK

All routes use Core's existing authenticated Entity route group. History reads require the selected Entity's `entity_created_at`.

| Method and path | Inputs and result |
| --- | --- |
| `POST /entities/{id}/movement-history` | `MovementHistoryBatchRequest`: association and 1–500 sparse samples, each with stable `sample_id`, optional `observed_at` and at least one movement quantity. Body capped at 256 KiB. Returns inserted, duplicate and expired counts. |
| `GET /entities/{id}/movement-history` | `entity_created_at`, `from`, `to`, optional `cursor` and `limit` (default 100, maximum 500). Returns descending original reports, fixed interval, retention cutoff, snapshot sequence and optional continuation. |
| `GET /entities/{id}/trail` | Association, `from`, `to`, optional `max_points` (default 1,000; 2–5,000). Returns the whole interval's reduced position reports, raw position count, reduction flag and `gap_before` flags. |
| `GET /entities/{id}/movement-history/at` | Association and `at`. Returns the latest retained position, speed and altitude reports at or before that time, independently. An unavailable quantity is absent. |

Ranges must be ordered and span at most 30 days. Eligible samples in mixed-age imports are committed atomically; expired samples are counted and skipped. A repeated sample ID with the same normalized time and quantities is a duplicate, preserving the first arrival time. A conflicting reuse returns 409 and rolls back the eligible batch. Malformed requests return 400. A replaced association returns 412. A missing current Entity returns 404.

Raw continuation binds the association, exact range, last time/sequence key, original retention cutoff and committed upper sequence. Backfill committed later appears on refresh, not halfway through that pagination. Retention advancing into the interval sets `retention_advanced` and updates `retained_from`, which the sidebar reports explicitly. Pagination can continue through still-retained reports; a cursor whose last report has expired returns `CURSOR_EXPIRED`. This prevents a 30-day interval from becoming unpageable immediately as its oldest boundary advances. Separate raw, trail and inspection requests each use their own database snapshot; the API does not claim one shared snapshot across these requests.

Trail reduction streams position reports in timestamp order, retaining the first report in each time bucket, the final endpoint, and both endpoints of every gap strictly greater than 60 seconds in the original reports. Speed/altitude-only reports do not bridge a gap. Reduced vertices are actual reports, although turns within a time bucket may be omitted. No synthetic position is exposed for point inspection. Query work is capped at 3,000,000 position rows, an eight-second SQL statement timeout and a ten-second read context. Exceeding the row/point budget rejects the requested interval instead of returning a misleading partial trail. Timeouts also fail the request; the sidebar keeps any previous result and offers retry. Shorter intervals retain more detail.

The SDK exposes `client.entities.history`, `.trail`, `.inspectMovement`, and `.importMovement`. They use normal authentication, response validation and cancellation while leaving live synchronization state untouched. `checkIn` accepts `movementObservedAt`; create/update use the Protocol's `movement_observed_at` field.

```ts
const entity = await client.entities.get("survey-rover");
if (!entity) throw new Error("Entity not found");
const controller = new AbortController();
const query = {
  entityCreatedAt: entity.metadata.created_at,
  from: new Date(Date.now() - 3_600_000).toISOString(),
  to: new Date().toISOString(),
  signal: controller.signal
};
const trail = await client.entities.trail(entity.entity_id, query);
const reports = await client.entities.history(entity.entity_id, query);
await client.entities.importMovement(entity.entity_id, {
  entity_created_at: entity.metadata.created_at,
  samples: [{
    sample_id: "source-report-42",
    observed_at: query.from,
    latitude: 42.3,
    longitude: -71.8,
    speed_m_s: 0,
    altitude_m: 120
  }]
});
```

The Meshtastic Link adapters include all four movement operations to preserve SDK parity. History responses never enter the live Shared Picture. Existing Link message limits still apply; Gateway applications choose bounded pages and point budgets.

## Command behavior

Movement History sits immediately after Location & Movement in the existing Asset/Track sidebar. It uses Section, FieldGrid and existing controls. Opening starts with the last hour; presets and a custom UTC interval cover retained history. The last-hour view refreshes five seconds after the preceding request completes. The 24-hour, 30-day and custom intervals are fixed snapshots refreshed explicitly, avoiding repeated month-long scans. Pinning a report stops automatic refresh. Raw reports and inspection remain available if the trail fails or exceeds its point budget. Following keeps the last complete report and its readings together while the next inspection loads. Explicit Refresh discovers backfill without requiring a live feed event. Return to recent resumes following the last hour.

Hovering a reported trail point previews its readings; clicking pins them. The current Entity marker takes priority over overlapping history points. Reports remain accessible through the sidebar dropdown and raw-page controls. Left/right steps reports only in focused report controls. Escape dismisses pinned detail before clearing the Entity, preserving tool/dialog ownership. Closing the sidebar or selecting another Entity cancels obsolete requests and clears its overlay. Historical data never replaces current Entity data.

Historical quantities use their own original reports. An age cue appears only when a quantity is more than 60 seconds older than the inspected time, with exact times under Report times. Dotted map connectors show missing position information between known endpoints; they are not a measured route. Dateline connectors split at ±180°.

## Local capacity measurement

A disposable, loopback PostgreSQL 17 Docker container was seeded with 2,592,000 one-second position/speed/altitude rows for one Entity. The database included the complete v10 index set. SQL bulk fixture insertion took 84.4 seconds; this is not the authenticated ingestion throughput. Trail queries ran after `ANALYZE`, with a 1,000-point budget:

| Interval | Position rows read | Points returned | Elapsed |
| --- | ---: | ---: | ---: |
| One hour | 3,601 | 501 | 28.9 ms |
| One day | 86,401 | 501 | 220 ms |
| Thirty days | 2,591,915 | 501 | 4.15 s |

Some oldest rows expired while the fixture was being inserted. Table storage was 348,225,536 bytes; indexes used 1,764,270,080 bytes, about 2.11 GB combined. This is roughly 815 bytes per report for this fixture, including all indexes. Twenty-five continuously reporting Entities at one hertz would therefore be on the order of 53 GB before operational headroom, WAL, backups and different ID/data sizes. That extrapolation is not a 25-Entity soak test.

These are single-machine measurements with a warm database, one reader and no concurrent production workload. They support starting with the direct indexed implementation; they do not establish sustained write/read/pruning capacity at the full system envelope. A future summary table or changed physical storage can sit behind the same API without replacing the raw facts or changing Entity identity. Benchmark sustained mixed workload and cleanup before sizing a deployment at the upper envelope.

## Validation

Focused tests cover sparse capture and zero values, backfill before creation, eligible/expired batches, duplicate/conflicting IDs, rollback, association replacement, live-clock isolation, stable pagination, concurrent writers, retained predecessors, pruning and exact gap thresholds. HTTP tests exercise all four routes and request/association rejection. SDK tests cover authenticated transport, cancellation, sparse values, response validation and cache isolation. Command tests cover following versus pinning, cancellation after Entity replacement, hover preview, historical age boundaries, focused keyboard stepping, marker priority, Escape, dateline geometry and style reload.

The in-app browser also exercised the actual inspector, map and history hook against a disposable Core/PostgreSQL fixture through the SDK: history opened inside the existing sidebar, a historical report remained pinned while the current marker and current readings changed, the trail and dotted gap rendered, report stepping and Escape worked, and Return to recent restored following. This used a temporary local harness, not a deployed application or a substitute static mock.

The measured feature build adds roughly 20 kB raw JavaScript to the previous bundle envelope, including generated SDK validators, sidebar controls and map layers. The bundle checker retains separate limits and gives these measured additions a small allowance; the MapLibre, worker and symbol-runtime limits are unchanged.

Final local checks passed: Protocol generation/conformance, Go tests, vet and lint; Core race-enabled tests against PostgreSQL, coverage floors, vet, lint and unreachable-code check; SDK 473 Node tests and 473 Chromium tests, coverage floors, type tests, lint, format, build, public entrypoints and packed-consumer check; Command 669 tests with coverage floors, typecheck, lint, format, production build and bundle budgets. Focused history tests were repeated after the retention-boundary fix. Documentation links and `git diff --check` passed.

The first parallel full Core race run hit the existing plugin-discovery test's one-second readiness timeout. That test passed three focused repeats and the subsequent complete race/coverage run. No plugin behavior was changed. All temporary implementation harness files and the disposable PostgreSQL container were removed after validation.

### Review hardening

Protocol validators enforce at least one movement quantity and require paired coordinates, matching Core. History-page and trail SDK queries expose and serialize only their own pagination controls. Incomplete cursors are rejected instead of inheriting missing fields from the request. PostgreSQL trail statement timeouts return a query-budget validation error that asks for a shorter interval. Movement cleanup runs after feed delivery, records every attempt, and logs failures without disconnecting the feed listener; each attempt is bounded to five seconds. Map style-failure recovery restores the historical overlay along with the other overlays.

SDK response checks also enforce import count totals and descending, in-window history samples. Timestamp comparisons follow Core's nanosecond normalization while preserving precision below milliseconds. Equivalent dateline endpoints remain finite. Failed trail refreshes keep the last successful trail, completed hover inspections cannot become the following-mode fallback, and the movement cleanup throttle survives listener reconnects.

Fixed-interval raw pagination reuses the existing trail request and result; only a new interval or explicit refresh starts another trail scan. The sidebar labels intervals limited by retention on their first page, and camera movement clears hover previews. FieldLink check-ins carry `movement_observed_at`. Movement timestamp parsing accepts the Protocol's lowercase notation and folds leap seconds onto the following second, matching Go/PostgreSQL storage; SDK and Radio comparisons use the same normalization. Generated movement input types preserve quantity and coordinate-pair constraints.
