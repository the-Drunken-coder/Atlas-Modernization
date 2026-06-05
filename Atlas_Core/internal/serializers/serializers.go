// Package serializers provides serialization functions for database models.
package serializers

import (
	"fmt"

	"github.com/the-drunken-coder/atlas/atlas_core/internal/models"
)

// APIMetadataTimeLayout matches metadata.created_at / updated_at in JSON responses.
const APIMetadataTimeLayout = "2006-01-02T15:04:05.000000Z07:00"

// ObjectStrongETag returns a strong quoted ETag for object GET/PATCH concurrency (If-Match).
func ObjectStrongETag(version int64) string {
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

// ObjectResponse represents the serialized form of a MediaObject (full detail).
type ObjectResponse struct {
	ObjectID     string                   `json:"object_id"`
	Path         *string                  `json:"path"`
	ContentType  *string                  `json:"content_type"`
	Type         *string                  `json:"type"`
	SizeBytes    *int64                   `json:"size_bytes"`
	UsageHints   []string                 `json:"usage_hints"`
	ReferencedBy []map[string]interface{} `json:"referenced_by,omitempty"`
	Bucket       *string                  `json:"bucket"`
	Metadata     MetadataBlock            `json:"metadata"`
	Payload      map[string]interface{}   `json:"payload,omitempty"`
}

// ObjectListResponse represents the serialized form of a MediaObject for list endpoints (without payload).
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

// MetadataBlock contains storage metadata exposed on API resources.
type MetadataBlock struct {
	CreatedAt string `json:"created_at,omitempty"`
	UpdatedAt string `json:"updated_at,omitempty"`
	Version   int64  `json:"version,omitempty"`
}

// SerializeEntity converts an Entity to its API response format.
func SerializeEntity(e *models.Entity) *EntityResponse {
	if e == nil {
		return nil
	}

	data := e.DecodedJSON()
	components := mapField(data, "components")
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
		Extra: entityExtra(data),
	}
}

// SerializeTask converts a Task to its API response format.
func SerializeTask(t *models.Task) *TaskResponse {
	if t == nil {
		return nil
	}

	data := t.DecodedJSON()
	components := mapField(data, "components")
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
		Extra: taskExtra(data),
	}
}

// SerializeObject converts a MediaObject to its API response format (with payload).
func SerializeObject(o *models.MediaObject) *ObjectResponse {
	if o == nil {
		return nil
	}

	data := o.DecodedJSON()
	usageHints := objectUsageHints(data)
	if usageHints == nil {
		usageHints = []string{}
	}
	return &ObjectResponse{
		ObjectID:     o.ObjectID,
		Path:         o.Path,
		ContentType:  o.ContentType,
		Type:         o.Type,
		SizeBytes:    o.GetSizeBytes(),
		UsageHints:   usageHints,
		ReferencedBy: objectReferencedBy(data),
		Bucket:       objectBucket(data),
		Metadata: MetadataBlock{
			CreatedAt: o.CreatedAt.UTC().Format(APIMetadataTimeLayout),
			UpdatedAt: o.UpdatedAt.UTC().Format(APIMetadataTimeLayout),
			Version:   o.Version,
		},
		Payload: objectPayload(data),
	}
}

// SerializeObjectForList converts a MediaObject to its API list response format (without payload).
func SerializeObjectForList(o *models.MediaObject) *ObjectListResponse {
	if o == nil {
		return nil
	}

	data := o.DecodedJSON()
	usageHints := objectUsageHints(data)
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
		Bucket:      objectBucket(data),
		Metadata: MetadataBlock{
			CreatedAt: o.CreatedAt.UTC().Format(APIMetadataTimeLayout),
			UpdatedAt: o.UpdatedAt.UTC().Format(APIMetadataTimeLayout),
			Version:   o.Version,
		},
	}
}

func mapField(data map[string]interface{}, key string) map[string]interface{} {
	if data == nil {
		return nil
	}
	if value, ok := data[key].(map[string]interface{}); ok {
		return value
	}
	return nil
}

func entityExtra(data map[string]interface{}) map[string]interface{} {
	return extraWithout(data, map[string]struct{}{
		"components": {}, "type": {}, "subtype": {}, "alias": {},
		"entity_id": {}, "task_id": {}, "object_id": {}, "created_at": {}, "updated_at": {}, "version": {},
	})
}

func taskExtra(data map[string]interface{}) map[string]interface{} {
	return extraWithout(data, map[string]struct{}{
		"components": {}, "status": {}, "entity_id": {}, "task_id": {},
		"object_id": {}, "created_at": {}, "updated_at": {}, "version": {},
	})
}

func objectPayload(data map[string]interface{}) map[string]interface{} {
	return extraWithout(data, map[string]struct{}{
		"path": {}, "content_type": {}, "type": {}, "size_bytes": {}, "usage_hints": {}, "bucket": {}, "referenced_by": {},
		"object_id": {}, "created_at": {}, "updated_at": {}, "version": {},
	})
}

func extraWithout(data map[string]interface{}, excluded map[string]struct{}) map[string]interface{} {
	if data == nil {
		return nil
	}
	extra := make(map[string]interface{})
	for key, value := range data {
		if _, skip := excluded[key]; !skip {
			extra[key] = value
		}
	}
	if len(extra) == 0 {
		return nil
	}
	return extra
}

func objectUsageHints(data map[string]interface{}) []string {
	if data == nil {
		return nil
	}
	hints, ok := data["usage_hints"].([]interface{})
	if !ok {
		return nil
	}
	result := make([]string, 0, len(hints))
	for _, hint := range hints {
		if s, ok := hint.(string); ok {
			result = append(result, s)
		}
	}
	return result
}

func objectBucket(data map[string]interface{}) *string {
	if data == nil {
		return nil
	}
	bucket, ok := data["bucket"].(string)
	if !ok {
		return nil
	}
	return &bucket
}

func objectReferencedBy(data map[string]interface{}) []map[string]interface{} {
	if data == nil {
		return nil
	}
	refs, ok := data["referenced_by"].([]interface{})
	if !ok {
		return nil
	}
	result := make([]map[string]interface{}, 0, len(refs))
	for _, ref := range refs {
		if refMap, ok := ref.(map[string]interface{}); ok {
			result = append(result, refMap)
		}
	}
	return result
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

// SerializeObjects converts a slice of objects to their API response format (with payload).
func SerializeObjects(objects []*models.MediaObject) []*ObjectResponse {
	result := make([]*ObjectResponse, len(objects))
	for i, o := range objects {
		result[i] = SerializeObject(o)
	}
	return result
}

// SerializeObjectsForList converts a slice of objects to their API list response format (without payload).
func SerializeObjectsForList(objects []*models.MediaObject) []*ObjectListResponse {
	result := make([]*ObjectListResponse, len(objects))
	for i, o := range objects {
		result[i] = SerializeObjectForList(o)
	}
	return result
}
