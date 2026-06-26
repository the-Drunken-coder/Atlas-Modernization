package actions

import (
	"bytes"
	"encoding/json"
	"fmt"

	"github.com/the-drunken-coder/atlas/atlas_core/internal/jsondecode"
)

type jsonBlobField string

const (
	jsonBlobFieldComponents jsonBlobField = "components"
	jsonBlobFieldVersion    jsonBlobField = "version"

	entityBlobFieldType    jsonBlobField = "type"
	entityBlobFieldSubtype jsonBlobField = "subtype"
	entityBlobFieldAlias   jsonBlobField = "alias"

	taskBlobFieldStatus   jsonBlobField = "status"
	taskBlobFieldEntityID jsonBlobField = "entity_id"

	objectBlobFieldPath         jsonBlobField = "path"
	objectBlobFieldContentType  jsonBlobField = "content_type"
	objectBlobFieldType         jsonBlobField = "type"
	objectBlobFieldSizeBytes    jsonBlobField = "size_bytes"
	objectBlobFieldUsageHints   jsonBlobField = "usage_hints"
	objectBlobFieldBucket       jsonBlobField = "bucket"
	objectBlobFieldReferencedBy jsonBlobField = "referenced_by"
)

type jsonBlobFieldSet []jsonBlobField

func (s jsonBlobFieldSet) contains(key string) bool {
	for _, field := range s {
		if string(field) == key {
			return true
		}
	}
	return false
}

var (
	entityPromotedBlobFields = jsonBlobFieldSet{
		entityBlobFieldType,
		entityBlobFieldSubtype,
		entityBlobFieldAlias,
		jsonBlobFieldComponents,
		jsonBlobFieldVersion,
	}
	taskPromotedBlobFields = jsonBlobFieldSet{
		jsonBlobFieldComponents,
		taskBlobFieldStatus,
		taskBlobFieldEntityID,
		jsonBlobFieldVersion,
	}
	objectPromotedBlobFields = jsonBlobFieldSet{
		objectBlobFieldPath,
		objectBlobFieldContentType,
		objectBlobFieldType,
		objectBlobFieldSizeBytes,
		objectBlobFieldUsageHints,
		objectBlobFieldBucket,
		objectBlobFieldReferencedBy,
		jsonBlobFieldVersion,
	}
)

type jsonBlobDecodeMode int

const (
	jsonBlobDecodeDefault jsonBlobDecodeMode = iota
	jsonBlobDecodeUseNumber
)

func decodeJSONBlobForPatch(raw json.RawMessage, mode jsonBlobDecodeMode) (map[string]interface{}, error) {
	if raw == nil {
		return make(map[string]interface{}), nil
	}

	var data map[string]interface{}
	var err error
	if mode == jsonBlobDecodeUseNumber {
		decoder := json.NewDecoder(bytes.NewReader(raw))
		decoder.UseNumber()
		err = jsondecode.Decode(decoder, &data)
	} else {
		err = json.Unmarshal(raw, &data)
	}
	if err != nil {
		return nil, err
	}
	if data == nil {
		return make(map[string]interface{}), nil
	}
	return data, nil
}

func decodeObjectJSONForPatch(raw json.RawMessage) (map[string]interface{}, error) {
	return decodeJSONBlobForPatch(raw, jsonBlobDecodeUseNumber)
}

func mergeBlobExtraFields(blob map[string]interface{}, extra map[string]interface{}, promoted jsonBlobFieldSet) {
	for key, value := range extra {
		if !promoted.contains(key) {
			blob[key] = value
		}
	}
}

func removeBlobExtraKeys(blob map[string]interface{}, promoted jsonBlobFieldSet, keys ...string) {
	for _, key := range keys {
		if promoted.contains(key) {
			continue
		}
		delete(blob, key)
	}
}

func mergeEntityComponents(blob map[string]interface{}, components map[string]interface{}) error {
	return mergeBlobComponents(blob, components, ValidateEntityComponents, "entity")
}

func mergeTaskComponents(blob map[string]interface{}, components map[string]interface{}) error {
	return mergeBlobComponents(blob, components, ValidateTaskComponents, "task")
}

func mergeBlobComponents(blob map[string]interface{}, components map[string]interface{}, validate func(map[string]interface{}) error, resource string) error {
	if components == nil {
		return nil
	}
	if err := validate(components); err != nil {
		return err
	}

	existingComponents := make(map[string]interface{})
	rawStored, hadStored := blob[string(jsonBlobFieldComponents)]
	if hadStored && rawStored != nil {
		storedMap, ok := rawStored.(map[string]interface{})
		if !ok {
			return NewValidationError(fmt.Sprintf("stored %s components must be an object or null", resource))
		}
		existingComponents = storedMap
	}

	for key, value := range components {
		existingComponents[key] = mergeJSONValue(existingComponents[key], value)
	}
	if err := validate(existingComponents); err != nil {
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
