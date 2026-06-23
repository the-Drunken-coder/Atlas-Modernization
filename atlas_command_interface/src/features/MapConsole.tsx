import { useCallback, useMemo, useReducer } from "react";
import type { EntityResource } from "../../../atlas_sdk/src/index.js";
import { entityKind, entityPosition, type EntityKind } from "../atlas/entities.js";
import { countsByKind, entitiesByKind, getEntity } from "../atlas/selectors.js";
import type { AtlasSnapshot } from "../atlas/store.js";
import { useAtlas } from "../state/atlas-context.js";
import { initialSidebarState, listForKind, sidebarReducer, type ListKind, type SidebarState } from "../state/selection.js";
import { AppShell } from "../ui/layout/AppShell.js";
import { SidebarPanel } from "../ui/layout/SidebarPanel.js";
import { SidebarRail } from "../ui/layout/SidebarRail.js";
import { MapView, buildMapSources } from "../ui/map/MapView.js";
import { AssetInspector } from "./assets/AssetInspector.js";
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

export function MapConsole() {
  const atlas = useAtlas();
  const { snapshot } = atlas;
  const [sidebar, dispatch] = useReducer(sidebarReducer, initialSidebarState);

  const selection = sidebar.selection;
  const selectedEntity = getEntity(snapshot, selection?.id);
  const selectedId = selection?.id;

  const sources = useMemo(() => buildMapSources(Object.values(snapshot.entities), selectedId), [snapshot.entities, selectedId]);
  const counts = useMemo(() => countsByKind(snapshot), [snapshot]);
  const initialCenter = useMemo(() => firstPosition(snapshot), [snapshot]);

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

  if (atlas.status === "loading") {
    return (
      <div className="app-loading">
        <span>Connecting to Atlas Core...</span>
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

  return (
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
            onSelectEntity={(entity) => {
              const kind = entityKind(entity);
              if (kind === "other") return;
              dispatch({ type: "selectEntity", kind, id: entity.entity_id });
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
            initialCenter={initialCenter}
            onSelectEntity={selectEntityById}
            onBackgroundClick={() => dispatch({ type: "clearSelection" })}
          />
          <ConnectionBadge running={atlas.health.running} healthy={atlas.health.healthy} degraded={atlas.health.degraded} />
        </>
      }
    />
  );
}

type PanelBodyProps = {
  snapshot: AtlasSnapshot;
  sidebar: SidebarState;
  selectedEntity?: EntityResource;
  onSelectEntity: (entity: EntityResource) => void;
};

function PanelBody(props: PanelBodyProps) {
  const { snapshot, sidebar, selectedEntity } = props;

  if (sidebar.view.mode === "list") {
    return <ListBody list={sidebar.view.list} {...props} />;
  }

  if (!selectedEntity) {
    return <div className="panel__empty">This item is no longer available.</div>;
  }

  const kind = entityKind(selectedEntity);
  if (kind === "asset") {
    return <AssetInspector entity={selectedEntity} snapshot={snapshot} />;
  }
  if (kind === "track") {
    return <TrackInspector entity={selectedEntity} />;
  }
  if (kind === "geofeature") {
    return <GeofeatureInspector entity={selectedEntity} />;
  }
  return <div className="panel__empty">Unsupported entity type.</div>;
}

function ListBody({ list, snapshot, selectedEntity, onSelectEntity }: { list: ListKind } & PanelBodyProps) {
  if (list === "commands") {
    return <div className="panel__empty">Commanding is not available in this read-only console.</div>;
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

function firstPosition(snapshot: AtlasSnapshot): [number, number] | undefined {
  for (const entity of Object.values(snapshot.entities)) {
    const position = entityPosition(entity);
    if (position) return position;
  }
  return undefined;
}
