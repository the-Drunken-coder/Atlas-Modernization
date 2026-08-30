package actions

import (
	"context"
	"testing"
	"time"

	protocol "github.com/the-drunken-coder/atlas/packages/protocol/generated/go/atlasprotocol"
	"github.com/the-drunken-coder/atlas/services/core/internal/pluginid"
)

func TestPluginToolAssetOwnershipAndDeletionBoundary(t *testing.T) {
	pool := openActionsTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pluginID := "reference"
	assetID := pluginid.DeriveToolAssetID(pluginID)
	defer cleanupFinalBlobValidationRowsWithTimeout(t, pool, assetID, "")

	configuredEntities := NewEntityActionsWithPlugins(pool, []string{pluginID})
	if _, err := configuredEntities.Create(ctx, CreateEntityParams{
		EntityID: assetID, EntityType: "asset", Subtype: "tool",
		Components: map[string]interface{}{"custom_plugin": map[string]interface{}{"plugin_id": pluginID}},
	}); err != nil {
		t.Fatalf("create Tool Asset: %v", err)
	}
	tasks := NewTaskActionsWithCatalogAndPlugins(pool, fixtureTaskCatalog(t), []string{pluginID})
	if err := tasks.BeginRuntimeRegistration(ctx, assetID, "plugin-runtime"); err != nil {
		t.Fatalf("register Tool Asset runtime: %v", err)
	}
	if err := tasks.CompleteRuntimeRegistration(ctx, assetID, "plugin-runtime", fixtureTaskManifest(t)); err != nil {
		t.Fatalf("ready Tool Asset runtime: %v", err)
	}
	task, _, err := tasks.Create(ctx, CreateTaskParams{
		AssetID: assetID,
		Command: "fixture.queued",
		Input:   map[string]any{"value": "tool asset"},
	}, "tool-asset-task")
	if err != nil {
		t.Fatalf("create Tool Asset Task: %v", err)
	}

	track := "track"
	if _, err := configuredEntities.Update(ctx, assetID, UpdateEntityParams{EntityType: &track}); err == nil {
		t.Fatal("PATCH changed Tool Asset entity_type after runtime registration")
	}
	otherSubtype := "vehicle"
	if _, err := configuredEntities.Update(ctx, assetID, UpdateEntityParams{Subtype: &otherSubtype}); err == nil {
		t.Fatal("PATCH changed Tool Asset subtype after runtime registration")
	}
	if _, err := configuredEntities.Update(ctx, assetID, UpdateEntityParams{
		Components: map[string]interface{}{"custom_plugin": map[string]interface{}{"plugin_id": "other"}},
	}); err == nil {
		t.Fatal("component mutation changed Tool Asset ownership after runtime registration")
	}
	if err := configuredEntities.Delete(ctx, assetID); err == nil {
		t.Fatal("configured Plugin Tool Asset was deleted")
	}
	if err := NewEntityActions(pool).Delete(ctx, assetID); err == nil {
		t.Fatal("Tool Asset with a nonterminal Task was deleted after Plugin removal")
	}
	if _, err := tasks.Cancel(ctx, task.TaskID, protocol.TaskCancellation{
		Code:    protocol.TaskCancellationCodeRequested,
		Message: "Plugin removed",
	}); err != nil {
		t.Fatalf("cancel Tool Asset Task: %v", err)
	}
	if err := NewEntityActions(pool).Delete(ctx, assetID); err != nil {
		t.Fatalf("delete Tool Asset after Plugin removal and terminal Tasks: %v", err)
	}
}

func TestPluginToolAssetRegistrationRejectsOwnershipConflicts(t *testing.T) {
	pool := openActionsTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pluginID := "reference"
	assetID := pluginid.DeriveToolAssetID(pluginID)
	defer cleanupFinalBlobValidationRowsWithTimeout(t, pool, assetID, "")

	if _, err := NewEntityActions(pool).Create(ctx, CreateEntityParams{
		EntityID: assetID, EntityType: "asset", Subtype: "tool",
		Components: map[string]interface{}{"custom_plugin": map[string]interface{}{"plugin_id": "other"}},
	}); err != nil {
		t.Fatalf("create conflicting Tool Asset: %v", err)
	}
	if err := NewTaskActionsWithPlugins(pool, []string{pluginID}).BeginRuntimeRegistration(ctx, assetID, "plugin-runtime"); err == nil {
		t.Fatal("runtime registration accepted conflicting Tool Asset ownership")
	}
}

func TestRegisteredNonPluginAssetCanChangeSubtype(t *testing.T) {
	pool := openActionsTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	assetID := "non_plugin_subtype_fixture"
	defer cleanupFinalBlobValidationRowsWithTimeout(t, pool, assetID, "")

	entities := NewEntityActions(pool)
	if _, err := entities.Create(ctx, CreateEntityParams{
		EntityID: assetID, EntityType: "asset", Subtype: "vehicle", Components: map[string]interface{}{},
	}); err != nil {
		t.Fatalf("create regular Asset: %v", err)
	}
	tasks := NewTaskActionsWithCatalog(pool, fixtureTaskCatalog(t))
	if err := tasks.BeginRuntimeRegistration(ctx, assetID, "regular-runtime"); err != nil {
		t.Fatalf("register regular Asset runtime: %v", err)
	}
	if err := tasks.CompleteRuntimeRegistration(ctx, assetID, "regular-runtime", fixtureTaskManifest(t)); err != nil {
		t.Fatalf("ready regular Asset runtime: %v", err)
	}

	subtype := "aircraft"
	updated, err := entities.Update(ctx, assetID, UpdateEntityParams{Subtype: &subtype})
	if err != nil {
		t.Fatalf("change regular Asset subtype: %v", err)
	}
	if updated.Subtype == nil || *updated.Subtype != subtype {
		t.Fatalf("regular Asset subtype = %v, want %q", updated.Subtype, subtype)
	}
}
