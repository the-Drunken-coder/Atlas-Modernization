package actions

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	protocol "github.com/the-drunken-coder/atlas/packages/protocol/generated/go/atlasprotocol"
	"github.com/the-drunken-coder/atlas/services/core/internal/models"
)

const MovementRetention = 30 * 24 * time.Hour
const movementClockSkew = 5 * time.Minute

func movementTime(t time.Time) string { return t.UTC().Format(time.RFC3339Nano) }

// Normalize once to PostgreSQL precision so retries compare canonical values.
func validateMovement(input protocol.MovementSampleInput, received time.Time) (*time.Time, time.Time, error) {
	if err := validateStringMaxLength("sample_id", input.SampleID, 128); err != nil {
		return nil, time.Time{}, err
	}
	if strings.TrimSpace(input.SampleID) == "" {
		return nil, time.Time{}, NewValidationError("sample_id is required")
	}
	if (input.Latitude == nil) != (input.Longitude == nil) {
		return nil, time.Time{}, NewValidationError("movement position requires latitude and longitude")
	}
	if input.Latitude == nil && input.SpeedMS == nil && input.AltitudeM == nil {
		return nil, time.Time{}, NewValidationError("movement sample requires position, speed or altitude")
	}
	for _, value := range []*float64{input.Latitude, input.Longitude, input.SpeedMS, input.AltitudeM} {
		if value != nil && (math.IsNaN(*value) || math.IsInf(*value, 0)) {
			return nil, time.Time{}, NewValidationError("movement values must be finite")
		}
	}
	if input.Latitude != nil && (*input.Latitude < -90 || *input.Latitude > 90 || *input.Longitude < -180 || *input.Longitude > 180) {
		return nil, time.Time{}, NewValidationError("movement coordinates are outside valid bounds")
	}
	if input.SpeedMS != nil && *input.SpeedMS < 0 {
		return nil, time.Time{}, NewValidationError("movement speed cannot be negative")
	}
	if input.ObservedAt == nil {
		return nil, received, nil
	}
	observed, err := time.Parse(time.RFC3339Nano, *input.ObservedAt)
	if err != nil || observed.After(received.Add(movementClockSkew)) {
		return nil, time.Time{}, NewValidationError("observed_at must be RFC3339 and at most five minutes ahead of arrival")
	}
	observed = observed.UTC().Truncate(time.Microsecond)
	return &observed, observed, nil
}

// Caller owns the Entity row lock. Imports never acquire the live change clock.
func insertMovement(ctx context.Context, tx pgx.Tx, entity *models.Entity, input protocol.MovementSampleInput, received time.Time) (bool, error) {
	observed, sampleTime, err := validateMovement(input, received)
	if err != nil {
		return false, err
	}
	tag, err := tx.Exec(ctx, `INSERT INTO entity_movement_samples
 (entity_id,entity_created_at,sample_id,observed_at,received_at,sample_time,latitude,longitude,speed_m_s,altitude_m)
 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
 ON CONFLICT (entity_id,entity_created_at,sample_id) DO NOTHING`, entity.EntityID, entity.CreatedAt, input.SampleID, observed, received, sampleTime, input.Latitude, input.Longitude, input.SpeedMS, input.AltitudeM)
	if err != nil {
		return false, fmt.Errorf("insert movement: %w", err)
	}
	if tag.RowsAffected() == 1 {
		return true, nil
	}
	var equal bool
	err = tx.QueryRow(ctx, `SELECT observed_at IS NOT DISTINCT FROM $4::timestamptz
 AND latitude IS NOT DISTINCT FROM $5::float8 AND longitude IS NOT DISTINCT FROM $6::float8
 AND speed_m_s IS NOT DISTINCT FROM $7::float8 AND altitude_m IS NOT DISTINCT FROM $8::float8
 FROM entity_movement_samples WHERE entity_id=$1 AND entity_created_at=$2 AND sample_id=$3`, entity.EntityID, entity.CreatedAt, input.SampleID, observed, input.Latitude, input.Longitude, input.SpeedMS, input.AltitudeM).Scan(&equal)
	if err != nil {
		return false, fmt.Errorf("compare existing movement report: %w", err)
	}
	if !equal {
		return false, &ConflictError{ActionError: ActionError{Message: "sample_id already belongs to a different movement report", Code: protocol.ErrorCodeValidationError}}
	}
	return false, nil
}

// Capture the incoming patch, never the merged Entity. Partial positions cannot
// manufacture a position report, but independently supplied quantities survive.
func captureMovement(ctx context.Context, tx pgx.Tx, entity *models.Entity, components map[string]interface{}, observed *string, received time.Time) error {
	if entity.Type != "asset" && entity.Type != "track" {
		return nil
	}
	raw, ok := components["telemetry"]
	if !ok {
		return nil
	}
	data, err := json.Marshal(raw)
	if err != nil {
		return NewValidationError("invalid movement telemetry")
	}
	var sample protocol.MovementSampleInput
	if err = json.Unmarshal(data, &sample); err != nil {
		return NewValidationError("invalid movement telemetry")
	}
	if sample.Latitude == nil || sample.Longitude == nil {
		sample.Latitude = nil
		sample.Longitude = nil
	}
	if sample.Latitude == nil && sample.SpeedMS == nil && sample.AltitudeM == nil {
		return nil
	}
	sample.SampleID = uuid.NewString()
	sample.ObservedAt = observed
	received = received.UTC().Truncate(time.Microsecond)
	_, sampleTime, err := validateMovement(sample, received)
	if err != nil {
		return err
	}
	if sampleTime.Before(time.Now().Add(-MovementRetention)) {
		return nil
	}
	_, err = insertMovement(ctx, tx, entity, sample, received)
	return err
}

func movementEntity(ctx context.Context, tx pgx.Tx, id string, created time.Time, lock bool) (*models.Entity, error) {
	if err := ValidateEntityID(id); err != nil {
		return nil, err
	}
	query := `SELECT entity_id,type,subtype,alias,json,created_at,updated_at,version FROM entities WHERE entity_id=$1`
	if lock {
		query += " FOR UPDATE"
	}
	entity, err := scanEntity(tx.QueryRow(ctx, query, SanitizeID(id)))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, NewEntityNotFoundError(id)
	}
	if err != nil {
		return nil, err
	}
	if !entity.CreatedAt.Equal(created) {
		return nil, NewPreconditionFailedError("Entity history association")
	}
	if entity.Type != "asset" && entity.Type != "track" {
		return nil, NewValidationError("movement history requires an Asset or Track")
	}
	return entity, nil
}

func (a *EntityActions) ImportMovement(ctx context.Context, id string, request protocol.MovementHistoryBatchRequest, received time.Time) (*protocol.MovementHistoryBatchResponse, error) {
	created, err := time.Parse(time.RFC3339Nano, request.EntityCreatedAt)
	if err != nil {
		return nil, NewValidationError("entity_created_at must identify the current Entity record")
	}
	if len(request.Samples) < 1 || len(request.Samples) > 500 {
		return nil, NewValidationError("movement batches require 1 to 500 samples")
	}
	received = received.UTC().Truncate(time.Microsecond)
	cutoff := time.Now().Add(-MovementRetention)
	// Validate the entire batch before skipping expired reports or changing rows.
	for _, sample := range request.Samples {
		if _, _, err := validateMovement(sample, received); err != nil {
			return nil, err
		}
	}
	tx, err := a.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	entity, err := movementEntity(ctx, tx, id, created, true)
	if err != nil {
		return nil, err
	}
	result := &protocol.MovementHistoryBatchResponse{}
	for _, sample := range request.Samples {
		_, t, _ := validateMovement(sample, received)
		if t.Before(cutoff) {
			result.Expired++
			continue
		}
		inserted, err := insertMovement(ctx, tx, entity, sample, received)
		if err != nil {
			return nil, err
		}
		if inserted {
			result.Inserted++
		} else {
			result.Duplicates++
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return result, nil
}

// PruneMovement removes a bounded batch; the dispatcher repeats on its normal wakeups.
func (a *EntityActions) PruneMovement(ctx context.Context) error {
	_, err := a.pool.Exec(ctx, `DELETE FROM entity_movement_samples WHERE sequence IN
 (SELECT sequence FROM entity_movement_samples WHERE sample_time < $1 ORDER BY sample_time,sequence LIMIT 10000)`, time.Now().Add(-MovementRetention))
	return err
}
