package actions

import (
	"encoding/json"
	"fmt"
	"strings"

	protocol "github.com/the-drunken-coder/atlas/atlas_protocol/generated/go/atlasprotocol"
)

func objectJSONPatch(raw json.RawMessage, params UpdateObjectParams, storage objectStorage) jsonBlobPatch {
	return jsonBlobPatch{
		rawMessage:      raw,
		decodeMode:      jsonBlobDecodeUseNumber,
		decodeError:     "existing object json is corrupt or invalid",
		extra:           params.Extra,
		removeExtraKeys: params.RemoveExtraKeys,
		promotedFields:  objectPromotedBlobFields,
		validate:        ValidateObjectBlob,
		apply: func(blob map[string]interface{}) error {
			if params.SizeBytes != nil {
				blob[string(objectBlobFieldSizeBytes)] = *params.SizeBytes
			}
			if params.UsageHints != nil {
				blob[string(objectBlobFieldUsageHints)] = params.UsageHints
			}
			if params.ReferencedBy != nil {
				blob[string(objectBlobFieldReferencedBy)] = params.ReferencedBy
			}
			applyConfiguredObjectBucket(blob, storage)
			return nil
		},
	}
}

func applyConfiguredObjectBucket(blob map[string]interface{}, storageClient objectStorage) {
	if storageClient == nil {
		delete(blob, string(objectBlobFieldBucket))
		return
	}
	bucket := strings.TrimSpace(storageClient.Bucket())
	if bucket == "" {
		delete(blob, string(objectBlobFieldBucket))
		return
	}
	blob[string(objectBlobFieldBucket)] = bucket
}

// ValidateObjectBlob validates storage-facing object metadata.
func ValidateObjectBlob(blob map[string]interface{}) error {
	result := validationResultFromErrors(protocol.ValidateObjectBlob(blob))
	if !result.HasErrors() {
		return nil
	}
	return NewValidationErrorWithDetails(
		fmt.Sprintf("Object validation failed (%d errors)", len(result.Errors)),
		result.Errors,
	)
}
