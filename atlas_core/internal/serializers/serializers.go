// Package serializers provides serialization functions for database models.
package serializers

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/rs/zerolog/log"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/models"
	protocol "github.com/the-drunken-coder/atlas/atlas_protocol/generated/go/atlasprotocol"
)

// APIMetadataTimeLayout matches metadata.created_at / updated_at in JSON responses.
const APIMetadataTimeLayout = "2006-01-02T15:04:05.000000Z07:00"

// MetadataBlock uses the schema-parity-checked protocol metadata shape.
type MetadataBlock = protocol.MetadataBlock

// StrongETag returns a strong quoted ETag for resource concurrency (If-Match).
func StrongETag(version int64) string {
	return fmt.Sprintf(`"v%d"`, version)
}

// SerializeEntity converts an Entity to its API response format.
func SerializeEntity(e *models.Entity) *protocol.EntityResource {
	if e == nil {
		return nil
	}

	components := e.GetComponents()
	if components == nil {
		components = make(map[string]interface{})
	}

	return &protocol.EntityResource{
		EntityID:   e.EntityID,
		EntityType: e.Type,
		Subtype:    e.Subtype,
		Alias:      e.Alias,
		Components: components,
		Metadata: MetadataBlock{
			CreatedAt: e.CreatedAt.UTC().Format(APIMetadataTimeLayout),
			UpdatedAt: e.UpdatedAt.UTC().Format(APIMetadataTimeLayout),
			Version:   e.Version,
		},
		Extra: e.GetExtra(),
	}
}

// SerializeTask converts a Task to its API response format.
func SerializeTask(t *models.Task) *protocol.TaskResource {
	if t == nil {
		return nil
	}

	resource := &protocol.TaskResource{
		TaskID:         t.TaskID,
		AssetID:        t.AssetID,
		Command:        t.Command,
		Input:          decodeTaskJSON(t.TaskID, "input", t.Input),
		Status:         protocol.TaskStatus(t.Status),
		Progress:       t.Progress,
		CreatedAt:      t.CreatedAt.UTC().Format(APIMetadataTimeLayout),
		AcknowledgedAt: formatOptionalTaskTime(t.AcknowledgedAt),
		StartedAt:      formatOptionalTaskTime(t.StartedAt),
		FinishedAt:     formatOptionalTaskTime(t.FinishedAt),
		UpdatedAt:      t.UpdatedAt.UTC().Format(APIMetadataTimeLayout),
	}
	if len(t.Output) > 0 {
		output := decodeTaskJSON(t.TaskID, "output", t.Output)
		resource.Output = &output
	}
	if len(t.Failure) > 0 {
		failure := protocol.TaskFailure{}
		if err := json.Unmarshal(t.Failure, &failure); err == nil {
			resource.Failure = &failure
		}
	}
	if len(t.Cancellation) > 0 {
		cancellation := protocol.TaskCancellation{}
		if err := json.Unmarshal(t.Cancellation, &cancellation); err == nil {
			resource.Cancellation = &cancellation
		}
	}
	return resource
}

func decodeTaskJSON(taskID, field string, value json.RawMessage) protocol.JSONValue {
	if len(value) == 0 {
		return nil
	}
	var decoded protocol.JSONValue
	decoder := json.NewDecoder(bytes.NewReader(value))
	decoder.UseNumber()
	if err := decoder.Decode(&decoded); err != nil {
		log.Error().Err(err).Str("task_id", taskID).Str("field", field).Msg("invalid stored Task JSON")
		return nil
	}
	return decoded
}

func formatOptionalTaskTime(value *time.Time) string {
	if value == nil {
		return ""
	}
	return value.UTC().Format(APIMetadataTimeLayout)
}

// SerializeObject converts a MediaObject to its protocol-owned full-detail response.
func SerializeObject(o *models.MediaObject) *protocol.ObjectDetailResource {
	if o == nil {
		return nil
	}

	usageHints := o.GetUsageHints()
	if usageHints == nil {
		usageHints = []string{}
	}
	extra := o.GetExtra()
	if extra == nil {
		extra = map[string]interface{}{}
	}
	return &protocol.ObjectDetailResource{
		ObjectID:     o.ObjectID,
		Path:         o.Path,
		ContentType:  o.ContentType,
		Type:         o.Type,
		SizeBytes:    o.GetSizeBytes(),
		UsageHints:   usageHints,
		ReferencedBy: protocolObjectReferences(o.ObjectID, o.GetReferencedBy()),
		Bucket:       o.GetBucket(),
		Metadata: MetadataBlock{
			CreatedAt: o.CreatedAt.UTC().Format(APIMetadataTimeLayout),
			UpdatedAt: o.UpdatedAt.UTC().Format(APIMetadataTimeLayout),
			Version:   o.Version,
		},
		Extra: extra,
	}
}

// SerializeObjectForList converts a MediaObject to its API list response format (without extra).
func SerializeObjectForList(o *models.MediaObject) *protocol.ObjectResource {
	if o == nil {
		return nil
	}

	usageHints := o.GetUsageHints()
	if usageHints == nil {
		usageHints = []string{}
	}
	return &protocol.ObjectResource{
		ObjectID:    o.ObjectID,
		Path:        o.Path,
		ContentType: o.ContentType,
		Type:        o.Type,
		SizeBytes:   o.GetSizeBytes(),
		UsageHints:  usageHints,
		Bucket:      o.GetBucket(),
		Metadata: MetadataBlock{
			CreatedAt: o.CreatedAt.UTC().Format(APIMetadataTimeLayout),
			UpdatedAt: o.UpdatedAt.UTC().Format(APIMetadataTimeLayout),
			Version:   o.Version,
		},
	}
}

// SerializeObjectForFeed converts a MediaObject to the protocol-owned object feed resource.
func SerializeObjectForFeed(o *models.MediaObject) *protocol.ObjectResource {
	if o == nil {
		return nil
	}

	usageHints := o.GetUsageHints()
	if usageHints == nil {
		usageHints = []string{}
	}
	return &protocol.ObjectResource{
		ObjectID:     o.ObjectID,
		Path:         o.Path,
		ContentType:  o.ContentType,
		Type:         o.Type,
		SizeBytes:    o.GetSizeBytes(),
		UsageHints:   usageHints,
		ReferencedBy: protocolObjectReferences(o.ObjectID, o.GetReferencedBy()),
		Bucket:       o.GetBucket(),
		Metadata: MetadataBlock{
			CreatedAt: o.CreatedAt.UTC().Format(APIMetadataTimeLayout),
			UpdatedAt: o.UpdatedAt.UTC().Format(APIMetadataTimeLayout),
			Version:   o.Version,
		},
	}
}

func protocolObjectReferences(objectID string, values []map[string]interface{}) []protocol.ObjectReference {
	if len(values) == 0 {
		return nil
	}
	refs := make([]protocol.ObjectReference, 0, len(values))
	for _, value := range values {
		ref := protocol.ObjectReference{}
		if raw, exists := value["entity_id"]; exists {
			if raw == nil {
				// JSON null means no entity reference.
			} else if entityID, ok := raw.(string); ok {
				trimmed := strings.TrimSpace(entityID)
				if trimmed != "" {
					ref.EntityID = &trimmed
				}
			} else {
				log.Warn().
					Str("object_id", objectID).
					Str("key", "entity_id").
					Str("actual_type", fmt.Sprintf("%T", raw)).
					Interface("value", raw).
					Msg("Dropping object feed reference field with non-string id")
			}
		}
		if raw, exists := value["task_id"]; exists {
			if raw == nil {
				// JSON null means no task reference.
			} else if taskID, ok := raw.(string); ok {
				trimmed := strings.TrimSpace(taskID)
				if trimmed != "" {
					ref.TaskID = &trimmed
				}
			} else {
				log.Warn().
					Str("object_id", objectID).
					Str("key", "task_id").
					Str("actual_type", fmt.Sprintf("%T", raw)).
					Interface("value", raw).
					Msg("Dropping object feed reference field with non-string id")
			}
		}
		if ref.EntityID != nil || ref.TaskID != nil {
			refs = append(refs, ref)
		}
	}
	if len(refs) == 0 {
		return nil
	}
	return refs
}

// SerializeEntities converts a slice of entities to their API response format.
func SerializeEntities(entities []*models.Entity) []protocol.EntityResource {
	result := make([]protocol.EntityResource, 0, len(entities))
	for _, entity := range entities {
		if serialized := SerializeEntity(entity); serialized != nil {
			result = append(result, *serialized)
		}
	}
	return result
}

// SerializeTasks converts a slice of tasks to their API response format.
func SerializeTasks(tasks []*models.Task) []protocol.TaskResource {
	result := make([]protocol.TaskResource, 0, len(tasks))
	for _, task := range tasks {
		if serialized := SerializeTask(task); serialized != nil {
			result = append(result, *serialized)
		}
	}
	return result
}

// SerializeObjects converts a slice of objects to full-detail responses.
func SerializeObjects(objects []*models.MediaObject) []protocol.ObjectDetailResource {
	result := make([]protocol.ObjectDetailResource, 0, len(objects))
	for _, object := range objects {
		if serialized := SerializeObject(object); serialized != nil {
			result = append(result, *serialized)
		}
	}
	return result
}

// SerializeObjectsForList converts a slice of objects to their API list response format (without extra).
func SerializeObjectsForList(objects []*models.MediaObject) []protocol.ObjectResource {
	result := make([]protocol.ObjectResource, 0, len(objects))
	for _, object := range objects {
		if serialized := SerializeObjectForList(object); serialized != nil {
			result = append(result, *serialized)
		}
	}
	return result
}
