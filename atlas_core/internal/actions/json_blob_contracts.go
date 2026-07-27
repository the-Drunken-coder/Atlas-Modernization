package actions

import (
	"bytes"
	"encoding/json"
	"fmt"

	"github.com/the-drunken-coder/atlas/atlas_core/internal/jsondecode"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/models"
)

const maxStoredJSONBlobBytes = 1 * 1024 * 1024

type jsonBlobDecodeMode int

const (
	jsonBlobDecodeDefault jsonBlobDecodeMode = iota
	// Objects keep integer blob fields as json.Number so size_bytes can round-trip
	// without float64 precision loss during patch-time merge/validation.
	jsonBlobDecodeUseNumber
)

type jsonBlobPatch struct {
	rawMessage      json.RawMessage
	decodeMode      jsonBlobDecodeMode
	decodeError     string
	components      map[string]interface{}
	mergeComponents func(map[string]interface{}, map[string]interface{}) error
	extra           map[string]interface{}
	removeExtraKeys []string
	promotedFields  models.BlobFieldSet
	apply           func(map[string]interface{}) error
	validate        func(map[string]interface{}) error
}

func patchValidatedJSONBlob(patch jsonBlobPatch) ([]byte, error) {
	blob, err := decodeJSONBlobForPatch(patch.rawMessage, patch.decodeMode)
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

func mergeBlobExtraFields(blob map[string]interface{}, extra map[string]interface{}, promoted models.BlobFieldSet) {
	for key, value := range extra {
		if !promoted.Contains(key) {
			blob[key] = value
		}
	}
}

func removeBlobExtraKeys(blob map[string]interface{}, promoted models.BlobFieldSet, keys ...string) {
	for _, key := range keys {
		if promoted.Contains(key) {
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
	rawStored, hadStored := blob[string(models.BlobFieldComponents)]
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
	blob[string(models.BlobFieldComponents)] = existingComponents
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
