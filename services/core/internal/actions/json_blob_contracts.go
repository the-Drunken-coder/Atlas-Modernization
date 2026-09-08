package actions

import (
	"bytes"
	"encoding/json"
	"fmt"

	"github.com/the-drunken-coder/atlas/services/core/internal/jsondecode"
	"github.com/the-drunken-coder/atlas/services/core/internal/models"
)

type jsonBlobField string

const maxStoredJSONBlobBytes = 1 * 1024 * 1024

const (
	jsonBlobFieldComponents jsonBlobField = "components"
	jsonBlobFieldVersion    jsonBlobField = "version"

	entityBlobFieldType    jsonBlobField = "type"
	entityBlobFieldSubtype jsonBlobField = "subtype"
	entityBlobFieldAlias   jsonBlobField = "alias"

	objectBlobFieldSizeBytes    jsonBlobField = "size_bytes"
	objectBlobFieldUsageHints   jsonBlobField = "usage_hints"
	objectBlobFieldReferencedBy jsonBlobField = "referenced_by"
)

type jsonBlobFieldFilter func(string) bool

func (f jsonBlobFieldFilter) contains(key string) bool {
	return f != nil && f(key)
}

var entityPromotedBlobFields jsonBlobFieldFilter = func(key string) bool {
	switch jsonBlobField(key) {
	case entityBlobFieldType, entityBlobFieldSubtype, entityBlobFieldAlias, jsonBlobFieldComponents, jsonBlobFieldVersion:
		return true
	default:
		return false
	}
}

var objectPromotedBlobFields jsonBlobFieldFilter = models.IsObjectPromotedJSONField

type jsonBlobPatch struct {
	rawMessage      json.RawMessage
	decodeError     string
	components      map[string]interface{}
	mergeComponents func(map[string]interface{}, map[string]interface{}) error
	extra           map[string]interface{}
	removeExtraKeys []string
	promotedFields  jsonBlobFieldFilter
	apply           func(map[string]interface{}) error
	validate        func(map[string]interface{}) error
}

func patchValidatedJSONBlob(patch jsonBlobPatch) ([]byte, error) {
	blob, err := decodeJSONBlobForPatch(patch.rawMessage)
	if err != nil {
		if patch.decodeError != "" {
			return nil, fmt.Errorf("%s: %w", patch.decodeError, err)
		}
		return nil, err
	}
	if patch.mergeComponents != nil {
		if err := patch.mergeComponents(blob, patch.components); err != nil {
			return nil, err
		}
	}
	removeBlobExtraKeys(blob, patch.promotedFields, patch.removeExtraKeys...)
	mergeBlobExtraFields(blob, patch.extra, patch.promotedFields)
	if patch.apply != nil {
		if err := patch.apply(blob); err != nil {
			return nil, err
		}
	}
	return marshalValidatedJSONBlob(blob, patch.validate)
}

func decodeJSONBlobForPatch(raw json.RawMessage) (map[string]interface{}, error) {
	if raw == nil {
		return make(map[string]interface{}), nil
	}

	var data map[string]interface{}
	// Preserve integers beyond float64's exact range during patch merges.
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := jsondecode.Decode(decoder, &data); err != nil {
		return nil, err
	}
	if data == nil {
		return make(map[string]interface{}), nil
	}
	return data, nil
}

func mergeBlobExtraFields(blob map[string]interface{}, extra map[string]interface{}, promoted jsonBlobFieldFilter) {
	for key, value := range extra {
		if !promoted.contains(key) {
			blob[key] = value
		}
	}
}

func removeBlobExtraKeys(blob map[string]interface{}, promoted jsonBlobFieldFilter, keys ...string) {
	for _, key := range keys {
		if promoted.contains(key) {
			continue
		}
		delete(blob, key)
	}
}

func mergeEntityComponents(blob map[string]interface{}, components map[string]interface{}) error {
	if components == nil {
		return nil
	}
	if err := ValidateEntityComponents(components); err != nil {
		return err
	}

	existingComponents := make(map[string]interface{})
	rawStored, hadStored := blob[string(jsonBlobFieldComponents)]
	if hadStored && rawStored != nil {
		storedMap, ok := rawStored.(map[string]interface{})
		if !ok {
			return NewValidationError("stored entity components must be an object or null")
		}
		existingComponents = storedMap
	}

	for key, value := range components {
		existingComponents[key] = mergeJSONValue(existingComponents[key], value)
	}
	if err := ValidateEntityComponents(existingComponents); err != nil {
		return err
	}
	blob[string(jsonBlobFieldComponents)] = existingComponents
	return nil
}

func marshalValidatedJSONBlob(blob map[string]interface{}, validate func(map[string]interface{}) error) ([]byte, error) {
	if err := validate(blob); err != nil {
		return nil, err
	}
	jsonBytes, err := json.Marshal(blob)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal JSON: %w", err)
	}
	if len(jsonBytes) > maxStoredJSONBlobBytes {
		return nil, NewValidationErrorWithDetails(
			"Resource JSON exceeds the stored size limit",
			[]string{fmt.Sprintf("final stored JSON must not exceed %d bytes", maxStoredJSONBlobBytes)},
		)
	}
	return jsonBytes, nil
}

// mergeJSONValue deep-merges nested map[string]interface{} values (recursive key merge).
// Non-map values, including slices and scalars, are replaced entirely by the incoming value.
func mergeJSONValue(existing, incoming interface{}) interface{} {
	existingMap, existingOK := existing.(map[string]interface{})
	incomingMap, incomingOK := incoming.(map[string]interface{})
	if !existingOK || !incomingOK {
		return incoming
	}

	merged := make(map[string]interface{}, len(existingMap))
	for key, value := range existingMap {
		merged[key] = value
	}
	for key, value := range incomingMap {
		merged[key] = mergeJSONValue(merged[key], value)
	}

	return merged
}
