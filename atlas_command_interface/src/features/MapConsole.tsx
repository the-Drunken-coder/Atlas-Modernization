import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import type { EntityResource, JSONValue } from "../../../atlas_sdk/src/index.js";
import type { CommandCatalog } from "../atlas/command-model.js";
import { commandsForTargeting, type CommandAvailability } from "../atlas/command-targeting.js";
import { entityGeometry, entityKind, type EntityKind } from "../atlas/entities.js";
import type { UiGeometry } from "../atlas/geometry.js";
import { countsByKind, entitiesByKind, getEntity } from "../atlas/selectors.js";
import type { AtlasSnapshot } from "../atlas/store.js";
import { initialSidebarState, listForKind, sidebarReducer, type ListKind, type SidebarState } from "../state/selection.js";
import { useAtlas } from "../state/atlas-context.js";
import { AppShell } from "../ui/layout/AppShell.js";
import { SidebarPanel } from "../ui/layout/SidebarPanel.js";
import { SidebarRail } from "../ui/layout/SidebarRail.js";
import { MapView, buildMapSources, type MapContextMenuInfo } from "../ui/map/MapView.js";
import { ContextMenu, type MenuItemDef } from "../ui/primitives/Menu.js";
import { AssetInspector } from "./assets/AssetInspector.js";
import { CommandForm } from "./commands/CommandForm.js";
import { CommandList } from "./commands/CommandList.js";
import { EntityList } from "./EntityList.js";
import { GeofeatureInspector } from "./geofeatures/GeofeatureInspector.js";
import { TrackInspector } from "./tracks/TrackInspector.js";

const LIST_TITLES: Record<ListKind, string> = {
  assets: "Assets",
  tracks: "Tracks",
  geofeatures: "Geo Features",
  commands: "Commands"
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
  const [commandForm, setCommandForm] = useState<CommandFormState | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string>();
  const [edit, setEdit] = useState<EditState | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();

  const selection = sidebar.selection;
  const selectedEntity = getEntity(snapshot, selection?.id);
  const selectedId = selection?.id;
  const selectedEntityId = selectedEntity?.entity_id;

  // Drop transient command UI when the selected entity changes.
  useEffect(() => {
    setMapMenu(null);
    setCommandForm(null);
    setSubmitError(undefined);
  }, [selectedId]);

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
    setCommandForm(null);
    setSubmitError(undefined);
    setEdit(null);
    setSaveError(undefined);
  }, [selectedId, selectedEntityId]);

  const sources = useMemo(() => buildMapSources(Object.values(snapshot.entities), selectedId), [snapshot.entities, selectedId]);
  const counts = useMemo(() => countsByKind(snapshot), [snapshot]);

  const selectEntityById = useCallback(
    (id: string) => {
      const entity = snapshot.entities[id];
      if (!entity) return;
      const kind = entityKind(entity);
      if (kind === "other") return;
      dispatch({ type: "selectEntity", kind, id });
    },
    [snapshot.entities]
  );

  const submit = useCallback(
    async (availability: CommandAvailability, parameters: Record<string, JSONValue>, errorFormState?: CommandFormState) => {
      if (!selectedEntity) return;
      setSubmitting(true);
      setSubmitError(undefined);
      try {
        await atlas.submitCommand({ entityId: selectedEntity.entity_id, command: availability.command, parameters });
        setCommandForm(null);
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        setSubmitError(message);
        setCommandForm((current) => current ?? errorFormState ?? null);
      } finally {
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
      setCommandForm(null);
      setSubmitError(undefined);
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
      <div className="app-error">
        <span>Could not connect to Atlas Core.</span>
        <code>{atlas.error}</code>
      </div>
    );
  }

  const activeList: ListKind | null =
    sidebar.view.mode === "list" ? sidebar.view.list : selection ? listForKind(selection.kind) : null;

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
                dispatch({ type: "selectEntity", kind, id: entity.entity_id });
              }}
              onPickCommand={pickSidebarCommand}
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
            <MapView
              sources={sources}
              styleUrl={atlas.config?.mapStyleUrl}
              selectedId={selectedId}
              editing={edit ? { geometry: edit.draft, onChange: (geometry) => setEdit((current) => (current ? { ...current, draft: geometry } : current)) } : undefined}
              onSelectEntity={selectEntityById}
              onMapContextMenu={onMapContextMenu}
              onBackgroundClick={() => {
                setMapMenu(null);
                dispatch({ type: "clearSelection" });
              }}
            />
            <ConnectionBadge running={atlas.health.running} healthy={atlas.health.healthy} degraded={atlas.health.degraded} />
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

      {commandForm && selectedEntity ? (
        <CommandForm
          command={commandForm.availability.command}
          targeting={commandForm.availability.targeting}
          formParameters={commandForm.availability.formParameters}
          mapPoint={commandForm.mapPoint}
          submitting={submitting}
          error={submitError}
          onCancel={() => setCommandForm(null)}
          onSubmit={(parameters) => void submit(commandForm.availability, parameters, commandForm)}
        />
      ) : null}
    </>
  );
}

type PanelBodyProps = {
  snapshot: AtlasSnapshot;
  sidebar: SidebarState;
  selectedEntity?: EntityResource;
  catalog?: CommandCatalog;
  edit: EditState | null;
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
    return <AssetInspector entity={selectedEntity} snapshot={snapshot} catalog={catalog} onPickCommand={props.onPickCommand} />;
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

function ListBody({ list, snapshot, selectedEntity, catalog, onSelectEntity, onPickCommand }: { list: ListKind } & PanelBodyProps) {
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

function ConnectionBadge({ running, healthy, degraded }: { running: boolean; healthy: boolean; degraded: boolean }) {
  const { color, label } = degraded
    ? { color: "var(--warning)", label: "Reconnecting" }
    : running && healthy
      ? { color: "var(--success)", label: "Live" }
      : { color: "var(--text-3)", label: "Connecting" };
  return (
    <div className="map-overlay-tl">
      <span className="conn-dot" style={{ background: color }} />
      <span>{label}</span>
    </div>
  );
}

function panelTitle(sidebar: SidebarState, selectionKind?: EntityKind): string {
  if (sidebar.view.mode === "list") return LIST_TITLES[sidebar.view.list];
  return selectionKind ? KIND_TITLES[selectionKind] : "Inspector";
}
