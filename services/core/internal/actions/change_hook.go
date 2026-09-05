package actions

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	protocol "github.com/the-drunken-coder/atlas/packages/protocol/generated/go/atlasprotocol"
	"github.com/the-drunken-coder/atlas/services/core/internal/models"
	"github.com/the-drunken-coder/atlas/services/core/internal/serializers"
)

type ChangeEvent = protocol.FeedEventName
type ChangeResource = protocol.ResourceType

const (
	ChangeEventCreate ChangeEvent = protocol.FeedEventCreate
	ChangeEventUpdate ChangeEvent = protocol.FeedEventUpdate
	ChangeEventDelete ChangeEvent = protocol.FeedEventDelete

	ChangeResourceEntity ChangeResource = protocol.ResourceTypeEntity
	ChangeResourceTask   ChangeResource = protocol.ResourceTypeTask
	ChangeResourceObject ChangeResource = protocol.ResourceTypeObject
)

// ResourceChange describes one resource mutation before it is recorded in the
// durable change stream. The resource version must already be allocated from
// atlas_change_clock in the same transaction.
type ResourceChange struct {
	Event        ChangeEvent
	ResourceType ChangeResource
	ID           string
	Version      int64
	ChangeReason protocol.EntityChangeReason

	AfterEntity *models.Entity
	AfterTask   *models.Task
	AfterObject *models.MediaObject
}

// ChangeRecord is the durable event plus task routing context used by feed
// subscriptions. Event is the canonical recovery payload.
type ChangeRecord struct {
	Event       protocol.FeedEvent
	TaskAssetID string
}

func cloneRawMessage(raw []byte) []byte {
	if raw == nil {
		return nil
	}
	return append([]byte(nil), raw...)
}

func cloneStringPointer(value *string) *string {
	if value == nil {
		return nil
	}
	cloned := *value
	return &cloned
}

func cloneEntityModel(entity *models.Entity) *models.Entity {
	if entity == nil {
		return nil
	}
	return &models.Entity{
		EntityID:  entity.EntityID,
		Type:      entity.Type,
		Subtype:   cloneStringPointer(entity.Subtype),
		Alias:     cloneStringPointer(entity.Alias),
		JSON:      cloneRawMessage(entity.JSON),
		CreatedAt: entity.CreatedAt,
		UpdatedAt: entity.UpdatedAt,
		Version:   entity.Version,
	}
}

func cloneTaskModel(task *models.Task) *models.Task {
	if task == nil {
		return nil
	}
	return &models.Task{
		TaskID: task.TaskID, AssetID: task.AssetID, Command: task.Command,
		Input: cloneRawMessage(task.Input), Status: task.Status, Progress: cloneFloatPointer(task.Progress),
		Output: cloneRawMessage(task.Output), CompletionAttempt: cloneRawMessage(task.CompletionAttempt),
		Failure: cloneRawMessage(task.Failure), Cancellation: cloneRawMessage(task.Cancellation),
		IdempotencyKey: task.IdempotencyKey, RuntimeID: task.RuntimeID,
		CreatedAt: task.CreatedAt, AcknowledgedAt: cloneTimePointer(task.AcknowledgedAt), StartedAt: cloneTimePointer(task.StartedAt),
		FinishedAt: cloneTimePointer(task.FinishedAt), UpdatedAt: task.UpdatedAt, Version: task.Version,
	}
}

func cloneFloatPointer(value *float64) *float64 {
	if value == nil {
		return nil
	}
	cloned := *value
	return &cloned
}

func cloneTimePointer(value *time.Time) *time.Time {
	if value == nil {
		return nil
	}
	cloned := *value
	return &cloned
}

func cloneObjectModel(object *models.MediaObject) *models.MediaObject {
	if object == nil {
		return nil
	}
	return &models.MediaObject{
		ObjectID:    object.ObjectID,
		Path:        cloneStringPointer(object.Path),
		ContentType: cloneStringPointer(object.ContentType),
		Type:        cloneStringPointer(object.Type),
		JSON:        cloneRawMessage(object.JSON),
		CreatedAt:   object.CreatedAt,
		UpdatedAt:   object.UpdatedAt,
		Version:     object.Version,
	}
}

func resourceChangeRecord(change ResourceChange) (ChangeRecord, error) {
	event := protocol.FeedEvent{
		Event:        change.Event,
		ResourceType: change.ResourceType,
		ID:           change.ID,
		Version:      change.Version,
	}
	switch change.ChangeReason {
	case "":
	case protocol.EntityChangeReasonRuntimeManifestChanged:
		if change.ResourceType != ChangeResourceEntity || change.Event != ChangeEventUpdate {
			return ChangeRecord{}, fmt.Errorf("change reason is only supported on entity update events")
		}
		event.ChangeReason = change.ChangeReason
	default:
		return ChangeRecord{}, fmt.Errorf("unsupported entity change reason %q", change.ChangeReason)
	}
	var record ChangeRecord
	switch change.ResourceType {
	case ChangeResourceEntity:
		if change.Event != ChangeEventDelete {
			if change.AfterEntity == nil {
				return ChangeRecord{}, fmt.Errorf("entity %s event missing after state", change.Event)
			}
			event.Resource = serializers.SerializeEntity(change.AfterEntity)
		}
	case ChangeResourceTask:
		if change.Event == ChangeEventDelete {
			return ChangeRecord{}, fmt.Errorf("task delete events are not supported")
		}
		if change.AfterTask == nil {
			return ChangeRecord{}, fmt.Errorf("task %s event missing after state", change.Event)
		}
		record.TaskAssetID = change.AfterTask.AssetID
		event.Resource = serializers.SerializeTask(change.AfterTask)
	case ChangeResourceObject:
		if change.Event != ChangeEventDelete {
			if change.AfterObject == nil {
				return ChangeRecord{}, fmt.Errorf("object %s event missing after state", change.Event)
			}
			event.Resource = serializers.SerializeObjectForFeed(change.AfterObject)
		}
	default:
		return ChangeRecord{}, fmt.Errorf("unknown resource type %q", change.ResourceType)
	}
	record.Event = event
	return record, nil
}

// RecordResourceChange inserts the complete protocol event before its resource
// transaction commits. PostgreSQL delivers the notification only on commit;
// consumers always read the durable row rather than trusting the notification.
func RecordResourceChange(ctx context.Context, tx pgx.Tx, change ResourceChange) error {
	record, err := resourceChangeRecord(change)
	if err != nil {
		return err
	}
	payload, err := json.Marshal(record.Event)
	if err != nil {
		return fmt.Errorf("marshal change event: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO atlas_change_events (version, event, task_asset_id)
		VALUES ($1, $2, NULLIF($3, ''))
	`, change.Version, payload, record.TaskAssetID); err != nil {
		return fmt.Errorf("record change event: %w", err)
	}
	if _, err := tx.Exec(ctx, `SELECT pg_notify('atlas_change_events', $1)`, fmt.Sprint(change.Version)); err != nil {
		return fmt.Errorf("notify change event: %w", err)
	}
	return nil
}

type changeRecordQuerier interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
}

// ReadChangeRecords returns one globally ordered page from the durable log.
func ReadChangeRecords(ctx context.Context, db changeRecordQuerier, afterVersion, throughVersion int64, limit int) ([]ChangeRecord, bool, error) {
	if limit < 1 {
		return nil, false, fmt.Errorf("change record limit must be positive")
	}
	rows, err := db.Query(ctx, `
		SELECT event, COALESCE(task_asset_id, '')
		FROM atlas_change_events
		WHERE version > $1 AND version <= $2
		ORDER BY version ASC
		LIMIT $3
	`, afterVersion, throughVersion, limit+1)
	if err != nil {
		return nil, false, fmt.Errorf("query change events: %w", err)
	}
	defer rows.Close()
	records := make([]ChangeRecord, 0, limit)
	totalBytes := 0
	hasMore := false
	for rows.Next() {
		var payload []byte
		var record ChangeRecord
		if err := rows.Scan(&payload, &record.TaskAssetID); err != nil {
			return nil, false, fmt.Errorf("scan change event: %w", err)
		}
		if len(records) >= limit || (len(records) > 0 && totalBytes+len(payload) > maxChangedSinceJSONBytes) {
			hasMore = true
			break
		}
		decoder := json.NewDecoder(bytes.NewReader(payload))
		decoder.UseNumber()
		if err := decoder.Decode(&record.Event); err != nil {
			return nil, false, fmt.Errorf("decode change event: %w", err)
		}
		records = append(records, record)
		totalBytes += len(payload)
	}
	if err := rows.Err(); err != nil {
		return nil, false, fmt.Errorf("query change events: %w", err)
	}
	return records, hasMore, nil
}
