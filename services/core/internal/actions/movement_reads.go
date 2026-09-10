package actions

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	protocol "github.com/the-drunken-coder/atlas/packages/protocol/generated/go/atlasprotocol"
)

const movementColumns = `sample_id, observed_at, received_at, sample_time, latitude, longitude, speed_m_s, altitude_m, sequence`
const movementScanBudget = 3000000

type MovementQuery struct {
	EntityCreatedAt time.Time
	From            time.Time
	To              time.Time
	Cursor          string
	Limit           int
	MaxPoints       int
}
type movementCursor struct {
	EntityID      string    `json:"entity"`
	Created       time.Time `json:"created"`
	From          time.Time `json:"from"`
	To            time.Time `json:"to"`
	RetainedFrom  time.Time `json:"retained_from"`
	Upper         int64     `json:"upper"`
	AfterTime     time.Time `json:"after_time"`
	AfterSequence int64     `json:"after_sequence"`
}

func scanMovement(row rowScanner) (protocol.MovementSample, int64, error) {
	var sample protocol.MovementSample
	var observed *time.Time
	var received, t time.Time
	var sequence int64
	err := row.Scan(&sample.SampleID, &observed, &received, &t, &sample.Latitude, &sample.Longitude, &sample.SpeedMS, &sample.AltitudeM, &sequence)
	if err != nil {
		return sample, 0, err
	}
	sample.ReceivedAt = movementTime(received)
	sample.Time = movementTime(t)
	sample.TimeIsArrival = observed == nil
	if observed != nil {
		value := movementTime(*observed)
		sample.ObservedAt = &value
	}
	return sample, sequence, nil
}

func validateMovementRange(q MovementQuery) error {
	if q.EntityCreatedAt.IsZero() || q.From.IsZero() || q.To.IsZero() || q.From.After(q.To) || q.To.Sub(q.From) > MovementRetention || q.To.After(time.Now().Add(movementClockSkew)) {
		return NewValidationError("movement range requires entity_created_at and ordered from/to times spanning at most 30 days")
	}
	return nil
}

func (a *EntityActions) movementReadTx(ctx context.Context, id string, created time.Time) (pgx.Tx, error) {
	tx, err := a.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, err
	}
	if _, err = tx.Exec(ctx, `SET LOCAL statement_timeout = '8s'`); err == nil {
		_, err = movementEntity(ctx, tx, id, created, false)
	}
	if err != nil {
		_ = tx.Rollback(ctx)
		return nil, err
	}
	return tx, nil
}

// MovementHistory returns descending pages stable under late backfill, using one
// committed per-Entity high-water mark and the same time range and association.
func (a *EntityActions) MovementHistory(ctx context.Context, id string, q MovementQuery) (*protocol.MovementHistoryPage, error) {
	id = SanitizeID(id)
	if err := validateMovementRange(q); err != nil {
		return nil, err
	}
	if q.Limit == 0 {
		q.Limit = 100
	}
	if q.Limit < 1 || q.Limit > 500 {
		return nil, NewValidationError("movement limit must be 1 to 500")
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	tx, err := a.movementReadTx(ctx, id, q.EntityCreatedAt)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	cutoff := time.Now().UTC().Add(-MovementRetention)
	var c movementCursor
	if q.Cursor != "" {
		raw, err := base64.RawURLEncoding.DecodeString(q.Cursor)
		if err != nil || len(raw) > 2048 || json.Unmarshal(raw, &c) != nil || c.RetainedFrom.IsZero() || c.AfterTime.IsZero() || c.EntityID != id || !c.Created.Equal(q.EntityCreatedAt) || !c.From.Equal(q.From) || !c.To.Equal(q.To) || c.Upper < 1 || c.AfterSequence < 1 || c.AfterSequence > c.Upper || c.AfterTime.Before(q.From) || c.AfterTime.After(q.To) {
			return nil, NewValidationError("invalid movement cursor")
		}
		if c.AfterTime.Before(cutoff) {
			return nil, &CursorExpiredError{ActionError: ActionError{Message: "Movement history cursor expired; refresh the interval", Code: protocol.ErrorCodeCursorExpired}}
		}
	} else {
		c = movementCursor{EntityID: id, Created: q.EntityCreatedAt, From: q.From, To: q.To, RetainedFrom: cutoff}
		if err := tx.QueryRow(ctx, `SELECT COALESCE((SELECT sequence FROM entity_movement_samples WHERE entity_id=$1 AND entity_created_at=$2 ORDER BY sequence DESC LIMIT 1),0)`, id, q.EntityCreatedAt).Scan(&c.Upper); err != nil {
			return nil, err
		}
	}
	result := &protocol.MovementHistoryPage{EntityCreatedAt: movementTime(q.EntityCreatedAt), From: movementTime(q.From), To: movementTime(q.To), RetainedFrom: movementTime(cutoff), RetentionAdvanced: q.Cursor != "" && q.From.Before(cutoff) && c.RetainedFrom.Before(cutoff), Snapshot: strconv.FormatInt(c.Upper, 10), Samples: []protocol.MovementSample{}}
	sql := `SELECT ` + movementColumns + ` FROM entity_movement_samples WHERE entity_id=$1 AND entity_created_at=$2 AND sample_time >= $3 AND sample_time <= $4 AND sample_time >= $5 AND sequence <= $6`
	args := []any{id, q.EntityCreatedAt, q.From, q.To, cutoff, c.Upper}
	if q.Cursor != "" {
		sql += ` AND (sample_time,sequence)<($7,$8)`
		args = append(args, c.AfterTime, c.AfterSequence)
	}
	args = append(args, q.Limit+1)
	sql += fmt.Sprintf(` ORDER BY sample_time DESC,sequence DESC LIMIT $%d`, len(args))
	rows, err := tx.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		sample, seq, err := scanMovement(rows)
		if err != nil {
			return nil, err
		}
		if len(result.Samples) == q.Limit {
			encoded, _ := json.Marshal(c)
			result.NextCursor = base64.RawURLEncoding.EncodeToString(encoded)
			break
		}
		result.Samples = append(result.Samples, sample)
		c.AfterTime, _ = time.Parse(time.RFC3339Nano, sample.Time)
		c.AfterSequence = seq
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return result, nil
}

func (a *EntityActions) InspectMovement(ctx context.Context, id string, created, at time.Time) (*protocol.MovementInspection, error) {
	id = SanitizeID(id)
	if at.IsZero() || at.After(time.Now().Add(movementClockSkew)) {
		return nil, NewValidationError("inspection time must be a valid historical timestamp")
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	tx, err := a.movementReadTx(ctx, id, created)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	result := &protocol.MovementInspection{EntityCreatedAt: movementTime(created), Time: movementTime(at)}
	cutoff := time.Now().Add(-MovementRetention)
	// Fixed column names match partial indexes; never interpolate request values.
	for _, field := range []struct {
		column string
		target **protocol.MovementSample
	}{{"latitude", &result.Position}, {"speed_m_s", &result.Speed}, {"altitude_m", &result.Altitude}} {
		sample, _, err := scanMovement(tx.QueryRow(ctx, `SELECT `+movementColumns+` FROM entity_movement_samples WHERE entity_id=$1 AND entity_created_at=$2 AND sample_time >= $3 AND sample_time <= $4 AND `+field.column+` IS NOT NULL ORDER BY sample_time DESC,sequence DESC LIMIT 1`, id, created, cutoff, at))
		if errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			return nil, err
		}
		*field.target = &sample
	}
	return result, nil
}

// MovementTrail caps the scan independently of response size. Keep the first point in
// each time bucket, the last endpoint, and both endpoints of every raw gap.
// If gaps alone exceed the point budget, reject rather than hide them.
func (a *EntityActions) MovementTrail(ctx context.Context, id string, q MovementQuery) (*protocol.MovementTrail, error) {
	id = SanitizeID(id)
	if err := validateMovementRange(q); err != nil {
		return nil, movementTrailError(err)
	}
	if q.MaxPoints == 0 {
		q.MaxPoints = 1000
	}
	if q.MaxPoints < 2 || q.MaxPoints > 5000 {
		return nil, NewValidationError("max_points must be 2 to 5000")
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	tx, err := a.movementReadTx(ctx, id, q.EntityCreatedAt)
	if err != nil {
		return nil, movementTrailError(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	cutoff := time.Now().Add(-MovementRetention)
	result := &protocol.MovementTrail{EntityCreatedAt: movementTime(q.EntityCreatedAt), From: movementTime(q.From), To: movementTime(q.To), RetainedFrom: movementTime(cutoff), Points: []protocol.MovementTrailPoint{}}
	rows, err := tx.Query(ctx, `SELECT `+movementColumns+` FROM entity_movement_samples WHERE entity_id=$1 AND entity_created_at=$2 AND sample_time >= $3 AND sample_time <= $4 AND sample_time >= $5 AND latitude IS NOT NULL ORDER BY sample_time,sequence LIMIT $6`, id, q.EntityCreatedAt, q.From, q.To, cutoff, movementScanBudget+1)
	if err != nil {
		return nil, movementTrailError(err)
	}
	defer rows.Close()
	bucketWidth := q.To.Sub(q.From) / time.Duration(max(1, q.MaxPoints/2))
	if bucketWidth < time.Microsecond {
		bucketWidth = time.Microsecond
	}
	var previous protocol.MovementSample
	var previousTime time.Time
	var lastBucket int64 = -1
	appendPoint := func(s protocol.MovementSample, gap bool) {
		if len(result.Points) == 0 || result.Points[len(result.Points)-1].Sample.SampleID != s.SampleID {
			result.Points = append(result.Points, protocol.MovementTrailPoint{Sample: s, GapBefore: gap})
		}
	}
	for rows.Next() {
		sample, _, err := scanMovement(rows)
		if err != nil {
			return nil, movementTrailError(err)
		}
		result.PositionCount++
		if result.PositionCount > movementScanBudget {
			return nil, NewValidationError("history interval exceeds the scan budget; choose a shorter interval")
		}
		t, _ := time.Parse(time.RFC3339Nano, sample.Time)
		bucket := int64(t.Sub(q.From) / bucketWidth)
		gap := !previousTime.IsZero() && t.Sub(previousTime) > time.Minute
		if gap {
			appendPoint(previous, false)
			appendPoint(sample, true)
		} else if bucket != lastBucket {
			appendPoint(sample, false)
		}
		if len(result.Points) > q.MaxPoints {
			return nil, NewValidationError("history has more gaps than the point budget; choose a shorter interval")
		}
		previous = sample
		previousTime = t
		lastBucket = bucket
	}
	if err := rows.Err(); err != nil {
		return nil, movementTrailError(err)
	}
	if !previousTime.IsZero() {
		appendPoint(previous, false)
	}
	if len(result.Points) > q.MaxPoints {
		return nil, NewValidationError("history exceeds the point budget; choose a shorter interval")
	}
	result.Simplified = int64(len(result.Points)) < result.PositionCount
	return result, nil
}

func movementTrailError(err error) error {
	var postgresError *pgconn.PgError
	if errors.As(err, &postgresError) && postgresError.Code == "57014" {
		return NewValidationError("history interval exceeds the query time budget; choose a shorter interval")
	}
	return err
}
