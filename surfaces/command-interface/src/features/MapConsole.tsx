import { Callout } from "@blueprintjs/core";
import type { CommandCatalog, EntityResource, JSONValue, SpatialFeature } from "@the-drunken-coder/atlas-sdk";
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
import { buildMapSources } from "../ui/map/rendering/map-sources.js";
import type { MapReticleTarget } from "../ui/map/view/MapView.js";
import { MapWindowWorkspace } from "../ui/map/view/MapWindowWorkspace.js";
import { Button, IconButton } from "../ui/primitives/controls.js";
import { WorldViewIcon } from "../ui/primitives/icons.js";
import { ContextMenu, type MenuItemDef } from "../ui/primitives/Menu.js";
import { APIKeysPanel } from "./admin/APIKeysPanel.js";
import type { PluginSelection } from "./admin/PluginsPanel.js";
import { AssetInspector, type CommandManifestStatus } from "./assets/AssetInspector.js";
import { CommandDetails } from "./commands/CommandDetails.js";
import { CommandList } from "./commands/CommandList.js";
import { type CommandFormState, useCommandFlow } from "./commands/use-command-flow.js";
import { EntityList } from "./EntityList.js";
import { GeofeatureInspector } from "./geofeatures/GeofeatureInspector.js";
import { type GeometryEditState, useGeometryEdit } from "./geofeatures/use-geometry-edit.js";
import { PlacesPanel } from "./places/PlacesPanel.js";
import { createMapTilerPlaceSearch, type PlaceSearch } from "./places/place-search.js";
import { type SpatialOperationRunner, useSpatialOperationRunner } from "./plugins/use-spatial-operation-runner.js";
import { TrackInspector } from "./tracks/TrackInspector.js";
import { useHeartbeatClock } from "./useHeartbeatClock.js";

const LIST_TITLES = Object.fromEntries([
  ...ENTITY_KINDS.map((kind) => [ENTITY_DESCRIPTORS[kind].list, ENTITY_DESCRIPTORS[kind].label]),
  ["places", "Places"],
  ["commands", "Commands"],
  ["plugins", "Plugins"],
  ["apiKeys", "API Keys"]
]) as Record<ListKind, string>;

const MapView = lazy(() => import("../ui/map/view/MapView.js").then((module) => ({ default: module.MapView })));
const MapSourcePicker = lazy(() =>
  import("../ui/map/MapSourcePicker.js").then((module) => ({ default: module.MapSourcePicker }))
);
const PluginsPanel = lazy(() => import("./admin/PluginsPanel.js").then((module) => ({ default: module.PluginsPanel })));
const SpatialResultsInspector = lazy(() =>
  import("./plugins/SpatialResultsInspector.js").then((module) => ({ default: module.SpatialResultsInspector }))
);

const EMPTY_ENTITY_QUERIES = Object.fromEntries(ENTITY_KINDS.map((kind) => [kind, ""])) as Record<EntityKind, string>;
const MAX_STALE_DETAIL_REFRESHES = 1;

type EntityDetailsRequest = {
  entityId: string;
  runtimeManifestVersion?: number;
  inFlight: boolean;
  cancelled: boolean;
  controller?: AbortController;
  retryAfterVersion?: number;
  staleRefreshAttempts: number;
  start: () => void;
};

export function MapConsole() {
  const atlas = useAtlas();
  const { snapshot, catalog } = atlas;
  const now = useHeartbeatClock();
  const [sidebar, dispatch] = useReducer(sidebarReducer, initialSidebarState);
  const [entityQueries, setEntityQueries] = useState(EMPTY_ENTITY_QUERIES);
  const [placeQuery, setPlaceQuery] = useState("");
  const [placePreviewTarget, setPlacePreviewTarget] = useState<MapTarget | null>(null);
  const [spatialPreviewTarget, setSpatialPreviewTarget] = useState<MapTarget | null>(null);
  const [cameraCommand, setCameraCommand] = useState<MapCameraCommand | null>(null);
  const [pluginSelection, setPluginSelection] = useState<PluginSelection>();
  const cameraSequenceRef = useRef(0);
  const spatial = useSpatialOperationRunner({ baseUrl: atlas.config?.atlasBaseUrl });

  useEffect(() => setSpatialPreviewTarget(null), [spatial.result, spatial.target]);

  const [selectedMapSourceId, setSelectedMapSourceId] = useState<string>();

  const placeSearch = useMemo<PlaceSearch | undefined>(() => {
    const apiKey = atlas.config?.placeSearch?.apiKey;
    return apiKey ? createMapTilerPlaceSearch(apiKey) : undefined;
  }, [atlas.config?.placeSearch?.apiKey]);

  const issueCameraCommand = useCallback((target: MapTarget, intent: "focus" | "preview" | "commit" = "focus") => {
    cameraSequenceRef.current += 1;
    setCameraCommand({ seq: cameraSequenceRef.current, target, intent });
  }, []);
  const previewPlace = useCallback((target: MapTarget | null) => {
    setPlacePreviewTarget(target);
  }, []);
  const focusPlace = useCallback(
    (target: MapTarget) => {
      setPlacePreviewTarget(null);
      issueCameraCommand(target, "commit");
    },
    [issueCameraCommand]
  );
  const showWorld = useCallback(() => {
    setPlacePreviewTarget(null);
    cameraSequenceRef.current += 1;
    setCameraCommand({ seq: cameraSequenceRef.current, intent: "world" });
  }, []);

  const selection = sidebar.selection;
  const selectedSnapshotEntity = getEntity(snapshot, selection?.id);
  const selectedSnapshotEntityId = selectedSnapshotEntity?.entity_id;
  const selectedRuntimeManifestVersion = selectedSnapshotEntityId
    ? snapshot.runtimeManifestVersions?.[selectedSnapshotEntityId]
    : undefined;
  const selectedSnapshotEntityVersion = selectedSnapshotEntity?.metadata.version;
  const [selectedEntityDetails, setSelectedEntityDetails] = useState<EntityResource>();
  const [commandManifestState, setCommandManifestState] = useState<{
    entityId?: string;
    status: CommandManifestStatus;
  }>({ status: "ready" });
  const desiredEntityVersionRef = useRef(selectedSnapshotEntityVersion);
  desiredEntityVersionRef.current = selectedSnapshotEntityVersion;
  const detailsRequestRef = useRef<EntityDetailsRequest>(undefined);
  const commandDetailsRequired = Boolean(
    selectedSnapshotEntity &&
      entityKind(selectedSnapshotEntity) === "asset" &&
      catalog?.length &&
      atlas.loadEntityDetails
  );
  useEffect(() => {
    if (!commandDetailsRequired || !selectedSnapshotEntityId || !atlas.loadEntityDetails) {
      setSelectedEntityDetails(undefined);
      setCommandManifestState({ status: "ready" });
      return;
    }
    const request: EntityDetailsRequest = {
      entityId: selectedSnapshotEntityId,
      runtimeManifestVersion: selectedRuntimeManifestVersion,
      inFlight: false,
      cancelled: false,
      staleRefreshAttempts: 0,
      start: () => {}
    };
    detailsRequestRef.current = request;
    setSelectedEntityDetails((current) => (current?.entity_id === request.entityId ? current : undefined));
    setCommandManifestState({ entityId: request.entityId, status: "loading" });

    request.start = () => {
      if (request.cancelled || request.inFlight || detailsRequestRef.current !== request) return;
      request.inFlight = true;
      const controller = new AbortController();
      request.controller = controller;
      void atlas
        .loadEntityDetails?.(request.entityId, controller.signal)
        .then((entity) => {
          if (request.cancelled || controller.signal.aborted || detailsRequestRef.current !== request) return;
          request.inFlight = false;
          setSelectedEntityDetails((current) =>
            current?.entity_id === entity.entity_id && current.metadata.version > entity.metadata.version
              ? current
              : entity
          );

          request.retryAfterVersion = undefined;
          const desiredVersion = desiredEntityVersionRef.current;
          const stale = desiredVersion !== undefined && entity.metadata.version < desiredVersion;
          if (!stale) {
            request.staleRefreshAttempts = 0;
            setCommandManifestState({ entityId: request.entityId, status: "ready" });
            return;
          }

          if (request.staleRefreshAttempts < MAX_STALE_DETAIL_REFRESHES) {
            request.staleRefreshAttempts += 1;
            setCommandManifestState({ entityId: request.entityId, status: "loading" });
            request.start();
          } else {
            request.retryAfterVersion = desiredVersion;
            setCommandManifestState({ entityId: request.entityId, status: "unavailable" });
          }
        })
        .catch(() => {
          if (request.cancelled || controller.signal.aborted || detailsRequestRef.current !== request) return;
          request.inFlight = false;
          request.retryAfterVersion = desiredEntityVersionRef.current;
          setCommandManifestState({ entityId: request.entityId, status: "unavailable" });
        });
    };
    request.start();
    return () => {
      request.cancelled = true;
      request.controller?.abort();
      if (detailsRequestRef.current === request) detailsRequestRef.current = undefined;
    };
  }, [atlas.loadEntityDetails, commandDetailsRequired, selectedRuntimeManifestVersion, selectedSnapshotEntityId]);

  useEffect(() => {
    const request = detailsRequestRef.current;
    if (!request) return;
    const selectedDetailsForRequest =
      selectedEntityDetails?.entity_id === selectedSnapshotEntityId ? selectedEntityDetails : undefined;
    const detailsAreStale = Boolean(
      selectedDetailsForRequest &&
        selectedSnapshotEntityVersion !== undefined &&
        selectedDetailsForRequest.metadata.version < selectedSnapshotEntityVersion
    );
    const retryAfterVersion = request.retryAfterVersion;
    const refreshAvailable =
      retryAfterVersion === undefined
        ? detailsAreStale && request.staleRefreshAttempts < MAX_STALE_DETAIL_REFRESHES
        : selectedSnapshotEntityVersion !== undefined && selectedSnapshotEntityVersion > retryAfterVersion;
    if (
      !commandDetailsRequired ||
      request.entityId !== selectedSnapshotEntityId ||
      request.inFlight ||
      selectedSnapshotEntityVersion === undefined ||
      !refreshAvailable
    ) {
      return;
    }
    if (retryAfterVersion !== undefined) {
      request.retryAfterVersion = undefined;
      request.staleRefreshAttempts = 0;
    }
    setCommandManifestState({ entityId: request.entityId, status: "loading" });
    request.start();
  }, [commandDetailsRequired, selectedEntityDetails, selectedSnapshotEntityId, selectedSnapshotEntityVersion]);

  const selectedDetails =
    selectedEntityDetails?.entity_id === selectedSnapshotEntityId ? selectedEntityDetails : undefined;
  const detailsNeedRefresh = Boolean(
    commandDetailsRequired &&
      selectedDetails &&
      selectedSnapshotEntityVersion !== undefined &&
      (selectedDetails.metadata.version < selectedSnapshotEntityVersion ||
        detailsRequestRef.current?.runtimeManifestVersion !== selectedRuntimeManifestVersion)
  );
  const currentCommandManifestStatus =
    commandManifestState.entityId === selectedSnapshotEntityId ? commandManifestState.status : "loading";
  const resolvedCommandManifestStatus =
    !commandDetailsRequired &&
    selectedSnapshotEntity &&
    entityKind(selectedSnapshotEntity) === "asset" &&
    catalog?.length &&
    selectedSnapshotEntity.command_manifest === undefined
      ? "unavailable"
      : !commandDetailsRequired
        ? "ready"
        : currentCommandManifestStatus === "unavailable"
          ? "unavailable"
          : currentCommandManifestStatus === "loading" || !selectedDetails || detailsNeedRefresh
            ? "loading"
            : "ready";
  const selectedEntity =
    selectedSnapshotEntity && selectedDetails
      ? { ...selectedSnapshotEntity, command_manifest: selectedDetails.command_manifest }
      : commandDetailsRequired
        ? selectedSnapshotEntity && { ...selectedSnapshotEntity, command_manifest: undefined }
        : selectedSnapshotEntity;
  const selectedId = selection?.id;
  const commandFlow = useCommandFlow({
    catalog,
    selectedEntity,
    selectedId,
    commandManifestStatus: resolvedCommandManifestStatus,
    commandManifestGeneration:
      selectedDetails === undefined
        ? undefined
        : JSON.stringify(selectedDetails.command_manifest?.slice().sort((a, b) => a.command.localeCompare(b.command))),
    submitCommand: atlas.submitCommand
  });
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
    () => buildMapSources(Object.values(snapshot.entities), selectedId, now),
    [snapshot.entities, selectedId, now]
  );
  const counts = useMemo(() => countsByKind(snapshot), [snapshot]);
  const handleMapStyleSwitchError = useCallback(
    ({ activeStyleId }: { failedStyleId: string; activeStyleId: string }) => {
      const activeSource = atlas.config?.mapSources.find((source) => source.id === activeStyleId);
      if (activeSource) setSelectedMapSourceId(activeSource.id);
    },
    [atlas.config]
  );
  const placesActive = sidebar.view.mode === "list" && sidebar.view.list === "places";
  const selectSidebarList = useCallback((list: ListKind) => {
    if (list !== "places") {
      setPlacePreviewTarget(null);
      setCameraCommand((current) => (current?.intent === "commit" ? null : current));
    }
    dispatch({ type: "openList", list });
  }, []);
  const placeFocusTarget = placesActive && cameraCommand?.intent === "commit" ? cameraCommand.target : null;
  const pluginsActive = sidebar.view.mode === "list" && sidebar.view.list === "plugins";
  const selectedSpatialTarget =
    pluginsActive && spatial.selectedFeature ? spatialFeatureTarget(spatial.selectedFeature) : null;
  const focusTarget =
    spatialPreviewTarget ??
    placePreviewTarget ??
    placeFocusTarget ??
    selectedSpatialTarget ??
    (placesActive ? null : entityReticleTarget(selectedEntity));

  // Explicit entity and place commits share one camera sequence. MapView
  // ignores repeated sequence numbers, even when the targets differ.
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
  const pluginActive = activeList === "plugins";
  const pluginOperationActive = Boolean(
    pluginActive && pluginSelection && spatial.target?.pluginId === pluginSelection.pluginId
  );
  const currentPanelTitle = pluginOperationActive
    ? (spatial.target?.operationName ?? "Spatial operation")
    : pluginActive && pluginSelection
      ? pluginSelection.name
      : panelTitle(sidebar, selection?.kind);
  const currentPanelBack = pluginOperationActive
    ? spatial.closeTarget
    : pluginActive && pluginSelection
      ? () => setPluginSelection(undefined)
      : sidebar.view.mode === "inspector"
        ? () => dispatch({ type: "back" })
        : undefined;
  const selectedMapSource =
    availableMapSource(atlas.config.mapSources.find((source) => source.id === selectedMapSourceId)) ??
    availableMapSource(atlas.config.mapSources.find((source) => source.id === atlas.config?.defaultMapSourceId));
  const mapSourcePickerValue = selectedMapSource?.id ?? selectedMapSourceId ?? atlas.config.defaultMapSourceId;

  const mapCommands: MenuItemDef[] =
    mapMenu && selectedEntity && catalog
      ? commandsForTargeting(catalog, selectedEntity, "map_point").map((availability) => ({
          key: availability.command.command,
          title: availability.command.name,
          sub: <CommandDetails command={availability.command} manifest={availability.manifest} density="menu" />,
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
            onSelectList={selectSidebarList}
            onToggleCollapsed={() => dispatch({ type: "toggleCollapsed" })}
          />
        }
        panel={
          <SidebarPanel
            title={currentPanelTitle}
            onBack={currentPanelBack}
            autoFocusBack={sidebar.focusRequest?.id === selection?.id}
            headerAction={
              activeList === "places" ? (
                <IconButton label="World view" onClick={showWorld}>
                  <WorldViewIcon size={18} />
                </IconButton>
              ) : undefined
            }
            onCollapse={() => {
              dispatch({ type: "setCollapsed", collapsed: true });
              requestAnimationFrame(() => {
                document.querySelector<HTMLElement>(`[data-list="${activeList ?? "assets"}"]`)?.focus();
              });
            }}
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
                setPlacePreviewTarget(null);
                setSpatialPreviewTarget(null);
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
              spatial={spatial}
              pluginSelection={pluginSelection}
              onPluginSelectionChange={setPluginSelection}
            />
          </SidebarPanel>
        }
        map={
          <>
            <div className="map-world-frame">
              <div className="map-stage">
                <MapWindowWorkspace>
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
                        placeDetailTarget={placePreviewTarget}
                        cameraCommand={cameraCommand}
                        spatial={
                          spatial.target
                            ? {
                                area: spatial.area,
                                drawing: spatial.status === "drawing",
                                features: spatial.result?.features ?? [],
                                selectedFeatureId: spatial.selectedFeature?.id,
                                onAreaChange: spatial.setArea,
                                onDrawingComplete: spatial.cancelDrawing,
                                onCancelDrawing: spatial.cancelDrawing,
                                onViewportArea: spatial.setViewportArea,
                                onSelectFeature: spatial.selectFeature,
                                onBoxZoomActiveChange: spatial.setMapBoxZoomActive
                              }
                            : undefined
                        }
                        onSelectEntity={selectEntityById}
                        onMapContextMenu={commandFlow.onMapContextMenu}
                        onBackgroundClick={() => {
                          commandFlow.closeMapMenu();
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
                  <Suspense fallback={null}>
                    <MapSourcePicker
                      sources={atlas.config.mapSources}
                      defaultSourceId={atlas.config.defaultMapSourceId}
                      value={mapSourcePickerValue}
                      onChange={setSelectedMapSourceId}
                    />
                  </Suspense>
                  <Suspense fallback={null}>
                    <SpatialResultsInspector
                      spatial={spatial}
                      onPreviewFeature={(feature) =>
                        setSpatialPreviewTarget(feature ? spatialFeatureTarget(feature) : null)
                      }
                      onFocusFeature={(feature) => {
                        setSpatialPreviewTarget(null);
                        issueCameraCommand(spatialFeatureTarget(feature), "commit");
                      }}
                    />
                  </Suspense>
                </MapWindowWorkspace>
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

      {commandForm && selectedEntity && resolvedCommandManifestStatus !== "unavailable" ? (
        <PurposeBuiltCommandForm
          state={commandForm}
          asset={selectedEntity}
          submitting={submitting || resolvedCommandManifestStatus !== "ready"}
          error={submitError}
          onCancel={commandFlow.dismissCommandForm}
          onSubmit={(input) => void commandFlow.submit(commandForm.availability, input, commandForm.manifestGeneration)}
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
  spatial: SpatialOperationRunner;
  pluginSelection?: PluginSelection;
  onPluginSelectionChange: (selection?: PluginSelection) => void;
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
        commandManifestStatus={props.commandManifestStatus}
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
  onPickCommand,
  spatial,
  pluginSelection,
  onPluginSelectionChange
}: { list: ListKind } & PanelBodyProps) {
  if (list === "commands") {
    if (selectedEntity && entityKind(selectedEntity) === "asset") {
      return (
        <div style={{ padding: 12 }}>
          <CommandList
            availabilities={catalog ? commandsForTargeting(catalog, selectedEntity, "none") : []}
            onPick={onPickCommand}
            disabled={commandManifestStatus !== "ready"}
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
  if (list === "plugins") {
    return (
      <Suspense
        fallback={
          <div className="panel__empty" role="status">
            Loading Plugin status…
          </div>
        }
      >
        <PluginsPanel selection={pluginSelection} onSelectionChange={onPluginSelectionChange} spatial={spatial} />
      </Suspense>
    );
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

function spatialFeatureTarget(feature: SpatialFeature): MapTarget {
  return {
    type: "geometry",
    id: `spatial:${feature.id}`,
    geometry: feature.geometry,
    label: feature.title
  };
}

function panelTitle(sidebar: SidebarState, selectionKind?: EntityKind): string {
  if (sidebar.view.mode === "list") return LIST_TITLES[sidebar.view.list];
  return selectionKind ? ENTITY_DESCRIPTORS[selectionKind].title : "Inspector";
}
