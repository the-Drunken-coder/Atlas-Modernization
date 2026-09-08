// Package models defines the database models for Atlas Core.
package models

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"slices"
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
	"github.com/the-drunken-coder/atlas/services/core/internal/jsondecode"
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

type jsonBlobCache struct {
	mu   sync.Mutex
	init bool
	raw  []byte
	data map[string]interface{}
	err  error
}

func (c *jsonBlobCache) decoded(raw json.RawMessage, recordField, recordID, label string) map[string]interface{} {
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
			Str(recordField, recordID).
			Str("json_meta", jsonLogMeta(raw, recordID)).
			Msgf("Failed to unmarshal %s JSON - database corruption suspected", label)
		return nil
	}
	c.data = data
	c.init = true
	return deepCopyMap(c.data)
}

func jsonFieldsExcept(data map[string]interface{}, excluded ...string) map[string]interface{} {
	if data == nil {
		return nil
	}
	out := make(map[string]interface{})
	for k, v := range data {
		if !slices.Contains(excluded, k) {
			out[k] = v
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
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

	jsonCache jsonBlobCache
}

func (e *Entity) decodedJSON() map[string]interface{} {
	return e.jsonCache.decoded(e.JSON, "entity_id", e.EntityID, "entity")
}

// EntityJSONSnapshot owns one defensive copy of a stored JSON document.
// Maps and slices returned by its methods belong to this snapshot; mutating them
// cannot change the model cache or another snapshot.
type EntityJSONSnapshot struct {
	data map[string]interface{}
}

// JSONSnapshot copies the decoded document once for reading multiple fields.
func (e *Entity) JSONSnapshot() EntityJSONSnapshot {
	return EntityJSONSnapshot{data: e.decodedJSON()}
}

// DecodedJSON returns a deep copy of the entity JSON blob.
func (e *Entity) DecodedJSON() map[string]interface{} {
	return e.decodedJSON()
}

// GetComponents returns the components from the JSON blob.
func (e *Entity) GetComponents() map[string]interface{} {
	return e.JSONSnapshot().Components()
}

// Components reads components from the snapshot.
func (s EntityJSONSnapshot) Components() map[string]interface{} {
	data := s.data
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
	return e.JSONSnapshot().Extra()
}

// Extra reads extra fields, excluding promoted fields, from the snapshot.
func (s EntityJSONSnapshot) Extra() map[string]interface{} {
	return jsonFieldsExcept(s.data,
		"components", "type", "subtype", "alias",
		"entity_id", "task_id", "object_id", "created_at", "updated_at", "version",
	)
}

// Task is the immutable tasking request plus its explicit lifecycle state.
type Task struct {
	TaskID            string          `json:"task_id" db:"task_id"`
	AssetID           string          `json:"asset_id" db:"asset_id"`
	Command           string          `json:"command" db:"command"`
	Input             json.RawMessage `json:"input" db:"input"`
	Status            string          `json:"status" db:"status"`
	Progress          *float64        `json:"progress,omitempty" db:"progress"`
	Output            json.RawMessage `json:"output,omitempty" db:"output"`
	CompletionAttempt json.RawMessage `json:"-" db:"completion_attempt"`
	Failure           json.RawMessage `json:"failure,omitempty" db:"failure"`
	Cancellation      json.RawMessage `json:"cancellation,omitempty" db:"cancellation"`
	IdempotencyKey    string          `json:"-" db:"idempotency_key"`
	RuntimeID         string          `json:"-" db:"runtime_id"`
	CreatedAt         time.Time       `json:"created_at" db:"created_at"`
	AcknowledgedAt    *time.Time      `json:"acknowledged_at,omitempty" db:"acknowledged_at"`
	StartedAt         *time.Time      `json:"started_at,omitempty" db:"started_at"`
	FinishedAt        *time.Time      `json:"finished_at,omitempty" db:"finished_at"`
	UpdatedAt         time.Time       `json:"updated_at" db:"updated_at"`
	Version           int64           `json:"-" db:"version"`
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

	jsonCache jsonBlobCache
}

func (o *MediaObject) decodedJSON() map[string]interface{} {
	return o.jsonCache.decoded(o.JSON, "object_id", o.ObjectID, "media object")
}

// ObjectJSONSnapshot owns one defensive copy of a stored JSON document.
// Maps and slices returned by its methods belong to this snapshot; mutating them
// cannot change the model cache or another snapshot.
type ObjectJSONSnapshot struct {
	data map[string]interface{}
}

// JSONSnapshot copies the decoded document once for reading multiple fields.
func (o *MediaObject) JSONSnapshot() ObjectJSONSnapshot {
	return ObjectJSONSnapshot{data: o.decodedJSON()}
}

// DecodedJSON returns a deep copy of the media object JSON blob.
func (o *MediaObject) DecodedJSON() map[string]interface{} {
	return o.decodedJSON()
}

// GetSizeBytes returns the size_bytes from the JSON blob.
func (o *MediaObject) GetSizeBytes() *int64 {
	return o.JSONSnapshot().SizeBytes()
}

// SizeBytes preserves integer precision and rejects negative, non-integer,
// or overflowing values.
func (s ObjectJSONSnapshot) SizeBytes() *int64 {
	data := s.data
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
	return nil
}

// GetUsageHints returns the usage_hints from the JSON blob.
func (o *MediaObject) GetUsageHints() []string {
	return o.JSONSnapshot().UsageHints()
}

// UsageHints reads string usage hints from the snapshot.
func (s ObjectJSONSnapshot) UsageHints() []string {
	data := s.data
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
	return o.JSONSnapshot().Bucket()
}

// Bucket reads the storage bucket from the snapshot.
func (s ObjectJSONSnapshot) Bucket() *string {
	data := s.data
	if data == nil {
		return nil
	}
	if bucket, ok := data["bucket"].(string); ok {
		return &bucket
	}
	return nil
}

// GetExtra returns extra fields from the JSON blob (excluding promoted fields).
func (o *MediaObject) GetExtra() map[string]interface{} {
	return o.JSONSnapshot().Extra()
}

// IsObjectPromotedJSONField identifies fields owned by the object blob contract.
// Reads additionally exclude row metadata; writes retain their separate metadata policy.
func IsObjectPromotedJSONField(key string) bool {
	switch key {
	case "path", "content_type", "type", "size_bytes", "usage_hints", "bucket", "referenced_by", "version":
		return true
	default:
		return false
	}
}

// Extra reads extra fields, excluding promoted fields and row metadata, from the snapshot.
func (s ObjectJSONSnapshot) Extra() map[string]interface{} {
	var extra map[string]interface{}
	for key, value := range s.data {
		if IsObjectPromotedJSONField(key) || key == "object_id" || key == "created_at" || key == "updated_at" {
			continue
		}
		if extra == nil {
			extra = make(map[string]interface{})
		}
		extra[key] = value
	}
	return extra
}

// GetReferencedBy returns the referenced_by from the JSON blob.
func (o *MediaObject) GetReferencedBy() []map[string]interface{} {
	return o.JSONSnapshot().ReferencedBy()
}

// ReferencedBy reads object reference maps from the snapshot.
func (s ObjectJSONSnapshot) ReferencedBy() []map[string]interface{} {
	data := s.data
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
