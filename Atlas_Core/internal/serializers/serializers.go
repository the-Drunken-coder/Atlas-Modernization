// Package serializers provides serialization functions for database models.
package serializers

import (
	"fmt"
	"strings"

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

// EntityResponse represents the serialized form of an Entity.
type EntityResponse struct {
	EntityID   string                 `json:"entity_id"`
	EntityType string                 `json:"entity_type"`
	Subtype    *string                `json:"subtype"`
	Alias      *string                `json:"alias"`
	Components map[string]interface{} `json:"components"`
	Metadata   MetadataBlock          `json:"metadata"`
	Extra      map[string]interface{} `json:"extra,omitempty"`
}

// TaskResponse represents the serialized form of a Task.
type TaskResponse struct {
	TaskID     string                 `json:"task_id"`
	Status     string                 `json:"status"`
	EntityID   *string                `json:"entity_id"`
	Components map[string]interface{} `json:"components"`
	Metadata   MetadataBlock          `json:"metadata"`
	Extra      map[string]interface{} `json:"extra,omitempty"`
}

// ObjectListResponse represents the serialized form of a MediaObject for list endpoints (without extra).
type ObjectListResponse struct {
	ObjectID    string        `json:"object_id"`
	Path        *string       `json:"path"`
	ContentType *string       `json:"content_type"`
	Type        *string       `json:"type"`
	SizeBytes   *int64        `json:"size_bytes"`
	UsageHints  []string      `json:"usage_hints"`
	Bucket      *string       `json:"bucket"`
	Metadata    MetadataBlock `json:"metadata"`
}

// SerializeEntity converts an Entity to its API response format.
func SerializeEntity(e *models.Entity) *EntityResponse {
	if e == nil {
		return nil
	}

	components := e.GetComponents()
	if components == nil {
		components = make(map[string]interface{})
	}

	return &EntityResponse{
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
func SerializeTask(t *models.Task) *TaskResponse {
	if t == nil {
		return nil
	}

	components := t.GetComponents()
	if components == nil {
		components = make(map[string]interface{})
	}

	return &TaskResponse{
		TaskID:     t.TaskID,
		Status:     t.Status,
		EntityID:   t.EntityID,
		Components: components,
		Metadata: MetadataBlock{
			CreatedAt: t.CreatedAt.UTC().Format(APIMetadataTimeLayout),
			UpdatedAt: t.UpdatedAt.UTC().Format(APIMetadataTimeLayout),
			Version:   t.Version,
		},
		Extra: t.GetExtra(),
	}
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
func SerializeObjectForList(o *models.MediaObject) *ObjectListResponse {
	if o == nil {
		return nil
	}

	usageHints := o.GetUsageHints()
	if usageHints == nil {
		usageHints = []string{}
	}
	return &ObjectListResponse{
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
func SerializeEntities(entities []*models.Entity) []*EntityResponse {
	result := make([]*EntityResponse, len(entities))
	for i, e := range entities {
		result[i] = SerializeEntity(e)
	}
	return result
}

// SerializeTasks converts a slice of tasks to their API response format.
func SerializeTasks(tasks []*models.Task) []*TaskResponse {
	result := make([]*TaskResponse, len(tasks))
	for i, t := range tasks {
		result[i] = SerializeTask(t)
	}
	return result
}

// SerializeObjects converts a slice of objects to full-detail responses.
func SerializeObjects(objects []*models.MediaObject) []*protocol.ObjectDetailResource {
	result := make([]*protocol.ObjectDetailResource, len(objects))
	for i, o := range objects {
		result[i] = SerializeObject(o)
	}
	return result
}

// SerializeObjectsForList converts a slice of objects to their API list response format (without extra).
func SerializeObjectsForList(objects []*models.MediaObject) []*ObjectListResponse {
	result := make([]*ObjectListResponse, len(objects))
	for i, o := range objects {
		result[i] = SerializeObjectForList(o)
	}
	return result
}
