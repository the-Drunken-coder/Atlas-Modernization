import {
  ContextMenuPopover,
  Menu,
  MenuDivider,
  MenuItem,
  Navbar,
  NavbarGroup,
  NavbarHeading,
  Tag
} from "@blueprintjs/core";
import type { CommandCatalog, EntityResource, JSONValue } from "@the-drunken-coder/atlas-sdk";
import { lazy, type ReactNode, Suspense, useCallback, useEffect, useMemo, useReducer, useState } from "react";
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
import { initialSidebarState, type ListKind, type SidebarState, sidebarReducer } from "../state/selection.js";
import { ConnectionBadge } from "../ui/ConnectionBadge.js";
import { AppShell } from "../ui/layout/AppShell.js";
import { SidebarPanel } from "../ui/layout/SidebarPanel.js";
import { SidebarRail } from "../ui/layout/SidebarRail.js";
import type { MapCameraCommand } from "../ui/map/interaction/map-camera.js";
import { buildMapSources } from "../ui/map/rendering/map-sources.js";
import type { MapReticleTarget } from "../ui/map/view/MapView.js";
import { Button, SelectField } from "../ui/primitives/controls.js";
import { CloseIcon } from "../ui/primitives/icons.js";
import { APIKeysPanel } from "./admin/APIKeysPanel.js";
import { AssetInspector } from "./assets/AssetInspector.js";
import { CommandList } from "./commands/CommandList.js";
import { type CommandFormState, useCommandFlow } from "./commands/use-command-flow.js";
import { EntityList } from "./EntityList.js";
import { GeofeatureInspector } from "./geofeatures/GeofeatureInspector.js";
import { type GeometryEditState, useGeometryEdit } from "./geofeatures/use-geometry-edit.js";
import { TrackInspector } from "./tracks/TrackInspector.js";

const LIST_TITLES = Object.fromEntries([
  ...ENTITY_KINDS.map((kind) => [ENTITY_DESCRIPTORS[kind].list, ENTITY_DESCRIPTORS[kind].label]),
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

  const [selectedMapSourceId, setSelectedMapSourceId] = useState<string>();

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

  const activeList = sidebar.list;
  const selectedMapSource =
    availableMapSource(atlas.config.mapSources.find((source) => source.id === selectedMapSourceId)) ??
    availableMapSource(atlas.config.mapSources.find((source) => source.id === atlas.config?.defaultMapSourceId));
  const mapSourcePickerValue = selectedMapSource?.id ?? selectedMapSourceId ?? atlas.config.defaultMapSourceId;

  const mapCommands =
    mapMenu && selectedEntity && catalog ? commandsForTargeting(catalog, selectedEntity, "map_point") : [];

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
            title={LIST_TITLES[sidebar.list]}
            onCollapse={() => dispatch({ type: "setCollapsed", collapsed: true })}
          >
            <ListBody
              list={sidebar.list}
              snapshot={snapshot}
              sidebar={sidebar}
              entityQueries={entityQueries}
              selectedEntity={selectedEntity}
              onSelectEntity={(entity) => {
                const kind = entityKind(entity);
                if (kind === "other") return;
                dispatch({ type: "selectEntity", kind, id: entity.entity_id, origin: "sidebar" });
              }}
              onEntityQueryChange={setEntityQuery}
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
                {selectedEntity ? (
                  <div className="workspace-right-stack">
                    <FloatingInspector
                      title={selectedEntityTitle(selectedEntity)}
                      onClose={() => dispatch({ type: "clearSelection" })}
                    >
                      <InspectorBody
                        snapshot={snapshot}
                        selectedEntity={selectedEntity}
                        edit={edit}
                        saving={saving}
                        saveError={saveError}
                        onStartEdit={geometryEdit.startEdit}
                        onChangeDraft={geometryEdit.changeDraft}
                        onSaveEdit={() => void geometryEdit.saveEdit()}
                        onCancelEdit={geometryEdit.cancelEdit}
                      />
                    </FloatingInspector>
                    {entityKind(selectedEntity) === "asset" ? (
                      <CommandDock
                        entity={selectedEntity}
                        catalog={catalog}
                        commandManifestStatus={resolvedCommandManifestStatus}
                        submitting={submitting}
                        onPick={commandFlow.pickSidebarCommand}
                      />
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
          </>
        }
      />

      <ContextMenuPopover
        isOpen={mapMenu !== null}
        isDarkTheme
        targetOffset={mapMenu ? { left: mapMenu.x, top: mapMenu.y } : undefined}
        onClose={commandFlow.closeMapMenu}
        content={
          <Menu size="small" className="map-command-menu">
            <MenuDivider
              title={mapMenu ? `${mapMenu.lat.toFixed(4)}, ${mapMenu.lng.toFixed(4)}` : "Position commands"}
            />
            {mapCommands.length > 0 ? (
              mapCommands.map((availability) => (
                <MenuItem
                  key={availability.command.command}
                  multiline
                  text={
                    <span className="map-command-menu__item">
                      <strong>{availability.command.name}</strong>
                      <small>{availability.manifest.description}</small>
                    </span>
                  }
                  onClick={() => {
                    if (!mapMenu) return;
                    commandFlow.pickMapCommand(availability, { lat: mapMenu.lat, lng: mapMenu.lng });
                  }}
                />
              ))
            ) : (
              <MenuItem disabled text="No position commands" />
            )}
          </Menu>
        }
      />

      {submitting && !commandForm ? (
        <div className="banner banner--info" role="status">
          Tasking pending…
        </div>
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
        <div className="banner banner--error" role="alert">
          {submitError}
        </div>
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
    <Navbar className="map-toolbar" fixedToTop={false}>
      <NavbarGroup align="left">
        <NavbarHeading>ATLAS COMMAND</NavbarHeading>
      </NavbarGroup>
      <NavbarGroup align="right">
        <div className="map-source-control">
          <SelectField
            aria-label="Map source"
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
      </NavbarGroup>
    </Navbar>
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
  selectedEntity?: EntityResource;
  onSelectEntity: (entity: EntityResource) => void;
  onEntityQueryChange: (kind: EntityKind, query: string) => void;
};

type InspectorBodyProps = {
  snapshot: AtlasSnapshot;
  selectedEntity: EntityResource;
  edit: GeometryEditState | null;
  saving: boolean;
  saveError?: string;
  onStartEdit: () => void;
  onChangeDraft: (geometry: UiGeometry) => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
};

function InspectorBody(props: InspectorBodyProps) {
  const { snapshot, selectedEntity } = props;
  const kind = entityKind(selectedEntity);
  if (kind === "asset") {
    return <AssetInspector entity={selectedEntity} snapshot={snapshot} />;
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

function FloatingInspector({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <section className="workspace-inspector" aria-label={`${title} inspector`}>
      <header className="workspace-surface-header">
        <strong>{title}</strong>
        <Button variant="ghost" className="workspace-surface-close" aria-label="Close inspector" onClick={onClose}>
          <CloseIcon size={14} />
        </Button>
      </header>
      <div className="workspace-inspector__body">{children}</div>
    </section>
  );
}

function CommandDock({
  entity,
  catalog,
  commandManifestStatus,
  submitting,
  onPick
}: {
  entity: EntityResource;
  catalog?: CommandCatalog;
  commandManifestStatus: CommandManifestStatus;
  submitting: boolean;
  onPick: (availability: CommandAvailability) => void;
}) {
  const availabilities = catalog
    ? [...commandsForTargeting(catalog, entity, "none"), ...commandsForTargeting(catalog, entity, "map_point")]
    : [];
  return (
    <section className="workspace-command-dock" aria-label="Asset commands">
      <header className="workspace-surface-header">
        <strong>Commands</strong>
        <Tag minimal>{availabilities.length}</Tag>
      </header>
      <div className="workspace-command-dock__body">
        <CommandList
          availabilities={availabilities}
          onPick={onPick}
          emptyLabel={commandEmptyLabel(catalog, entity, commandManifestStatus)}
        />
        {submitting ? <div className="command-dock__status">Tasking pending...</div> : null}
      </div>
    </section>
  );
}

function ListBody({
  list,
  snapshot,
  sidebar,
  entityQueries,
  selectedEntity,
  onSelectEntity,
  onEntityQueryChange
}: { list: ListKind } & PanelBodyProps) {
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

function commandEmptyLabel(
  catalog: CommandCatalog | undefined,
  entity: EntityResource,
  commandManifestStatus: CommandManifestStatus
): string {
  if (!catalog) return "Command Catalog unavailable";
  if (catalog.length === 0) return "No Commands are defined in Atlas Protocol";
  if (commandManifestStatus === "loading") return "Loading Asset Commands";
  if (commandManifestStatus === "unavailable") return "Asset Commands unavailable";
  if (!entity.command_manifest?.length) return "This Asset has no Commands";
  return "No operator inputs are available for this Asset's Commands";
}

function entityReticleTarget(entity: EntityResource | undefined): MapReticleTarget | null {
  return entity && entityKind(entity) !== "other" ? { type: "entity", id: entity.entity_id } : null;
}

function selectedEntityTitle(entity: EntityResource): string {
  const kind = entityKind(entity);
  return kind === "other" ? "Entity" : ENTITY_DESCRIPTORS[kind].title;
}
