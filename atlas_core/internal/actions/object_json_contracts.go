package actions

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/the-drunken-coder/atlas/atlas_core/internal/models"
	protocol "github.com/the-drunken-coder/atlas/atlas_protocol/generated/go/atlasprotocol"
)

func objectJSONPatch(raw json.RawMessage, params UpdateObjectParams, storage objectStorage) jsonBlobPatch {
	return jsonBlobPatch{
		rawMessage:      raw,
		decodeMode:      jsonBlobDecodeUseNumber,
		decodeError:     "existing object json is corrupt or invalid",
		extra:           params.Extra,
		removeExtraKeys: params.RemoveExtraKeys,
		promotedFields:  models.ObjectPromotedBlobFields,
		validate:        ValidateObjectBlob,
		apply: func(blob map[string]interface{}) error {
			if params.SizeBytes != nil {
				blob[string(models.ObjectBlobFieldSizeBytes)] = *params.SizeBytes
			}
			if params.UsageHints != nil {
				blob[string(models.ObjectBlobFieldUsageHints)] = params.UsageHints
			}
			if params.ReferencedBy != nil {
				blob[string(models.ObjectBlobFieldReferencedBy)] = params.ReferencedBy
			}
			applyConfiguredObjectBucket(blob, storage)
			return nil
		},
	}
}

func applyConfiguredObjectBucket(blob map[string]interface{}, storageClient objectStorage) {
	if storageClient == nil {
		delete(blob, string(models.ObjectBlobFieldBucket))
		return
	}
	bucket := strings.TrimSpace(storageClient.Bucket())
	if bucket == "" {
		delete(blob, string(models.ObjectBlobFieldBucket))
		return
	}
	blob[string(models.ObjectBlobFieldBucket)] = bucket
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
