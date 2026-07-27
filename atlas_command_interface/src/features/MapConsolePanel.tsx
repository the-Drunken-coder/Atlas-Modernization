import type { EntityResource } from "@the-drunken-coder/atlas-sdk";
import type { CommandCatalog } from "../atlas/command-model.js";
import { type CommandAvailability, commandsForTargeting } from "../atlas/command-targeting.js";
import { type EntityKind, entityKind } from "../atlas/entities.js";
import type { UiGeometry } from "../atlas/geometry.js";
import { entitiesByKind } from "../atlas/selectors.js";
import type { AtlasSnapshot } from "../atlas/store.js";
import type { ListKind, SidebarState } from "../state/selection.js";
import { APIKeysPanel } from "./admin/APIKeysPanel.js";
import { AssetInspector } from "./assets/AssetInspector.js";
import { CommandList } from "./commands/CommandList.js";
import { EntityList } from "./EntityList.js";
import { GeofeatureInspector } from "./geofeatures/GeofeatureInspector.js";
import { TrackInspector } from "./tracks/TrackInspector.js";
import type { EditState } from "./useEditSession.js";

const LIST_TITLES: Record<ListKind, string> = {
  assets: "Assets",
  tracks: "Tracks",
  geofeatures: "Geo Features",
  commands: "Commands",
  apiKeys: "API Keys"
};

const KIND_TITLES: Record<EntityKind, string> = { asset: "Asset", track: "Track", geofeature: "Geo Feature" };

export function panelTitle(sidebar: SidebarState, selectionKind?: EntityKind): string {
  if (sidebar.view.mode === "list") return LIST_TITLES[sidebar.view.list];
  return selectionKind ? KIND_TITLES[selectionKind] : "Inspector";
}

type MapConsolePanelProps = {
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

/** Sidebar panel body: the active list, or the inspector for the selected entity. */
export function MapConsolePanel(props: MapConsolePanelProps) {
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
}: { list: ListKind } & MapConsolePanelProps) {
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
