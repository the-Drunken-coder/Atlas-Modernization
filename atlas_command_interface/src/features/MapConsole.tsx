import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { EntityResource, JSONValue } from "@the-drunken-coder/atlas-sdk";
import type { CommandCatalog } from "../atlas/command-model.js";
import { commandsForTargeting, type CommandAvailability } from "../atlas/command-targeting.js";
import type { ConnectionHealth } from "../atlas/data-source.js";
import { entityGeometry, entityKind, type EntityKind } from "../atlas/entities.js";
import type { UiGeometry } from "../atlas/geometry.js";
import { countsByKind, entitiesByKind, getEntity } from "../atlas/selectors.js";
import type { AtlasSnapshot } from "../atlas/store.js";
import { initialSidebarState, listForKind, sidebarReducer, type ListKind, type SidebarState } from "../state/selection.js";
import { useAtlas } from "../state/atlas-context.js";
import type { MapSourceConfig } from "../app/config.js";
import { AppShell } from "../ui/layout/AppShell.js";
import { SidebarPanel } from "../ui/layout/SidebarPanel.js";
import { SidebarRail } from "../ui/layout/SidebarRail.js";
import { MapView, buildMapSources, type MapContextMenuInfo, type MapReticleTarget } from "../ui/map/MapView.js";
import type { MapCameraCommand } from "../ui/map/map-camera.js";
import { ContextMenu, type MenuItemDef } from "../ui/primitives/Menu.js";
import { Button, SelectField } from "../ui/primitives/controls.js";
import { APIKeysPanel } from "./admin/APIKeysPanel.js";
import { AssetInspector } from "./assets/AssetInspector.js";
import { CommandActions } from "./commands/CommandActions.js";
import { CommandForm } from "./commands/CommandForm.js";
import { EntityList } from "./EntityList.js";
import { GeofeatureInspector } from "./geofeatures/GeofeatureInspector.js";
import { TrackInspector } from "./tracks/TrackInspector.js";

const LIST_TITLES: Record<ListKind, string> = {
  assets: "Assets",
  tracks: "Tracks",
  geofeatures: "Geo Features",
  commands: "Commands",
  apiKeys: "API Keys"
};

const KIND_TITLES: Record<EntityKind, string> = { asset: "Asset", track: "Track", geofeature: "Geo Feature" };

type MapMenuState = { x: number; y: number; lat: number; lng: number };
type CommandFormState = { availability: CommandAvailability; mapPoint?: { lat: number; lng: number } };
type EditState = { entityId: string; version: number; draft: UiGeometry };

export function MapConsole() {
  const atlas = useAtlas();
  const { snapshot, catalog } = atlas;
  const [sidebar, dispatch] = useReducer(sidebarReducer, initialSidebarState);

  const [mapMenu, setMapMenu] = useState<MapMenuState | null>(null);
  const [positionPicking, setPositionPicking] = useState(false);
  const [commandForm, setCommandForm] = useState<CommandFormState | null>(null);
  const commandDismissedRef = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string>();
  const [edit, setEdit] = useState<EditState | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const [selectedMapSourceId, setSelectedMapSourceId] = useState<string>();

  const dismissCommandForm = useCallback(() => {
    commandDismissedRef.current = true;
    setCommandForm(null);
    setSubmitError(undefined);
  }, []);

  const selection = sidebar.selection;
  const selectedEntity = getEntity(snapshot, selection?.id);
  const selectedId = selection?.id;
  const selectedEntityId = selectedEntity?.entity_id;

  // Drop transient command UI when the selected entity changes.
  useEffect(() => {
    setMapMenu(null);
    setPositionPicking(false);
    dismissCommandForm();
  }, [selectedId, dismissCommandForm]);

  useEffect(() => {
    setMapMenu(null);
    setPositionPicking(false);
    dismissCommandForm();
  }, [catalog, dismissCommandForm]);

  // Drop an edit session when the selection moves to another entity.
  useEffect(() => {
    if (edit && edit.entityId !== selectedId) {
      setEdit(null);
      setSaveError(undefined);
    }
  }, [edit, selectedId]);

  // Live updates can remove the selected entity while the sidebar still holds
  // its ID; transient command/edit UI must follow the snapshot.
  useEffect(() => {
    if (!selectedId || selectedEntityId) return;
    setMapMenu(null);
    setPositionPicking(false);
    dismissCommandForm();
    setEdit(null);
    setSaveError(undefined);
  }, [selectedId, selectedEntityId, dismissCommandForm]);

  useEffect(() => {
    const config = atlas.config;
    if (!config) return;
    setSelectedMapSourceId((current) =>
      current && config.mapSources.some((source) => source.id === current && source.style) ? current : config.defaultMapSourceId
    );
  }, [atlas.config]);

  const sources = useMemo(() => buildMapSources(Object.values(snapshot.entities), selectedId), [snapshot.entities, selectedId]);
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
    () => (sidebar.focusRequest ? { seq: sidebar.focusRequest.seq, target: { type: "entity", id: sidebar.focusRequest.id } } : null),
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

  const submit = useCallback(
    async (availability: CommandAvailability, parameters: Record<string, JSONValue>, errorFormState?: CommandFormState) => {
      if (!selectedEntity) return;
      commandDismissedRef.current = false;
      setSubmitting(true);
      setSubmitError(undefined);
      try {
        await atlas.submitCommand({ entityId: selectedEntity.entity_id, command: availability.command, parameters });
        setCommandForm(null);
      } catch (cause) {
        if (!commandDismissedRef.current) {
          const message = cause instanceof Error ? cause.message : String(cause);
          setSubmitError(message);
          setCommandForm((current) => current ?? errorFormState ?? null);
        }
      } finally {
        commandDismissedRef.current = false;
        setSubmitting(false);
      }
    },
    [atlas, selectedEntity]
  );

  const pickSidebarCommand = useCallback(
    (availability: CommandAvailability) => {
      if (submitting || availability.disabled) return;
      if (availability.requiresForm) {
        setSubmitError(undefined);
        setCommandForm({ availability });
        return;
      }
      const formState = { availability };
      setCommandForm(formState);
      void submit(availability, {}, formState);
    },
    [submit, submitting]
  );

  const pickMapCommand = useCallback(
    (availability: CommandAvailability, point: { lat: number; lng: number }) => {
      if (submitting || availability.disabled) return;
      if (availability.requiresForm) {
        setSubmitError(undefined);
        setCommandForm({ availability, mapPoint: point });
        return;
      }
      const formState = { availability, mapPoint: point };
      setCommandForm(formState);
      void submit(availability, { latitude: point.lat, longitude: point.lng }, formState);
    },
    [submit, submitting]
  );

  const onMapContextMenu = useCallback(
    (info: MapContextMenuInfo) => {
      if (!selectedEntity || entityKind(selectedEntity) !== "asset") {
        setMapMenu(null);
        return;
      }
      setPositionPicking(false);
      dismissCommandForm();
      setMapMenu({ x: info.x, y: info.y, lat: info.lat, lng: info.lng });
    },
    [selectedEntity, dismissCommandForm]
  );

  const togglePositionPicking = useCallback(() => {
    if (positionPicking) {
      setPositionPicking(false);
      return;
    }
    setMapMenu(null);
    dismissCommandForm();
    setPositionPicking(true);
  }, [dismissCommandForm, positionPicking]);

  const pickMapPosition = useCallback(
    (info: MapContextMenuInfo) => {
      if (!selectedEntity || entityKind(selectedEntity) !== "asset") return;
      setPositionPicking(false);
      setMapMenu({ x: info.x, y: info.y, lat: info.lat, lng: info.lng });
    },
    [selectedEntity]
  );

  const startEdit = useCallback(() => {
    if (!selectedEntity) return;
    const geometry = entityGeometry(selectedEntity);
    if (!geometry) return;
    setSaveError(undefined);
    setEdit({ entityId: selectedEntity.entity_id, version: selectedEntity.metadata.version, draft: geometry });
  }, [selectedEntity]);

  const saveEdit = useCallback(async () => {
    if (!edit || !selectedEntity) return;
    setSaving(true);
    setSaveError(undefined);
    try {
      await atlas.updateGeometry(edit.entityId, edit.draft, edit.version);
      setEdit(null);
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }, [atlas, edit, selectedEntity]);

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

  const activeList: ListKind | null = sidebar.view.mode === "list" ? sidebar.view.list : selection ? listForKind(selection.kind) : null;
  const selectedMapSource =
    availableMapSource(atlas.config.mapSources.find((source) => source.id === selectedMapSourceId)) ??
    availableMapSource(atlas.config.mapSources.find((source) => source.id === atlas.config?.defaultMapSourceId)) ??
    atlas.config.mapSources.find((source): source is AvailableMapSourceConfig => Boolean(source.style));
  if (!selectedMapSource) {
    return (
      <div className="app-error">
        <span>No usable map sources are configured.</span>
      </div>
    );
  }

  const mapCommands: MenuItemDef[] =
    mapMenu && selectedEntity && catalog
      ? commandsForTargeting(catalog, selectedEntity, "map_point").map((availability) => ({
          key: availability.command.id,
          title: availability.command.name,
          sub: availability.requiresForm ? "needs parameters" : undefined,
          disabled: availability.disabled,
          disabledReason: availability.disabledReason,
          onSelect: () => pickMapCommand(availability, { lat: mapMenu.lat, lng: mapMenu.lng })
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
              onPickCommand={pickSidebarCommand}
              positionPicking={positionPicking}
              onTogglePositionPicking={togglePositionPicking}
              onStartEdit={startEdit}
              onChangeDraft={(geometry) => setEdit((current) => (current ? { ...current, draft: geometry } : current))}
              onSaveEdit={() => void saveEdit()}
              onCancelEdit={() => {
                setEdit(null);
                setSaveError(undefined);
              }}
            />
          </SidebarPanel>
        }
        map={
          <>
            <div className="map-world-frame">
              <div className="map-stage">
                <MapView
                  sources={sources}
                  styleId={selectedMapSource.id}
                  style={selectedMapSource.style}
                  selectedId={selectedId}
                  editing={
                    edit
                      ? { geometry: edit.draft, onChange: (geometry) => setEdit((current) => (current ? { ...current, draft: geometry } : current)) }
                      : undefined
                  }
                  focusTarget={focusTarget}
                  cameraCommand={cameraCommand}
                  onSelectEntity={selectEntityById}
                  onMapContextMenu={onMapContextMenu}
                  positionPicking={positionPicking}
                  onPickPosition={pickMapPosition}
                  onCancelPositionPicking={() => setPositionPicking(false)}
                  onBackgroundClick={() => {
                    setMapMenu(null);
                    dispatch({ type: "clearSelection" });
                  }}
                  onStyleSwitchError={handleMapStyleSwitchError}
                />
                <ConnectionBadge health={atlas.health} />
                <MapSourcePicker sources={atlas.config.mapSources} value={selectedMapSource.id} onChange={setSelectedMapSourceId} />
                {positionPicking ? (
                  <div className="map-hint" role="status" aria-live="polite">
                    Click or tap a position, or press Enter to use the map center. Escape cancels.
                  </div>
                ) : null}
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
          onClose={() => setMapMenu(null)}
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
          onCancel={dismissCommandForm}
          onSubmit={(parameters) => void submit(commandForm.availability, parameters, commandForm)}
        />
      ) : null}
    </>
  );
}

function MapSourcePicker({ sources, value, onChange }: { sources: MapSourceConfig[]; value: string; onChange: (value: string) => void }) {
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
  positionPicking: boolean;
  edit: EditState | null;
  saving: boolean;
  saveError?: string;
  onSelectEntity: (entity: EntityResource) => void;
  onPickCommand: (availability: CommandAvailability) => void;
  onTogglePositionPicking: () => void;
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
        positionPicking={props.positionPicking}
        onPickCommand={props.onPickCommand}
        onTogglePositionPicking={props.onTogglePositionPicking}
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
  positionPicking,
  onSelectEntity,
  onPickCommand,
  onTogglePositionPicking
}: { list: ListKind } & PanelBodyProps) {
  if (list === "commands") {
    if (selectedEntity && entityKind(selectedEntity) === "asset") {
      return (
        <div style={{ padding: 12 }}>
          <CommandActions
            entity={selectedEntity}
            catalog={catalog}
            positionPicking={positionPicking}
            onPickCommand={onPickCommand}
            onTogglePositionPicking={onTogglePositionPicking}
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

function ConnectionBadge({ health }: { health: ConnectionHealth }) {
  const state = connectionBadgeState(health);
  return (
    <div className="connection-badge" data-state={state.state} role="status" aria-live="polite" aria-label={`Atlas connection ${state.label}`}>
      <span className="connection-badge__dot" aria-hidden="true" />
      <span>{state.label}</span>
    </div>
  );
}

function connectionBadgeState(health: ConnectionHealth): { label: string; state: "live" | "reconnecting" | "connecting" } {
  if (health.running && health.healthy && !health.degraded) return { label: "Live", state: "live" };
  if (health.running) return { label: "Reconnecting", state: "reconnecting" };
  return { label: "Connecting", state: "connecting" };
}

function panelTitle(sidebar: SidebarState, selectionKind?: EntityKind): string {
  if (sidebar.view.mode === "list") return LIST_TITLES[sidebar.view.list];
  return selectionKind ? KIND_TITLES[selectionKind] : "Inspector";
}
