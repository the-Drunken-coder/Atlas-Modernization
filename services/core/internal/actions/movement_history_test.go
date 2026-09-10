package actions

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	protocol "github.com/the-drunken-coder/atlas/packages/protocol/generated/go/atlasprotocol"
)

func movementPtr[T any](value T) *T { return &value }

func TestMovementValidation(t *testing.T) {
	now := time.Now().UTC()
	for _, sample := range []protocol.MovementSampleInput{
		{SampleID: strings.Repeat("é", 129), SpeedMS: movementPtr(0.0)},
		{SampleID: "missing"}, {SampleID: "half", Latitude: movementPtr(1.0)},
		{SampleID: "negative", SpeedMS: movementPtr(-1.0)}, {SampleID: "nan", AltitudeM: movementPtr(math.NaN())},
		{SampleID: "future", SpeedMS: movementPtr(0.0), ObservedAt: movementPtr(movementTime(now.Add(6 * time.Minute)))},
	} {
		if _, _, err := validateMovement(sample, now); err == nil {
			t.Errorf("accepted invalid sample %s", sample.SampleID)
		}
	}
	if observed, at, err := validateMovement(protocol.MovementSampleInput{SampleID: strings.Repeat("é", 128), SpeedMS: movementPtr(0.0)}, now); err != nil || observed != nil || !at.Equal(now) {
		t.Fatalf("arrival fallback: %v %v %v", observed, at, err)
	}
}

func TestMovementCaptureBackfillAndAssociation(t *testing.T) {
	pool := openActionsTestPool(t)
	ctx := context.Background()
	a := NewEntityActions(pool)
	id := fmt.Sprintf("movement-%d", time.Now().UnixNano())
	now := time.Now().UTC().Truncate(time.Microsecond)
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM entity_movement_samples WHERE entity_id=$1`, id)
		_, _ = pool.Exec(ctx, `DELETE FROM entities WHERE entity_id=$1`, id)
	})
	entity, err := a.Create(ctx, CreateEntityParams{EntityID: id, EntityType: "track", Components: map[string]interface{}{"telemetry": map[string]interface{}{"latitude": 0.0, "longitude": 0.0, "speed_m_s": 0.0}}, MovementObservedAt: movementPtr(movementTime(now.Add(-time.Minute)))})
	if err != nil {
		t.Fatal(err)
	}
	q := MovementQuery{EntityCreatedAt: entity.CreatedAt, From: now.Add(-24 * time.Hour), To: now.Add(time.Second), Limit: 1, MaxPoints: 100}
	page, err := a.MovementHistory(ctx, id, q)
	if err != nil || len(page.Samples) != 1 || page.Samples[0].Latitude == nil || *page.Samples[0].Latitude != 0 {
		t.Fatalf("capture zero: %+v %v", page, err)
	}
	oldID := page.Samples[0].SampleID
	_, err = a.Update(ctx, id, UpdateEntityParams{Components: map[string]interface{}{"telemetry": map[string]interface{}{"heading_deg": 90.0}, "heartbeat": map[string]interface{}{"last_seen": movementTime(now)}}})
	if err != nil {
		t.Fatal(err)
	}
	page, err = a.MovementHistory(ctx, id, q)
	if err != nil || len(page.Samples) != 1 || page.Samples[0].SampleID != oldID {
		t.Fatalf("nonmovement created sample: %+v %v", page, err)
	}
	_, err = a.Update(ctx, id, UpdateEntityParams{Components: map[string]interface{}{"telemetry": map[string]interface{}{"speed_m_s": 2.0}}})
	if err != nil {
		t.Fatal(err)
	}
	page, err = a.MovementHistory(ctx, id, q)
	if err != nil || page.Samples[0].Latitude != nil || page.NextCursor == "" {
		t.Fatalf("sparse capture: %+v %v", page, err)
	}
	for _, missing := range []string{"entity", "created", "from", "to", "retained_from", "after_time", "after_sequence", "upper"} {
		raw, _ := base64.RawURLEncoding.DecodeString(page.NextCursor)
		var fields map[string]any
		_ = json.Unmarshal(raw, &fields)
		if _, ok := fields[missing]; !ok {
			t.Fatalf("cursor did not contain %s", missing)
		}
		delete(fields, missing)
		malformed, _ := json.Marshal(fields)
		invalid := q
		invalid.Cursor = base64.RawURLEncoding.EncodeToString(malformed)
		if _, err := a.MovementHistory(ctx, id, invalid); err == nil {
			t.Fatalf("accepted cursor missing %s", missing)
		}
	}
	cursor := page.NextCursor
	// A full-retention window remains pageable when the cutoff advances, while
	// exposing the changed retention boundary instead of silently claiming coverage.
	monthQuery := q
	monthQuery.To = time.Now().UTC()
	monthQuery.From = monthQuery.To.Add(-MovementRetention)
	monthPage, err := a.MovementHistory(ctx, id, monthQuery)
	if err != nil {
		t.Fatal(err)
	}
	monthQuery.Cursor = monthPage.NextCursor
	monthNext, err := a.MovementHistory(ctx, id, monthQuery)
	if err != nil || len(monthNext.Samples) != 1 || !monthNext.RetentionAdvanced {
		t.Fatalf("retention boundary pagination: %+v %v", monthNext, err)
	}
	expiredQuery := MovementQuery{EntityCreatedAt: entity.CreatedAt, From: now.Add(-31 * 24 * time.Hour), To: now.Add(-24 * time.Hour)}
	expiredCursor, _ := json.Marshal(movementCursor{EntityID: id, Created: entity.CreatedAt, From: expiredQuery.From, To: expiredQuery.To, RetainedFrom: now.Add(-32 * 24 * time.Hour), Upper: 2, AfterSequence: 1, AfterTime: now.Add(-MovementRetention - time.Second)})
	expiredQuery.Cursor = base64.RawURLEncoding.EncodeToString(expiredCursor)
	_, err = a.MovementHistory(ctx, id, expiredQuery)
	var expiredError *CursorExpiredError
	if !errors.As(err, &expiredError) {
		t.Fatalf("expired cursor: %v", err)
	}
	before, _ := a.Get(ctx, id)
	var versionBefore int64
	_ = pool.QueryRow(ctx, `SELECT version FROM atlas_change_clock`).Scan(&versionBefore)
	batch := protocol.MovementHistoryBatchRequest{EntityCreatedAt: movementTime(entity.CreatedAt), Samples: []protocol.MovementSampleInput{
		{SampleID: "earlier", ObservedAt: movementPtr(movementTime(now.Add(-2 * time.Hour))), Latitude: movementPtr(1.0), Longitude: movementPtr(1.0)},
		{SampleID: "expired", ObservedAt: movementPtr(movementTime(now.Add(-31 * 24 * time.Hour))), SpeedMS: movementPtr(1.0)},
	}}
	result, err := a.ImportMovement(ctx, id, batch, now)
	if err != nil || result.Inserted != 1 || result.Expired != 1 {
		t.Fatalf("import: %+v %v", result, err)
	}
	result, err = a.ImportMovement(ctx, id, batch, now.Add(time.Second))
	if err != nil || result.Duplicates != 1 {
		t.Fatalf("retry: %+v %v", result, err)
	}
	after, _ := a.Get(ctx, id)
	var versionAfter int64
	_ = pool.QueryRow(ctx, `SELECT version FROM atlas_change_clock`).Scan(&versionAfter)
	if before.Version != after.Version || string(before.JSON) != string(after.JSON) || versionBefore != versionAfter {
		t.Fatal("backfill changed current Entity or feed clock")
	}
	q.Cursor = cursor
	next, err := a.MovementHistory(ctx, id, q)
	if err != nil || len(next.Samples) != 1 || next.Samples[0].SampleID != oldID || next.NextCursor != "" {
		t.Fatalf("snapshot changed under backfill: %+v %v", next, err)
	}
	inspection, err := a.InspectMovement(ctx, id, entity.CreatedAt, now.Add(-90*time.Minute))
	if err != nil || inspection.Position == nil || inspection.Position.SampleID != "earlier" || inspection.Speed != nil {
		t.Fatalf("historical predecessor: %+v %v", inspection, err)
	}
	batch.Samples = []protocol.MovementSampleInput{{SampleID: "rollback", SpeedMS: movementPtr(4.0)}, {SampleID: "earlier", SpeedMS: movementPtr(8.0)}}
	if _, err = a.ImportMovement(ctx, id, batch, now); err == nil {
		t.Fatal("conflicting ID accepted")
	}
	var count int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM entity_movement_samples WHERE entity_id=$1 AND sample_id='rollback'`, id).Scan(&count)
	if count != 0 {
		t.Fatal("conflict did not roll back batch")
	}
	if err = a.Delete(ctx, id); err != nil {
		t.Fatal(err)
	}
	replacement, err := a.Create(ctx, CreateEntityParams{EntityID: id, EntityType: "track"})
	if err != nil {
		t.Fatal(err)
	}
	q.Cursor = ""
	q.EntityCreatedAt = replacement.CreatedAt
	page, err = a.MovementHistory(ctx, id, q)
	if err != nil || len(page.Samples) != 0 {
		t.Fatalf("replacement inherited old history: %+v %v", page, err)
	}
	_, err = a.ImportMovement(ctx, id, batch, now)
	var precondition *PreconditionFailedError
	if !errors.As(err, &precondition) {
		t.Fatalf("stale association accepted: %v", err)
	}
}

func TestMovementTrailGapsAndRetention(t *testing.T) {
	pool := openActionsTestPool(t)
	ctx := context.Background()
	a := NewEntityActions(pool)
	id := fmt.Sprintf("trail-%d", time.Now().UnixNano())
	now := time.Now().UTC().Truncate(time.Microsecond)
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM entity_movement_samples WHERE entity_id=$1`, id)
		_, _ = pool.Exec(ctx, `DELETE FROM entities WHERE entity_id=$1`, id)
	})
	entity, err := a.Create(ctx, CreateEntityParams{EntityID: id, EntityType: "asset"})
	if err != nil {
		t.Fatal(err)
	}
	batch := protocol.MovementHistoryBatchRequest{EntityCreatedAt: movementTime(entity.CreatedAt)}
	for i, seconds := range []int{-240, -180, -119, -118} {
		batch.Samples = append(batch.Samples, protocol.MovementSampleInput{SampleID: fmt.Sprint(i), ObservedAt: movementPtr(movementTime(now.Add(time.Duration(seconds) * time.Second))), Latitude: movementPtr(float64(i)), Longitude: movementPtr(179.0)})
	}
	if _, err = a.ImportMovement(ctx, id, batch, now); err != nil {
		t.Fatal(err)
	}
	q := MovementQuery{EntityCreatedAt: entity.CreatedAt, From: now.Add(-time.Hour), To: now, MaxPoints: 10}
	trail, err := a.MovementTrail(ctx, id, q)
	if err != nil {
		t.Fatal(err)
	}
	if trail.PositionCount != 4 || len(trail.Points) != 4 || trail.Points[1].GapBefore || !trail.Points[2].GapBefore {
		t.Fatalf("gap boundaries lost: %+v", trail)
	}
	q.MaxPoints = 2
	if _, err = a.MovementTrail(ctx, id, q); err == nil {
		t.Fatal("silently hid gap to fit budget")
	}
	_, err = pool.Exec(ctx, `UPDATE entity_movement_samples SET observed_at=$2,sample_time=$2 WHERE entity_id=$1`, id, now.Add(-31*24*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if err = a.PruneMovement(ctx); err != nil {
		t.Fatal(err)
	}
	var count int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM entity_movement_samples WHERE entity_id=$1`, id).Scan(&count)
	if count != 0 {
		t.Fatal("expired samples remain")
	}
}

// A committed per-Entity sequence is safe only when all writers acquire the
// same row lock before allocating their samples, including history-only imports.
func TestMovementConcurrentWritersAndSnapshot(t *testing.T) {
	pool := openActionsTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	a := NewEntityActions(pool)
	id := fmt.Sprintf("movement-lock-%d", time.Now().UnixNano())
	now := time.Now().UTC().Truncate(time.Microsecond)
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM entity_movement_samples WHERE entity_id=$1`, id)
		_, _ = pool.Exec(context.Background(), `DELETE FROM entities WHERE entity_id=$1`, id)
	})
	e, err := a.Create(ctx, CreateEntityParams{EntityID: id, EntityType: "track"})
	if err != nil {
		t.Fatal(err)
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	locked, err := movementEntity(ctx, tx, id, e.CreatedAt, true)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = insertMovement(ctx, tx, locked, protocol.MovementSampleInput{SampleID: "uncommitted", SpeedMS: movementPtr(1.0)}, now); err != nil {
		t.Fatal(err)
	}
	writerConfig := pool.Config().Copy()
	writerConfig.ConnConfig.RuntimeParams["application_name"] = id
	writers, err := pgxpool.NewWithConfig(ctx, writerConfig)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(writers.Close)
	writerActions := NewEntityActions(writers)
	done := make(chan error, 2)
	go func() {
		_, err := writerActions.ImportMovement(ctx, id, protocol.MovementHistoryBatchRequest{EntityCreatedAt: movementTime(e.CreatedAt), Samples: []protocol.MovementSampleInput{{SampleID: "waiting-import", SpeedMS: movementPtr(2.0)}}}, now)
		done <- err
	}()
	go func() {
		_, err := writerActions.Update(ctx, id, UpdateEntityParams{Components: map[string]interface{}{"telemetry": map[string]interface{}{"speed_m_s": 3.0}}})
		done <- err
	}()
	// Wait until PostgreSQL observes both writers waiting, rather than using
	// elapsed time as evidence that they respected the lock.
	for {
		var waiting int
		err = pool.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND application_name=$1`, id).Scan(&waiting)
		if err != nil {
			t.Fatal(err)
		}
		if waiting >= 2 {
			break
		}
		select {
		case err := <-done:
			t.Fatalf("writer bypassed row lock: %v", err)
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-time.After(5 * time.Millisecond):
		}
	}
	q := MovementQuery{EntityCreatedAt: e.CreatedAt, From: now.Add(-time.Hour), To: now.Add(time.Minute), Limit: 1}
	before, err := a.MovementHistory(ctx, id, q)
	if err != nil || len(before.Samples) != 0 {
		t.Fatalf("read uncommitted samples: %+v %v", before, err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err = <-done; err != nil {
			t.Fatal(err)
		}
	}
	seen := map[string]bool{}
	snapshot := ""
	for {
		page, err := a.MovementHistory(ctx, id, q)
		if err != nil {
			t.Fatal(err)
		}
		if snapshot != "" && snapshot != page.Snapshot {
			t.Fatal("snapshot changed")
		}
		snapshot = page.Snapshot
		for _, sample := range page.Samples {
			if seen[sample.SampleID] {
				t.Fatal("duplicate page sample")
			}
			seen[sample.SampleID] = true
		}
		if page.NextCursor == "" {
			break
		}
		q.Cursor = page.NextCursor
	}
	if len(seen) != 3 {
		t.Fatalf("missing concurrent samples: %v", seen)
	}
}

func TestMovementTrailErrorMapping(t *testing.T) {
	var validation *ValidationError
	if !errors.As(movementTrailError(fmt.Errorf("query: %w", &pgconn.PgError{Code: "57014"})), &validation) {
		t.Fatal("statement timeout did not explain the query budget")
	}
	original := errors.New("storage unavailable")
	if !errors.Is(movementTrailError(original), original) {
		t.Fatal("changed a non-timeout error")
	}
}
