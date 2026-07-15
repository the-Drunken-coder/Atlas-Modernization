package actions

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	commandcatalog "github.com/the-drunken-coder/atlas/atlas_core/command_catalog"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/models"
)

// PublishCommandCatalog exposes Core's embedded command catalog through the
// object API used for command discovery.
func (a *ObjectActions) PublishCommandCatalog(ctx context.Context) error {
	catalogJSON, err := commandcatalog.JSON()
	if err != nil {
		return fmt.Errorf("read embedded command catalog: %w", err)
	}

	var catalogData map[string]interface{}
	if err := json.Unmarshal(catalogJSON, &catalogData); err != nil {
		return fmt.Errorf("decode embedded command catalog: %w", err)
	}
	existing, err := a.Get(ctx, commandcatalog.ObjectID)
	if err == nil && commandCatalogObjectMatches(existing, catalogData, int64(len(catalogJSON)), a.storage.Bucket()) {
		return nil
	}
	var notFound *NotFoundError
	if err != nil && !errors.As(err, &notFound) {
		return fmt.Errorf("read published command catalog: %w", err)
	}

	usageHint := commandcatalog.ObjectID
	_, err = a.Upload(
		ctx,
		commandcatalog.ObjectID,
		bytes.NewReader(catalogJSON),
		int64(len(catalogJSON)),
		"application/json",
		commandcatalog.ObjectID,
		&usageHint,
	)
	if err != nil {
		return fmt.Errorf("upload embedded command catalog: %w", err)
	}

	if _, err := a.Update(ctx, commandcatalog.ObjectID, UpdateObjectParams{Extra: catalogData}); err != nil {
		return fmt.Errorf("publish embedded command catalog metadata: %w", err)
	}
	return nil
}

func commandCatalogObjectMatches(object *models.MediaObject, catalogData map[string]interface{}, size int64, bucket string) bool {
	if object == nil {
		return false
	}
	storedSize := object.GetSizeBytes()
	storedBucket := object.GetBucket()
	if object.Path == nil || strings.TrimSpace(*object.Path) == "" ||
		object.ContentType == nil || *object.ContentType != "application/json" ||
		object.Type == nil || *object.Type != commandcatalog.ObjectID ||
		storedSize == nil || *storedSize != size || storedBucket == nil || *storedBucket != bucket {
		return false
	}
	usageHints := object.GetUsageHints()
	if len(usageHints) != 1 || usageHints[0] != commandcatalog.ObjectID {
		return false
	}

	expectedPayload := make(map[string]interface{}, len(catalogData)-1)
	actualPayload := object.GetPayload()
	actualCatalogPayload := make(map[string]interface{}, len(catalogData)-1)
	for key, value := range catalogData {
		if key != "type" {
			expectedPayload[key] = value
			actualCatalogPayload[key] = actualPayload[key]
		}
	}
	expectedJSON, expectedErr := json.Marshal(expectedPayload)
	actualJSON, actualErr := json.Marshal(actualCatalogPayload)
	return expectedErr == nil && actualErr == nil && bytes.Equal(actualJSON, expectedJSON)
}
