// Package models defines the database models for Atlas Core.
package models

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"sync"
	"time"

	// NOTE: We intentionally use the global zerolog logger in this package.
	// The models package is part of the data layer and does not receive an
	// injected logger instance. JSON unmarshal failures here indicate potential
	// database corruption or malformed data at rest, and these errors must
	// always be logged regardless of the configured application log level or
	// output. The global logger is used as a fail-safe for these critical
	// conditions. See cmd/atlas_core/main.go for the primary logging
	// configuration.
	"github.com/rs/zerolog/log"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/jsondecode"
)

// jsonLogMeta returns non-sensitive metadata for logs (length + short hash).
func jsonLogMeta(data []byte, recordID string) string {
	if len(data) == 0 {
		return fmt.Sprintf("id=%s len=0", recordID)
	}
	sum := sha256.Sum256(data)
	return fmt.Sprintf("id=%s len=%d sha256_prefix=%s", recordID, len(data), hex.EncodeToString(sum[:8]))
}

func deepCopyValue(value interface{}) interface{} {
	switch typed := value.(type) {
	case map[string]interface{}:
		return deepCopyMap(typed)
	case []interface{}:
		out := make([]interface{}, len(typed))
		for i, item := range typed {
			out[i] = deepCopyValue(item)
		}
		return out
	default:
		return typed
	}
}

func deepCopyMap(src map[string]interface{}) map[string]interface{} {
	if src == nil {
		return nil
	}
	out := make(map[string]interface{}, len(src))
	for k, v := range src {
		out[k] = deepCopyValue(v)
	}
	return out
}

func decodeStoredJSON(raw []byte) (map[string]interface{}, error) {
	var data map[string]interface{}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := jsondecode.Decode(decoder, &data); err != nil {
		return nil, err
	}
	return data, nil
}

type decodedJSONCache struct {
	mu   sync.Mutex
	init bool
	raw  []byte
	data map[string]interface{}
	err  error
}

func (c *decodedJSONCache) decode(raw json.RawMessage, recordID, logField, recordDescription string) map[string]interface{} {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.init && bytes.Equal(c.raw, raw) {
		if c.err != nil {
			return nil
		}
		return deepCopyMap(c.data)
	}

	c.raw = append(c.raw[:0], raw...)
	c.data = nil
	c.err = nil
	c.init = false
	if raw == nil {
		c.init = true
		return nil
	}

	data, err := decodeStoredJSON(raw)
	if err != nil {
		c.err = err
		c.init = true
		log.Error().
			Err(err).
			Str(logField, recordID).
			Str("json_meta", jsonLogMeta(raw, recordID)).
			Msgf("Failed to unmarshal %s JSON - database corruption suspected", recordDescription)
		return nil
	}
	c.data = data
	c.init = true
	return deepCopyMap(c.data)
}

func fieldSet(keys ...string) map[string]struct{} {
	fields := make(map[string]struct{}, len(keys))
	for _, key := range keys {
		fields[key] = struct{}{}
	}
	return fields
}

var (
	entityPromotedFields = fieldSet(
		"components", "type", "subtype", "alias",
		"entity_id", "task_id", "object_id", "created_at", "updated_at", "version",
	)
	taskPromotedFields = fieldSet(
		"components", "status", "entity_id", "task_id",
		"object_id", "created_at", "updated_at", "version",
	)
	mediaObjectPromotedFields = fieldSet(
		"path", "content_type", "type", "size_bytes", "usage_hints", "bucket", "referenced_by",
		"object_id", "created_at", "updated_at", "version",
	)
)

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

// EntityExtra returns non-promoted fields from an entity JSON blob.
func EntityExtra(data map[string]interface{}) map[string]interface{} {
	return extraWithout(data, entityPromotedFields)
}

// TaskExtra returns non-promoted fields from a task JSON blob.
func TaskExtra(data map[string]interface{}) map[string]interface{} {
	return extraWithout(data, taskPromotedFields)
}

// MediaObjectPayload returns non-promoted fields from an object JSON blob.
func MediaObjectPayload(data map[string]interface{}) map[string]interface{} {
	return extraWithout(data, mediaObjectPromotedFields)
}

// Entity represents an entity in the system (asset, track, geofeature, etc.).
type Entity struct {
	EntityID  string          `json:"entity_id" db:"entity_id"`
	Type      string          `json:"type" db:"type"`
	Subtype   *string         `json:"subtype,omitempty" db:"subtype"`
	Alias     *string         `json:"alias,omitempty" db:"alias"`
	JSON      json.RawMessage `json:"-" db:"json"`
	CreatedAt time.Time       `json:"created_at" db:"created_at"`
	UpdatedAt time.Time       `json:"updated_at" db:"updated_at"`
	Version   int64           `json:"version" db:"version"`

	jsonCache decodedJSONCache
}

func (e *Entity) decodedJSON() map[string]interface{} {
	return e.jsonCache.decode(e.JSON, e.EntityID, "entity_id", "entity")
}

// DecodedJSON returns a deep copy of the entity JSON blob.
func (e *Entity) DecodedJSON() map[string]interface{} {
	return e.decodedJSON()
}

// GetComponents returns the components from the JSON blob.
func (e *Entity) GetComponents() map[string]interface{} {
	data := e.decodedJSON()
	if data == nil {
		return nil
	}
	if components, ok := data["components"].(map[string]interface{}); ok {
		return components
	}
	return nil
}

// GetExtra returns extra fields from the JSON blob (excluding promoted fields).
func (e *Entity) GetExtra() map[string]interface{} {
	data := e.decodedJSON()
	return EntityExtra(data)
}

// Task represents a task assigned to an entity.
type Task struct {
	TaskID    string          `json:"task_id" db:"task_id"`
	Status    string          `json:"status" db:"status"`
	EntityID  *string         `json:"entity_id,omitempty" db:"entity_id"`
	JSON      json.RawMessage `json:"-" db:"json"`
	CreatedAt time.Time       `json:"created_at" db:"created_at"`
	UpdatedAt time.Time       `json:"updated_at" db:"updated_at"`
	Version   int64           `json:"version" db:"version"`

	jsonCache decodedJSONCache
}

func (t *Task) decodedJSON() map[string]interface{} {
	return t.jsonCache.decode(t.JSON, t.TaskID, "task_id", "task")
}

// DecodedJSON returns a deep copy of the task JSON blob.
func (t *Task) DecodedJSON() map[string]interface{} {
	return t.decodedJSON()
}

// GetComponents returns the components from the JSON blob.
func (t *Task) GetComponents() map[string]interface{} {
	data := t.decodedJSON()
	if data == nil {
		return nil
	}
	if components, ok := data["components"].(map[string]interface{}); ok {
		return components
	}
	return nil
}

// GetExtra returns extra fields from the JSON blob (excluding promoted fields).
func (t *Task) GetExtra() map[string]interface{} {
	data := t.decodedJSON()
	return TaskExtra(data)
}

// MediaObject represents a stored object/file.
type MediaObject struct {
	ObjectID    string          `json:"object_id" db:"object_id"`
	Path        *string         `json:"path,omitempty" db:"path"`
	ContentType *string         `json:"content_type,omitempty" db:"content_type"`
	Type        *string         `json:"type,omitempty" db:"type"`
	JSON        json.RawMessage `json:"-" db:"json"`
	CreatedAt   time.Time       `json:"created_at" db:"created_at"`
	UpdatedAt   time.Time       `json:"updated_at" db:"updated_at"`
	Version     int64           `json:"version" db:"version"`

	jsonCache decodedJSONCache
}

func (o *MediaObject) decodedJSON() map[string]interface{} {
	return o.jsonCache.decode(o.JSON, o.ObjectID, "object_id", "media object")
}

// DecodedJSON returns a deep copy of the media object JSON blob.
func (o *MediaObject) DecodedJSON() map[string]interface{} {
	return o.decodedJSON()
}

// GetSizeBytes returns the size_bytes from the JSON blob.
// decodedJSON decodes with UseNumber, so numeric values arrive as json.Number;
// Int64 preserves full precision for large sizes (values that overflow int64 or
// carry a fractional part are rejected as invalid).
func (o *MediaObject) GetSizeBytes() *int64 {
	data := o.decodedJSON()
	if data == nil {
		return nil
	}
	size, ok := data["size_bytes"].(json.Number)
	if !ok {
		return nil
	}
	i, err := size.Int64()
	if err == nil {
		if i < 0 {
			return nil
		}
		return &i
	}
	// Accept integer-valued float literals (e.g. "1024.0"); reject fractional or out-of-range.
	f, err := size.Float64()
	if err != nil {
		return nil
	}
	intpart, frac := math.Modf(f)
	if frac != 0 {
		return nil
	}
	const maxInt64Plus1 = float64(uint64(1) << 63)
	if intpart < 0 || intpart >= maxInt64Plus1 {
		return nil
	}
	s := int64(intpart)
	return &s
}

// GetUsageHints returns the usage_hints from the JSON blob.
func (o *MediaObject) GetUsageHints() []string {
	data := o.decodedJSON()
	if data == nil {
		return nil
	}
	if hints, ok := data["usage_hints"].([]interface{}); ok {
		result := make([]string, 0, len(hints))
		for _, h := range hints {
			if s, ok := h.(string); ok {
				result = append(result, s)
			}
		}
		return result
	}
	return nil
}

// GetBucket returns the bucket from the JSON blob.
func (o *MediaObject) GetBucket() *string {
	data := o.decodedJSON()
	if data == nil {
		return nil
	}
	if bucket, ok := data["bucket"].(string); ok {
		return &bucket
	}
	return nil
}

// GetPayload returns the remaining fields from the JSON blob (excluding promoted fields).
func (o *MediaObject) GetPayload() map[string]interface{} {
	data := o.decodedJSON()
	return MediaObjectPayload(data)
}

// GetReferencedBy returns the referenced_by from the JSON blob.
func (o *MediaObject) GetReferencedBy() []map[string]interface{} {
	data := o.decodedJSON()
	if data == nil {
		return nil
	}
	if refs, ok := data["referenced_by"].([]interface{}); ok {
		result := make([]map[string]interface{}, 0, len(refs))
		for _, r := range refs {
			if m, ok := r.(map[string]interface{}); ok {
				result = append(result, m)
			}
		}
		return result
	}
	return nil
}
