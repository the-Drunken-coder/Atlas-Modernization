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

// Entity represents an entity in the system (asset, track, geofeature, etc.).
type Entity struct {
	EntityID  string          `json:"entity_id" db:"entity_id"`
	Type      string          `json:"type" db:"type"`
	Subtype   *string         `json:"subtype,omitempty" db:"subtype"`
	Alias     *string         `json:"alias,omitempty" db:"alias"`
	JSON      json.RawMessage `json:"-" db:"json"`
	CreatedAt time.Time       `json:"created_at" db:"created_at"`
	UpdatedAt time.Time       `json:"updated_at" db:"updated_at"`

	jsonMu   sync.Mutex
	jsonInit bool
	jsonRaw  []byte
	jsonData map[string]interface{}
	jsonErr  error
}

func (e *Entity) decodedJSON() map[string]interface{} {
	e.jsonMu.Lock()
	defer e.jsonMu.Unlock()

	if e.jsonInit && bytes.Equal(e.jsonRaw, e.JSON) {
		if e.jsonErr != nil {
			return nil
		}
		return deepCopyMap(e.jsonData)
	}

	e.jsonRaw = append(e.jsonRaw[:0], e.JSON...)
	e.jsonData = nil
	e.jsonErr = nil
	e.jsonInit = false
	if e.JSON == nil {
		e.jsonInit = true
		return nil
	}

	var data map[string]interface{}
	if err := json.Unmarshal(e.JSON, &data); err != nil {
		e.jsonErr = err
		e.jsonInit = true
		log.Error().
			Err(err).
			Str("entity_id", e.EntityID).
			Str("json_meta", jsonLogMeta(e.JSON, e.EntityID)).
			Msg("Failed to unmarshal entity JSON - database corruption suspected")
		return nil
	}
	e.jsonData = data
	e.jsonInit = true
	return deepCopyMap(e.jsonData)
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
	if data == nil {
		return nil
	}
	extra := make(map[string]interface{})
	for k, v := range data {
		if k != "components" && k != "type" && k != "subtype" && k != "alias" &&
			k != "entity_id" && k != "task_id" && k != "object_id" && k != "created_at" && k != "updated_at" {
			extra[k] = v
		}
	}
	if len(extra) == 0 {
		return nil
	}
	return extra
}

// Task represents a task assigned to an entity.
type Task struct {
	TaskID    string          `json:"task_id" db:"task_id"`
	Status    string          `json:"status" db:"status"`
	EntityID  *string         `json:"entity_id,omitempty" db:"entity_id"`
	JSON      json.RawMessage `json:"-" db:"json"`
	CreatedAt time.Time       `json:"created_at" db:"created_at"`
	UpdatedAt time.Time       `json:"updated_at" db:"updated_at"`

	jsonMu   sync.Mutex
	jsonInit bool
	jsonRaw  []byte
	jsonData map[string]interface{}
	jsonErr  error
}

func (t *Task) decodedJSON() map[string]interface{} {
	t.jsonMu.Lock()
	defer t.jsonMu.Unlock()

	if t.jsonInit && bytes.Equal(t.jsonRaw, t.JSON) {
		if t.jsonErr != nil {
			return nil
		}
		return deepCopyMap(t.jsonData)
	}

	t.jsonRaw = append(t.jsonRaw[:0], t.JSON...)
	t.jsonData = nil
	t.jsonErr = nil
	t.jsonInit = false
	if t.JSON == nil {
		t.jsonInit = true
		return nil
	}

	var data map[string]interface{}
	if err := json.Unmarshal(t.JSON, &data); err != nil {
		t.jsonErr = err
		t.jsonInit = true
		log.Error().
			Err(err).
			Str("task_id", t.TaskID).
			Str("json_meta", jsonLogMeta(t.JSON, t.TaskID)).
			Msg("Failed to unmarshal task JSON - database corruption suspected")
		return nil
	}
	t.jsonData = data
	t.jsonInit = true
	return deepCopyMap(t.jsonData)
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
	if data == nil {
		return nil
	}
	extra := make(map[string]interface{})
	for k, v := range data {
		if k != "components" && k != "status" && k != "entity_id" && k != "task_id" &&
			k != "object_id" && k != "created_at" && k != "updated_at" {
			extra[k] = v
		}
	}
	if len(extra) == 0 {
		return nil
	}
	return extra
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

	jsonMu   sync.Mutex
	jsonInit bool
	jsonRaw  []byte
	jsonData map[string]interface{}
	jsonErr  error
}

func (o *MediaObject) decodedJSON() map[string]interface{} {
	o.jsonMu.Lock()
	defer o.jsonMu.Unlock()

	if o.jsonInit && bytes.Equal(o.jsonRaw, o.JSON) {
		if o.jsonErr != nil {
			return nil
		}
		return deepCopyMap(o.jsonData)
	}

	o.jsonRaw = append(o.jsonRaw[:0], o.JSON...)
	o.jsonData = nil
	o.jsonErr = nil
	o.jsonInit = false
	if o.JSON == nil {
		o.jsonInit = true
		return nil
	}

	// UseNumber keeps numeric values as json.Number instead of float64 so large
	// integer fields such as size_bytes round-trip exactly above 2^53. See
	// GetSizeBytes and docs/problems/2026-05-29-size-bytes-precision-loss.md.
	var data map[string]interface{}
	decoder := json.NewDecoder(bytes.NewReader(o.JSON))
	decoder.UseNumber()
	if err := decoder.Decode(&data); err != nil {
		o.jsonErr = err
		o.jsonInit = true
		log.Error().
			Err(err).
			Str("object_id", o.ObjectID).
			Str("json_meta", jsonLogMeta(o.JSON, o.ObjectID)).
			Msg("Failed to unmarshal media object JSON - database corruption suspected")
		return nil
	}
	// Reject trailing data after the top-level value. Unlike json.Unmarshal (used
	// for entities/tasks), a streaming Decoder ignores anything after the first
	// value, which would silently accept corrupt blobs like `{...}<garbage>`.
	if decoder.More() {
		o.jsonErr = fmt.Errorf("unexpected trailing data after media object JSON")
		o.jsonInit = true
		log.Error().
			Err(o.jsonErr).
			Str("object_id", o.ObjectID).
			Str("json_meta", jsonLogMeta(o.JSON, o.ObjectID)).
			Msg("Failed to unmarshal media object JSON - database corruption suspected")
		return nil
	}
	o.jsonData = data
	o.jsonInit = true
	return deepCopyMap(o.jsonData)
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
	if data == nil {
		return nil
	}
	payload := make(map[string]interface{})
	for k, v := range data {
		if k != "path" && k != "content_type" && k != "type" && k != "size_bytes" && k != "usage_hints" && k != "bucket" && k != "referenced_by" &&
			k != "object_id" && k != "created_at" && k != "updated_at" {
			payload[k] = v
		}
	}
	if len(payload) == 0 {
		return nil
	}
	return payload
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
