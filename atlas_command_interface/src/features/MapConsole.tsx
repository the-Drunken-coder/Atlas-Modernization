import type { EntityResource } from "@the-drunken-coder/atlas-sdk";
import { lazy, Suspense, useCallback, useEffect, useMemo, useReducer, useState } from "react";
import type { MapSourceConfig } from "../app/config.js";
import type { CommandCatalog } from "../atlas/command-model.js";
import { type CommandAvailability, commandsForTargeting } from "../atlas/command-targeting.js";
import { type EntityKind, entityKind } from "../atlas/entities.js";
import type { UiGeometry } from "../atlas/geometry.js";
import { countsByKind, entitiesByKind, getEntity } from "../atlas/selectors.js";
import type { AtlasSnapshot } from "../atlas/store.js";
import { useAtlas } from "../state/atlas-context.js";
import {
  initialSidebarState,
  type ListKind,
  listForKind,
  type SidebarState,
  sidebarReducer
} from "../state/selection.js";
import { ConnectionBadge } from "../ui/ConnectionBadge.js";
import { AppShell } from "../ui/layout/AppShell.js";
import { SidebarPanel } from "../ui/layout/SidebarPanel.js";
import { SidebarRail } from "../ui/layout/SidebarRail.js";
import type { MapCameraCommand } from "../ui/map/interaction/map-camera.js";
import { buildMapSources } from "../ui/map/rendering/map-sources.js";
import type { MapReticleTarget } from "../ui/map/view/MapView.js";
import { Button, SelectField } from "../ui/primitives/controls.js";
import { ContextMenu, type MenuItemDef } from "../ui/primitives/Menu.js";
import { APIKeysPanel } from "./admin/APIKeysPanel.js";
import { AssetInspector } from "./assets/AssetInspector.js";
import { CommandForm } from "./commands/CommandForm.js";
import { CommandList } from "./commands/CommandList.js";
import { useCommandFlow } from "./commands/use-command-flow.js";
import { EntityList } from "./EntityList.js";
import { GeofeatureInspector } from "./geofeatures/GeofeatureInspector.js";
import { type GeometryEditState, useGeometryEdit } from "./geofeatures/use-geometry-edit.js";
import { TrackInspector } from "./tracks/TrackInspector.js";

const LIST_TITLES: Record<ListKind, string> = {
  assets: "Assets",
  tracks: "Tracks",
  geofeatures: "Geo Features",
  commands: "Commands",
  apiKeys: "API Keys"
};

const MapView = lazy(() => import("../ui/map/view/MapView.js").then((module) => ({ default: module.MapView })));

const KIND_TITLES: Record<EntityKind, string> = { asset: "Asset", track: "Track", geofeature: "Geo Feature" };

export function MapConsole() {
  const atlas = useAtlas();
  const { snapshot, catalog } = atlas;
  const [sidebar, dispatch] = useReducer(sidebarReducer, initialSidebarState);

  const [selectedMapSourceId, setSelectedMapSourceId] = useState<string>();

  const selection = sidebar.selection;
  const selectedEntity = getEntity(snapshot, selection?.id);
  const selectedId = selection?.id;
  const commandFlow = useCommandFlow({ catalog, selectedEntity, selectedId, submitCommand: atlas.submitCommand });
  const geometryEdit = useGeometryEdit({ selectedEntity, selectedId, updateGeometry: atlas.updateGeometry });
  const { edit, saving, saveError } = geometryEdit;
  const { mapMenu, commandForm, submitting, submitError } = commandFlow;

  useEffect(() => {
    const config = atlas.config;
    if (!config) return;
    setSelectedMapSourceId((current) =>
      current && config.mapSources.some((source) => source.id === current && source.style)
        ? current
        : config.defaultMapSourceId
    );
  }, [atlas.config]);

  const sources = useMemo(
    () => buildMapSources(Object.values(snapshot.entities), selectedId),
    [snapshot.entities, selectedId]
  );
  const counts = useMemo(() => countsByKind(snapshot), [snapshot]);
  const handleMapStyleSwitchError = useCallback(
    ({ activeStyleId }: { failedStyleId: string; activeStyleId: string }) => {
      const activeSource = atlas.config?.mapSources.find((source) => source.id === activeStyleId);
      if (activeSource) setSelectedMapSourceId(activeSource.id);
    },
    [atlas.config]
  );
  const focusTarget = useMemo(() => entityReticleTarget(selectedEntity), [selectedEntity]);
  // Camera intent is derived from the sidebar's claim, not the snapshot, so
  // its identity only changes when the user asks to go somewhere.
  const cameraCommand = useMemo<MapCameraCommand | null>(
    () =>
      sidebar.focusRequest
        ? { seq: sidebar.focusRequest.seq, target: { type: "entity", id: sidebar.focusRequest.id } }
        : null,
    [sidebar.focusRequest]
  );

  const selectEntityById = useCallback(
    (id: string) => {
      const entity = snapshot.entities[id];
      if (!entity) return;
      const kind = entityKind(entity);
      if (kind === "other") return;
      dispatch({ type: "selectEntity", kind, id, origin: "map" });
    },
    [snapshot.entities]
  );

  if (atlas.status === "loading") {
    return (
      <div className="app-loading">
        <span>Connecting to Atlas Core…</span>
      </div>
    );
  }
  if (atlas.status === "error") {
    return (
      <div className="app-error" role="alert">
        <span>Could not connect to Atlas Core.</span>
        <code>{atlas.error}</code>
        <Button variant="primary" onClick={atlas.reconnect}>
          Retry connection
        </Button>
      </div>
    );
  }
  if (!atlas.config) {
    return (
      <div className="app-error">
        <span>Command interface configuration is unavailable.</span>
      </div>
    );
  }
  if (atlas.config.mapSources.length === 0) {
    return (
      <div className="app-error">
        <span>No map sources are configured.</span>
      </div>
    );
  }

  const activeList: ListKind | null =
    sidebar.view.mode === "list" ? sidebar.view.list : selection ? listForKind(selection.kind) : null;
  const selectedMapSource =
    availableMapSource(atlas.config.mapSources.find((source) => source.id === selectedMapSourceId)) ??
    availableMapSource(atlas.config.mapSources.find((source) => source.id === atlas.config?.defaultMapSourceId));
  const mapSourcePickerValue = selectedMapSource?.id ?? selectedMapSourceId ?? atlas.config.defaultMapSourceId;

  const mapCommands: MenuItemDef[] =
    mapMenu && selectedEntity && catalog
      ? commandsForTargeting(catalog, selectedEntity, "map_point").map((availability) => ({
          key: availability.command.id,
          title: availability.command.name,
          sub: availability.requiresForm ? "needs parameters" : undefined,
          disabled: availability.disabled,
          disabledReason: availability.disabledReason,
          onSelect: () => commandFlow.pickMapCommand(availability, { lat: mapMenu.lat, lng: mapMenu.lng })
        }))
      : [];

  return (
    <>
      <AppShell
        collapsed={sidebar.collapsed}
        rail={
          <SidebarRail
            collapsed={sidebar.collapsed}
            activeList={activeList}
            counts={counts}
            onSelectList={(list) => dispatch({ type: "openList", list })}
            onToggleCollapsed={() => dispatch({ type: "toggleCollapsed" })}
          />
        }
        panel={
          <SidebarPanel
            title={panelTitle(sidebar, selection?.kind)}
            onBack={sidebar.view.mode === "inspector" ? () => dispatch({ type: "back" }) : undefined}
            onCollapse={() => dispatch({ type: "setCollapsed", collapsed: true })}
          >
            <PanelBody
              snapshot={snapshot}
              sidebar={sidebar}
              selectedEntity={selectedEntity}
              catalog={catalog}
              edit={edit}
              saving={saving}
              saveError={saveError}
              onSelectEntity={(entity) => {
                const kind = entityKind(entity);
                if (kind === "other") return;
                dispatch({ type: "selectEntity", kind, id: entity.entity_id, origin: "sidebar" });
              }}
              onPickCommand={commandFlow.pickSidebarCommand}
              onStartEdit={geometryEdit.startEdit}
              onChangeDraft={geometryEdit.changeDraft}
              onSaveEdit={() => void geometryEdit.saveEdit()}
              onCancelEdit={geometryEdit.cancelEdit}
            />
          </SidebarPanel>
        }
        map={
          <>
            <div className="map-world-frame">
              <div className="map-stage">
                {selectedMapSource ? (
                  <Suspense
                    fallback={
                      <div className="app-loading" role="status">
                        <span>Loading map workspace…</span>
                      </div>
                    }
                  >
                    <MapView
                      sources={sources}
                      styleId={selectedMapSource.id}
                      style={selectedMapSource.style}
                      selectedId={selectedId}
                      editing={
                        edit
                          ? {
                              geometry: edit.draft,
                              onChange: geometryEdit.changeDraft
                            }
                          : undefined
                      }
                      focusTarget={focusTarget}
                      cameraCommand={cameraCommand}
                      onSelectEntity={selectEntityById}
                      onMapContextMenu={commandFlow.onMapContextMenu}
                      onBackgroundClick={() => {
                        commandFlow.closeMapMenu();
                        dispatch({ type: "clearSelection" });
                      }}
                      onStyleSwitchError={handleMapStyleSwitchError}
                    />
                  </Suspense>
                ) : (
                  <div className="app-error" role="alert">
                    <span>The configured default map source is unavailable.</span>
                  </div>
                )}
                <ConnectionBadge health={atlas.health} error={atlas.connectionError} onRetry={atlas.reconnect} />
                <MapSourcePicker
                  sources={atlas.config.mapSources}
                  value={mapSourcePickerValue}
                  onChange={setSelectedMapSourceId}
                />
              </div>
            </div>
          </>
        }
      />

      {mapMenu ? (
        <ContextMenu
          x={mapMenu.x}
          y={mapMenu.y}
          header={`Commands · ${mapMenu.lat.toFixed(4)}, ${mapMenu.lng.toFixed(4)}`}
          items={mapCommands}
          emptyLabel="No position commands"
          onClose={commandFlow.closeMapMenu}
        />
      ) : null}

      {submitting && !commandForm ? (
        <div className="banner banner--info" role="status">
          Command submission pending…
        </div>
      ) : null}

      {commandForm && selectedEntity ? (
        <CommandForm
          command={commandForm.availability.command}
          targeting={commandForm.availability.targeting}
          formParameters={commandForm.availability.formParameters}
          mapPoint={commandForm.mapPoint}
          submitting={submitting}
          error={submitError}
          onCancel={commandFlow.dismissCommandForm}
          onSubmit={(parameters) => void commandFlow.submit(commandForm.availability, parameters, commandForm)}
        />
      ) : null}
    </>
  );
}

function MapSourcePicker({
  sources,
  value,
  onChange
}: {
  sources: MapSourceConfig[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="map-overlay-tr map-source-control">
      <SelectField
        label="Map"
        value={value}
        options={sources.map((source) => ({
          label: source.unavailableReason ? `${source.label} (${source.unavailableReason})` : source.label,
          value: source.id,
          disabled: !source.style
        }))}
        onChange={(event) => {
          const source = sources.find((entry) => entry.id === event.currentTarget.value);
          if (source?.style) onChange(source.id);
        }}
      />
    </div>
  );
}

type AvailableMapSourceConfig = MapSourceConfig & { style: NonNullable<MapSourceConfig["style"]> };

function availableMapSource(source: MapSourceConfig | undefined): AvailableMapSourceConfig | undefined {
  return source?.style ? (source as AvailableMapSourceConfig) : undefined;
}

type PanelBodyProps = {
  snapshot: AtlasSnapshot;
  sidebar: SidebarState;
  selectedEntity?: EntityResource;
  catalog?: CommandCatalog;
  edit: GeometryEditState | null;
  saving: boolean;
  saveError?: string;
  onSelectEntity: (entity: EntityResource) => void;
  onPickCommand: (availability: CommandAvailability) => void;
  onStartEdit: () => void;
  onChangeDraft: (geometry: UiGeometry) => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
};

function PanelBody(props: PanelBodyProps) {
  const { snapshot, sidebar, selectedEntity, catalog } = props;

  if (sidebar.view.mode === "list") {
    return <ListBody list={sidebar.view.list} {...props} />;
  }

  if (!selectedEntity) {
    return <div className="panel__empty">This item is no longer available.</div>;
  }

  const kind = entityKind(selectedEntity);
  if (kind === "asset") {
    return (
      <AssetInspector
        entity={selectedEntity}
        snapshot={snapshot}
        catalog={catalog}
        onPickCommand={props.onPickCommand}
      />
    );
  }
  if (kind === "track") {
    return <TrackInspector entity={selectedEntity} />;
  }
  if (kind === "geofeature") {
    return (
      <GeofeatureInspector
        entity={selectedEntity}
        editing={props.edit?.entityId === selectedEntity.entity_id}
        draft={props.edit?.draft}
        saving={props.saving}
        saveError={props.saveError}
        onStartEdit={props.onStartEdit}
        onChangeDraft={props.onChangeDraft}
        onSave={props.onSaveEdit}
        onCancel={props.onCancelEdit}
      />
    );
  }
  return <div className="panel__empty">Unsupported entity type.</div>;
}

function ListBody({
  list,
  snapshot,
  selectedEntity,
  catalog,
  onSelectEntity,
  onPickCommand
}: { list: ListKind } & PanelBodyProps) {
  if (list === "commands") {
    if (selectedEntity && entityKind(selectedEntity) === "asset") {
      return (
        <div style={{ padding: 12 }}>
          <CommandList
            availabilities={catalog ? commandsForTargeting(catalog, selectedEntity, "none") : []}
            onPick={onPickCommand}
            emptyLabel={catalog ? "No commands available" : "Command catalog unavailable"}
          />
        </div>
      );
    }
    return <div className="panel__empty">Select an asset to issue commands.</div>;
  }
  if (list === "apiKeys") {
    return <APIKeysPanel />;
  }

  const kind: EntityKind = list === "assets" ? "asset" : list === "tracks" ? "track" : "geofeature";
  return (
    <EntityList
      entities={entitiesByKind(snapshot, kind)}
      selectedId={selectedEntity?.entity_id}
      emptyLabel={`No ${LIST_TITLES[list].toLowerCase()} yet`}
      onSelect={onSelectEntity}
    />
  );
}

function entityReticleTarget(entity: EntityResource | undefined): MapReticleTarget | null {
  return entity && entityKind(entity) !== "other" ? { type: "entity", id: entity.entity_id } : null;
}

function panelTitle(sidebar: SidebarState, selectionKind?: EntityKind): string {
  if (sidebar.view.mode === "list") return LIST_TITLES[sidebar.view.list];
  return selectionKind ? KIND_TITLES[selectionKind] : "Inspector";
}
