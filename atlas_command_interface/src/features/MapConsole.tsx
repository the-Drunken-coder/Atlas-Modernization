import { Callout } from "@blueprintjs/core";
import type { CommandCatalog, EntityResource, JSONValue } from "@the-drunken-coder/atlas-sdk";
import { lazy, Suspense, useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { MapSourceConfig } from "../app/config.js";
import { type CommandAvailability, commandsForTargeting } from "../atlas/command-targeting.js";
import {
  ENTITY_DESCRIPTORS,
  ENTITY_KIND_BY_LIST,
  ENTITY_KINDS,
  type EntityKind,
  entityKind
} from "../atlas/entities.js";
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
import type { MapCameraCommand, MapTarget } from "../ui/map/interaction/map-camera.js";
import { MapSourcePicker } from "../ui/map/MapSourcePicker.js";
import { buildMapSources } from "../ui/map/rendering/map-sources.js";
import type { MapReticleTarget } from "../ui/map/view/MapView.js";
import { Button, IconButton } from "../ui/primitives/controls.js";
import { WorldViewIcon } from "../ui/primitives/icons.js";
import { ContextMenu, type MenuItemDef } from "../ui/primitives/Menu.js";
import { APIKeysPanel } from "./admin/APIKeysPanel.js";
import { AssetInspector } from "./assets/AssetInspector.js";
import { CommandList } from "./commands/CommandList.js";
import { type CommandFormState, useCommandFlow } from "./commands/use-command-flow.js";
import { EntityList } from "./EntityList.js";
import { GeofeatureInspector } from "./geofeatures/GeofeatureInspector.js";
import { type GeometryEditState, useGeometryEdit } from "./geofeatures/use-geometry-edit.js";
import { PlacesPanel } from "./places/PlacesPanel.js";
import { createMapTilerPlaceSearch, type PlaceSearch } from "./places/place-search.js";
import { TrackInspector } from "./tracks/TrackInspector.js";

const LIST_TITLES = Object.fromEntries([
  ...ENTITY_KINDS.map((kind) => [ENTITY_DESCRIPTORS[kind].list, ENTITY_DESCRIPTORS[kind].label]),
  ["places", "Places"],
  ["commands", "Commands"],
  ["apiKeys", "API Keys"]
]) as Record<ListKind, string>;

const MapView = lazy(() => import("../ui/map/view/MapView.js").then((module) => ({ default: module.MapView })));

type CommandManifestStatus = "ready" | "loading" | "unavailable";
const EMPTY_ENTITY_QUERIES = Object.fromEntries(ENTITY_KINDS.map((kind) => [kind, ""])) as Record<EntityKind, string>;

export function MapConsole() {
  const atlas = useAtlas();
  const { snapshot, catalog } = atlas;
  const [sidebar, dispatch] = useReducer(sidebarReducer, initialSidebarState);
  const [entityQueries, setEntityQueries] = useState(EMPTY_ENTITY_QUERIES);
  const [placeQuery, setPlaceQuery] = useState("");
  const [placePreviewTarget, setPlacePreviewTarget] = useState<MapTarget | null>(null);
  const [cameraCommand, setCameraCommand] = useState<MapCameraCommand | null>(null);
  const cameraSequenceRef = useRef(0);
  const placePreviewTargetRef = useRef<MapTarget | null>(null);

  const [selectedMapSourceId, setSelectedMapSourceId] = useState<string>();

  const placeSearch = useMemo<PlaceSearch | undefined>(() => {
    const apiKey = atlas.config?.placeSearch?.apiKey;
    return apiKey ? createMapTilerPlaceSearch(apiKey) : undefined;
  }, [atlas.config?.placeSearch?.apiKey]);

  const issueCameraCommand = useCallback((target: MapTarget, intent: "focus" | "preview" | "commit" = "focus") => {
    cameraSequenceRef.current += 1;
    setCameraCommand({ seq: cameraSequenceRef.current, target, intent });
  }, []);
  const previewPlace = useCallback(
    (target: MapTarget | null) => {
      const current = placePreviewTargetRef.current;
      placePreviewTargetRef.current = target;
      setPlacePreviewTarget(target);
      if (target) {
        if (current?.id !== target.id) issueCameraCommand(target, "preview");
      } else if (current) {
        setCameraCommand(null);
      }
    },
    [issueCameraCommand]
  );
  const focusPlace = useCallback(
    (target: MapTarget) => {
      placePreviewTargetRef.current = target;
      setPlacePreviewTarget(target);
      issueCameraCommand(target, "commit");
    },
    [issueCameraCommand]
  );
  const showWorld = useCallback(() => {
    placePreviewTargetRef.current = null;
    setPlacePreviewTarget(null);
    cameraSequenceRef.current += 1;
    setCameraCommand({ seq: cameraSequenceRef.current, intent: "world" });
  }, []);

  const selection = sidebar.selection;
  const selectedSnapshotEntity = getEntity(snapshot, selection?.id);
  const selectedSnapshotEntityId = selectedSnapshotEntity?.entity_id;
  const [selectedEntityDetails, setSelectedEntityDetails] = useState<EntityResource>();
  const [commandManifestStatus, setCommandManifestStatus] = useState<CommandManifestStatus>("ready");
  const commandDetailsRequired = Boolean(
    selectedSnapshotEntity &&
      entityKind(selectedSnapshotEntity) === "asset" &&
      catalog?.length &&
      atlas.loadEntityDetails
  );
  useEffect(() => {
    let cancelled = false;
    setSelectedEntityDetails(undefined);
    if (!commandDetailsRequired || !selectedSnapshotEntityId || !atlas.loadEntityDetails) {
      setCommandManifestStatus("ready");
      return () => {
        cancelled = true;
      };
    }
    setCommandManifestStatus("loading");
    void atlas
      .loadEntityDetails(selectedSnapshotEntityId)
      .then((entity) => {
        if (!cancelled) {
          setSelectedEntityDetails(entity);
          setCommandManifestStatus("ready");
        }
      })
      .catch(() => {
        if (!cancelled) setCommandManifestStatus("unavailable");
      });
    return () => {
      cancelled = true;
    };
  }, [atlas.loadEntityDetails, commandDetailsRequired, selectedSnapshotEntityId]);
  const resolvedCommandManifestStatus =
    !commandDetailsRequired &&
    selectedSnapshotEntity &&
    entityKind(selectedSnapshotEntity) === "asset" &&
    catalog?.length &&
    selectedSnapshotEntity.command_manifest === undefined
      ? "unavailable"
      : commandManifestStatus;
  const selectedEntity =
    selectedSnapshotEntity && selectedEntityDetails?.entity_id === selectedSnapshotEntity.entity_id
      ? { ...selectedSnapshotEntity, command_manifest: selectedEntityDetails.command_manifest }
      : commandDetailsRequired
        ? selectedSnapshotEntity && { ...selectedSnapshotEntity, command_manifest: undefined }
        : selectedSnapshotEntity;
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
  const focusTarget = placePreviewTarget ?? entityReticleTarget(selectedEntity);

  // Entity rows and place results share one camera sequence. MapView ignores
  // repeated sequence numbers, even when the targets differ.
  useEffect(() => {
    if (sidebar.focusRequest) {
      issueCameraCommand({ type: "entity", id: sidebar.focusRequest.id });
    } else {
      setCameraCommand(null);
    }
  }, [issueCameraCommand, sidebar.focusRequest]);

  const selectEntityById = useCallback(
    (id: string) => {
      const entity = snapshot.entities[id];
      if (!entity) return;
      const kind = entityKind(entity);
      if (kind === "other") return;
      placePreviewTargetRef.current = null;
      setPlacePreviewTarget(null);
      setCameraCommand(null);
      dispatch({ type: "selectEntity", kind, id, origin: "map" });
    },
    [snapshot.entities]
  );
  const setEntityQuery = useCallback((kind: EntityKind, query: string) => {
    setEntityQueries((current) => (current[kind] === query ? current : { ...current, [kind]: query }));
  }, []);

  if (atlas.status === "loading") {
    return (
      <div className="app-loading">
        <span>Connecting to Atlas Core…</span>
      </div>
    );
  }
  if (atlas.status === "error") {
    return (
      <Callout className="app-error" icon={null} role="alert">
        <span>Could not connect to Atlas Core.</span>
        <code>{atlas.error}</code>
        <Button variant="primary" onClick={atlas.reconnect}>
          Retry connection
        </Button>
      </Callout>
    );
  }
  if (!atlas.config) {
    return (
      <Callout className="app-error" icon={null}>
        <span>Command interface configuration is unavailable.</span>
      </Callout>
    );
  }
  if (atlas.config.mapSources.length === 0) {
    return (
      <Callout className="app-error" icon={null}>
        <span>No map sources are configured.</span>
      </Callout>
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
          key: availability.command.command,
          title: availability.command.name,
          sub: availability.manifest.description,
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
            autoFocusBack={sidebar.focusRequest?.id === selection?.id}
            headerAction={
              activeList === "places" ? (
                <IconButton label="World view" onClick={showWorld}>
                  <WorldViewIcon size={18} />
                </IconButton>
              ) : undefined
            }
            onCollapse={() => dispatch({ type: "setCollapsed", collapsed: true })}
          >
            <PanelBody
              snapshot={snapshot}
              sidebar={sidebar}
              entityQueries={entityQueries}
              placeQuery={placeQuery}
              placeSearch={placeSearch}
              placeSearchUnavailableReason={atlas.config.placeSearch.unavailableReason}
              selectedEntity={selectedEntity}
              catalog={catalog}
              commandManifestStatus={resolvedCommandManifestStatus}
              edit={edit}
              saving={saving}
              saveError={saveError}
              onSelectEntity={(entity) => {
                const kind = entityKind(entity);
                if (kind === "other") return;
                placePreviewTargetRef.current = null;
                setPlacePreviewTarget(null);
                dispatch({ type: "selectEntity", kind, id: entity.entity_id, origin: "sidebar" });
              }}
              onEntityQueryChange={setEntityQuery}
              onPlaceQueryChange={setPlaceQuery}
              onPreviewPlace={previewPlace}
              onFocusPlace={focusPlace}
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
                      mapSourceOptions={atlas.config.mapSources}
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
                        placePreviewTargetRef.current = null;
                        setPlacePreviewTarget(null);
                        setCameraCommand(null);
                        dispatch({ type: "clearSelection" });
                      }}
                      onStyleSwitchError={handleMapStyleSwitchError}
                    />
                  </Suspense>
                ) : (
                  <Callout className="app-error" icon={null} role="alert">
                    <span>The configured default map source is unavailable.</span>
                  </Callout>
                )}
                <ConnectionBadge health={atlas.health} error={atlas.connectionError} onRetry={atlas.reconnect} />
                <MapSourcePicker
                  sources={atlas.config.mapSources}
                  defaultSourceId={atlas.config.defaultMapSourceId}
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
        <Callout className="banner banner--info" intent="primary" icon={null} compact role="status">
          Tasking pending…
        </Callout>
      ) : null}

      {commandForm && selectedEntity ? (
        <PurposeBuiltCommandForm
          state={commandForm}
          asset={selectedEntity}
          submitting={submitting}
          error={submitError}
          onCancel={commandFlow.dismissCommandForm}
          onSubmit={(input) => void commandFlow.submit(commandForm.availability, input)}
        />
      ) : submitError ? (
        <Callout className="banner banner--error" intent="danger" icon={null} compact role="alert">
          {submitError}
        </Callout>
      ) : null}
    </>
  );
}

function PurposeBuiltCommandForm({
  state,
  asset,
  submitting,
  error,
  onCancel,
  onSubmit
}: {
  state: CommandFormState;
  asset: EntityResource;
  submitting: boolean;
  error?: string;
  onCancel: () => void;
  onSubmit: (input: JSONValue) => void;
}) {
  const Form = state.availability.input.Form;
  if (!Form) return null;
  return (
    <Form
      asset={asset}
      command={state.availability.command}
      mapPoint={state.mapPoint}
      submitting={submitting}
      error={error}
      onCancel={onCancel}
      onSubmit={onSubmit}
    />
  );
}

type AvailableMapSourceConfig = MapSourceConfig & { style: NonNullable<MapSourceConfig["style"]> };

function availableMapSource(source: MapSourceConfig | undefined): AvailableMapSourceConfig | undefined {
  return source?.style ? (source as AvailableMapSourceConfig) : undefined;
}

type PanelBodyProps = {
  snapshot: AtlasSnapshot;
  sidebar: SidebarState;
  entityQueries: Record<EntityKind, string>;
  placeQuery: string;
  placeSearch?: PlaceSearch;
  placeSearchUnavailableReason?: string;
  selectedEntity?: EntityResource;
  catalog?: CommandCatalog;
  commandManifestStatus: CommandManifestStatus;
  edit: GeometryEditState | null;
  saving: boolean;
  saveError?: string;
  onSelectEntity: (entity: EntityResource) => void;
  onEntityQueryChange: (kind: EntityKind, query: string) => void;
  onPlaceQueryChange: (query: string) => void;
  onPreviewPlace: (target: MapTarget | null) => void;
  onFocusPlace: (target: MapTarget) => void;
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
  sidebar,
  entityQueries,
  selectedEntity,
  catalog,
  commandManifestStatus,
  placeQuery,
  placeSearch,
  placeSearchUnavailableReason,
  onSelectEntity,
  onEntityQueryChange,
  onPlaceQueryChange,
  onPreviewPlace,
  onFocusPlace,
  onPickCommand
}: { list: ListKind } & PanelBodyProps) {
  if (list === "commands") {
    if (selectedEntity && entityKind(selectedEntity) === "asset") {
      return (
        <div style={{ padding: 12 }}>
          <CommandList
            availabilities={catalog ? commandsForTargeting(catalog, selectedEntity, "none") : []}
            onPick={onPickCommand}
            emptyLabel={
              !catalog
                ? "Command Catalog unavailable"
                : catalog.length === 0
                  ? "No Commands are defined in Atlas Protocol"
                  : commandManifestStatus === "loading"
                    ? "Loading Asset Commands"
                    : commandManifestStatus === "unavailable"
                      ? "Asset Commands unavailable"
                      : !selectedEntity.command_manifest?.length
                        ? "This Asset has no Commands"
                        : "No operator inputs are available for this Asset's Commands"
            }
          />
        </div>
      );
    }
    return <div className="panel__empty">Select an asset to issue commands.</div>;
  }
  if (list === "places") {
    return (
      <PlacesPanel
        query={placeQuery}
        search={placeSearch}
        unavailableReason={placeSearchUnavailableReason}
        onQueryChange={onPlaceQueryChange}
        onPreview={onPreviewPlace}
        onFocus={onFocusPlace}
      />
    );
  }
  if (list === "apiKeys") {
    return <APIKeysPanel />;
  }

  const kind = ENTITY_KIND_BY_LIST[list];
  return (
    <EntityList
      entities={entitiesByKind(snapshot, kind)}
      selectedId={selectedEntity?.entity_id}
      restoreFocusId={sidebar.restoreFocusId ?? undefined}
      query={entityQueries[kind]}
      emptyLabel={`No ${LIST_TITLES[list].toLowerCase()} yet`}
      onSelect={onSelectEntity}
      onQueryChange={(query) => onEntityQueryChange(kind, query)}
    />
  );
}

function entityReticleTarget(entity: EntityResource | undefined): MapReticleTarget | null {
  return entity && entityKind(entity) !== "other" ? { type: "entity", id: entity.entity_id } : null;
}

function panelTitle(sidebar: SidebarState, selectionKind?: EntityKind): string {
  if (sidebar.view.mode === "list") return LIST_TITLES[sidebar.view.list];
  return selectionKind ? ENTITY_DESCRIPTORS[selectionKind].title : "Inspector";
}
