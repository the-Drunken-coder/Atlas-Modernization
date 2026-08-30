package actions

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"

	"github.com/the-drunken-coder/atlas/services/core/internal/models"
	"github.com/the-drunken-coder/atlas/services/core/internal/pluginid"
)

func configuredToolAssets(pluginIDs []string) map[string]string {
	assets := make(map[string]string, len(pluginIDs))
	for _, pluginID := range pluginIDs {
		assets[pluginid.DeriveToolAssetID(pluginID)] = pluginID
	}
	return assets
}

func toolAssetPluginID(entity *models.Entity) (string, bool, error) {
	var blob struct {
		Components map[string]json.RawMessage `json:"components"`
	}
	if err := json.Unmarshal(entity.JSON, &blob); err != nil {
		return "", false, fmt.Errorf("decode Entity components: %w", err)
	}
	raw, exists := blob.Components["custom_plugin"]
	if !exists {
		return "", false, nil
	}
	var ownership struct {
		PluginID string `json:"plugin_id"`
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&ownership); err != nil {
		return "", false, fmt.Errorf("decode custom_plugin ownership: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return "", false, fmt.Errorf("custom_plugin ownership contains trailing JSON")
	}
	if !pluginid.Valid(ownership.PluginID) {
		return "", false, fmt.Errorf("custom_plugin.plugin_id is invalid")
	}
	return ownership.PluginID, true, nil
}

func validateToolAsset(entity *models.Entity, configuredPluginID string) error {
	pluginID, owned, err := toolAssetPluginID(entity)
	if err != nil {
		return NewValidationError(err.Error())
	}
	if !owned {
		if configuredPluginID != "" {
			return NewValidationError("configured Plugin Tool Asset is missing custom_plugin ownership")
		}
		return nil
	}
	if entity.Type != "asset" || entity.Subtype == nil || *entity.Subtype != "tool" {
		return NewValidationError("Plugin Tool Asset must have entity_type asset and subtype tool")
	}
	if entity.EntityID != pluginid.DeriveToolAssetID(pluginID) {
		return NewValidationError("Plugin Tool Asset ID does not match custom_plugin.plugin_id")
	}
	if configuredPluginID != "" && configuredPluginID != pluginID {
		return NewValidationError("Plugin Tool Asset ownership does not match configured Plugin")
	}
	return nil
}

func equalOptionalString(left, right *string) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}
