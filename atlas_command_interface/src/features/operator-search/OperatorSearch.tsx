import { Overlay2 } from "@blueprintjs/core";
import type { ItemListRendererProps, ItemRendererProps, QueryListRendererProps } from "@blueprintjs/select";
import { QueryList } from "@blueprintjs/select";
import type { CommandCatalog, EntityResource } from "@the-drunken-coder/atlas-sdk";
import { useMemo, useState } from "react";
import { type CommandAvailability, commandsForTargeting } from "../../atlas/command-targeting.js";
import { ENTITY_DESCRIPTORS, type EntityKind, entityDisplayName, entityKind } from "../../atlas/entities.js";
import { countsByKind, listEntities } from "../../atlas/selectors.js";
import type { AtlasSnapshot } from "../../atlas/store.js";
import type { ListKind } from "../../state/selection.js";
import type { CommandInputRegistry } from "../commands/command-input-registry.js";
import { COMMAND_INPUT_REGISTRY } from "../commands/command-input-registry.js";
import { entityMeta, entitySearchText } from "../EntityList.js";
import { useHeartbeatClock } from "../useHeartbeatClock.js";
import { operatorSearchShortcutLabel } from "./operator-search-shortcut.js";
import "./operator-search.css";

export type CommandDataStatus = "ready" | "loading" | "unavailable";

type OperatorSearchItemBase = {
  key: string;
  group: string;
  kindLabel: string;
  title: string;
  description: string;
  identity: string;
  state: string;
  searchText: string;
};

type EntitySearchItem = OperatorSearchItemBase & {
  type: "entity";
  entity: EntityResource;
  entityKind: EntityKind;
};

type DestinationSearchItem = OperatorSearchItemBase & {
  type: "destination";
  destination: ListKind;
};

type CommandSearchItem = OperatorSearchItemBase & {
  type: "command";
  availability: CommandAvailability;
  disabledReason?: string;
};

type StatusSearchItem = OperatorSearchItemBase & {
  type: "status";
};

export type OperatorSearchItem = EntitySearchItem | DestinationSearchItem | CommandSearchItem | StatusSearchItem;

type OperatorSearchProps = {
  isOpen: boolean;
  snapshot: AtlasSnapshot;
  selectedEntity?: EntityResource;
  catalog?: CommandCatalog;
  commandDataStatus: CommandDataStatus;
  commandRegistry?: CommandInputRegistry;
  submitting: boolean;
  onClose: () => void;
  onAfterClose: () => void;
  onSelectEntity: (entity: EntityResource) => void;
  onSelectDestination: (destination: ListKind) => void;
  onSelectCommand: (availability: CommandAvailability) => void;
};

export function OperatorSearch({
  isOpen,
  snapshot,
  selectedEntity,
  catalog,
  commandDataStatus,
  commandRegistry = COMMAND_INPUT_REGISTRY,
  submitting,
  onClose,
  onAfterClose,
  onSelectEntity,
  onSelectDestination,
  onSelectCommand
}: OperatorSearchProps) {
  const [query, setQuery] = useState("");
  const now = useHeartbeatClock();
  const items = useMemo(
    () =>
      buildOperatorSearchItems({
        snapshot,
        selectedEntity,
        catalog,
        commandDataStatus,
        commandRegistry,
        submitting,
        now
      }),
    [snapshot, selectedEntity, catalog, commandDataStatus, commandRegistry, submitting, now]
  );
  const selectedAssetName =
    selectedEntity && entityKind(selectedEntity) === "asset" ? entityDisplayName(selectedEntity) : undefined;
  const platform = navigator.platform;

  const close = () => {
    setQuery("");
    onClose();
  };

  const selectItem = (item: OperatorSearchItem) => {
    if (item.type === "status" || (item.type === "command" && item.disabledReason)) return;
    close();
    if (item.type === "entity") onSelectEntity(item.entity);
    else if (item.type === "destination") onSelectDestination(item.destination);
    else onSelectCommand(item.availability);
  };

  const renderQueryList = (listProps: QueryListRendererProps<OperatorSearchItem>) => (
    <Overlay2
      isOpen={isOpen}
      hasBackdrop
      className="bp6-omnibar-overlay"
      backdropClassName="operator-search__backdrop"
      portalClassName="operator-search__portal"
      shouldReturnFocusOnClose
      transitionDuration={0}
      onClose={close}
      onClosed={onAfterClose}
    >
      <div className="bp6-omnibar" onKeyDown={listProps.handleKeyDown} onKeyUp={listProps.handleKeyUp}>
        <div className="operator-search__query">
          <input
            autoFocus
            aria-activedescendant={listProps.activeItemId}
            aria-autocomplete="list"
            aria-controls={listProps.listId}
            aria-expanded={isOpen}
            aria-label="Search Atlas"
            className="bp6-input operator-search__input"
            placeholder="Search Atlas"
            role="combobox"
            type="search"
            value={listProps.query}
            onChange={listProps.handleQueryChange}
          />
          <span className="operator-search__context" aria-hidden="true">
            {selectedAssetName ? (
              <span className="operator-search__asset">
                <strong>{selectedAssetName}</strong>
                <small>selected asset</small>
              </span>
            ) : null}
            <kbd>{operatorSearchShortcutLabel(platform)}</kbd>
          </span>
        </div>
        {listProps.itemList}
      </div>
    </Overlay2>
  );

  return (
    <QueryList<OperatorSearchItem>
      items={items}
      itemsEqual="key"
      itemDisabled={(item) => item.type === "status" || (item.type === "command" && item.disabledReason !== undefined)}
      itemListPredicate={filterOperatorSearchItems}
      itemListRenderer={renderOperatorItemList}
      itemRenderer={renderOperatorItem}
      listId="atlas-operator-search-results"
      menuProps={{ role: "menu" }}
      query={query}
      renderer={renderQueryList}
      resetOnQuery
      onItemSelect={selectItem}
      onQueryChange={setQuery}
    />
  );
}

export function buildOperatorSearchItems({
  snapshot,
  selectedEntity,
  catalog,
  commandDataStatus,
  commandRegistry,
  submitting,
  now
}: {
  snapshot: AtlasSnapshot;
  selectedEntity?: EntityResource;
  catalog?: CommandCatalog;
  commandDataStatus: CommandDataStatus;
  commandRegistry: CommandInputRegistry;
  submitting: boolean;
  now: number;
}): OperatorSearchItem[] {
  const entityItems = listEntities(snapshot).map<EntitySearchItem>((entity) => {
    const kind = entity.entity_type;
    const descriptor = ENTITY_DESCRIPTORS[kind];
    const state = entityMeta(entity, now);
    return {
      type: "entity",
      key: `entity:${entity.entity_id}`,
      group: "Entities",
      kindLabel: kind === "geofeature" ? "Geo" : descriptor.title,
      title: entityDisplayName(entity),
      description: kind === "geofeature" ? "Open inspector and fit geometry" : "Open inspector and claim camera",
      identity: entity.entity_id,
      state,
      searchText: `${entitySearchText(entity)} ${state}`,
      entity,
      entityKind: kind
    };
  });

  const counts = countsByKind(snapshot);
  const destinationItems: DestinationSearchItem[] = [
    destinationItem("assets", "List", "Assets", `${counts.asset} current`),
    destinationItem("tracks", "List", "Tracks", `${counts.track} current`),
    destinationItem("geofeatures", "List", "Geo Features", `${counts.geofeature} current`),
    destinationItem(
      "commands",
      "List",
      "Commands",
      selectedEntity && entityKind(selectedEntity) === "asset"
        ? `${entityDisplayName(selectedEntity)} selected`
        : "No asset selected"
    ),
    destinationItem("apiKeys", "Admin", "API Keys", "API key panel")
  ];

  const commandItems = buildCommandItems({
    selectedEntity,
    catalog,
    commandDataStatus,
    commandRegistry,
    submitting
  });
  return [...entityItems, ...destinationItems, ...commandItems];
}

function destinationItem(
  destination: ListKind,
  kindLabel: "Admin" | "List",
  title: string,
  state: string
): DestinationSearchItem {
  return {
    type: "destination",
    key: `destination:${destination}`,
    group: "Go to",
    kindLabel,
    title,
    description: kindLabel === "Admin" ? "Open admin view" : "Open current list",
    identity: "/map",
    state,
    searchText: `${title} ${destination} ${kindLabel} ${state}`,
    destination
  };
}

function buildCommandItems({
  selectedEntity,
  catalog,
  commandDataStatus,
  commandRegistry,
  submitting
}: {
  selectedEntity?: EntityResource;
  catalog?: CommandCatalog;
  commandDataStatus: CommandDataStatus;
  commandRegistry: CommandInputRegistry;
  submitting: boolean;
}): Array<CommandSearchItem | StatusSearchItem> {
  if (!selectedEntity || entityKind(selectedEntity) !== "asset") return [];
  const group = `Commands for ${entityDisplayName(selectedEntity)}`;
  if (!catalog) return [commandStatus(group, "Command Catalog unavailable")];
  if (catalog.length === 0) return [commandStatus(group, "No Commands are defined in Atlas Protocol")];
  if (commandDataStatus === "loading") return [commandStatus(group, "Loading Asset Commands")];
  if (commandDataStatus === "unavailable") return [commandStatus(group, "Asset Commands unavailable")];

  const availabilities = [
    ...commandsForTargeting(catalog, selectedEntity, "none", commandRegistry),
    ...commandsForTargeting(catalog, selectedEntity, "map_point", commandRegistry)
  ];
  if (availabilities.length === 0) {
    return [
      commandStatus(
        group,
        selectedEntity.command_manifest?.length
          ? "No operator inputs are available for this Asset's Commands"
          : "This Asset has no Commands"
      )
    ];
  }
  return availabilities.map((availability) => {
    const { command, manifest, input } = availability;
    const state = input.targeting === "map_point" ? "Target on map" : input.Form ? "Open input" : "Run command";
    return {
      type: "command",
      key: `command:${command.command}`,
      group,
      kindLabel: "Command",
      title: command.name,
      description: manifest.description,
      identity: command.command,
      state,
      searchText: `${command.name} ${command.command} ${command.description} ${manifest.description} ${state}`,
      availability,
      disabledReason: submitting ? "Tasking pending" : undefined
    };
  });
}

function commandStatus(group: string, title: string): StatusSearchItem {
  return {
    type: "status",
    key: `status:${title}`,
    group,
    kindLabel: "Status",
    title,
    description: "",
    identity: "",
    state: "",
    searchText: title
  };
}

export function filterOperatorSearchItems(query: string, items: OperatorSearchItem[]): OperatorSearchItem[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return items.filter((item) => item.type !== "entity");
  return items.filter((item) => {
    const searchText =
      `${item.title} ${item.identity} ${item.kindLabel} ${item.group} ${item.searchText}`.toLocaleLowerCase();
    return terms.every((term) => searchText.includes(term));
  });
}

function renderOperatorItem(item: OperatorSearchItem, props: ItemRendererProps): React.JSX.Element | null {
  if (!props.modifiers.matchesPredicate) return null;
  if (item.type === "status") {
    return (
      <li key={item.key} ref={props.ref} className="operator-search__status" role="presentation">
        <span>{item.title}</span>
      </li>
    );
  }
  const disabledReason = item.type === "command" ? item.disabledReason : undefined;
  return (
    <li key={item.key} ref={props.ref} className="operator-search__item" role="presentation">
      <button
        type="button"
        id={props.id}
        className="operator-search__row"
        data-active={props.modifiers.active || undefined}
        disabled={props.modifiers.disabled}
        onClick={props.handleClick}
        onMouseEnter={props.handleFocus}
        role="menuitem"
        tabIndex={-1}
      >
        <span className={`operator-search__kind${item.type === "entity" ? ` is-${item.entityKind}` : ""}`}>
          {item.kindLabel}
        </span>
        <span className="operator-search__main">
          <strong>{item.title}</strong>
          <small>{item.description}</small>
        </span>
        <span className="operator-search__meta">
          <code>{item.identity}</code>
          <small data-disabled-reason={disabledReason ? true : undefined}>{disabledReason ?? item.state}</small>
        </span>
      </button>
    </li>
  );
}

function renderOperatorItemList(props: ItemListRendererProps<OperatorSearchItem>): React.JSX.Element {
  const rows: React.JSX.Element[] = [];
  let group: string | undefined;
  props.filteredItems.forEach((item, index) => {
    if (item.group !== group) {
      group = item.group;
      rows.push(
        <li key={`group:${group}`} className="operator-search__section" role="presentation">
          {group}
        </li>
      );
    }
    const row = props.renderItem(item, index);
    if (row) rows.push(row);
  });
  const resultCount = props.filteredItems.filter((item) => item.type !== "status").length;
  return (
    <div className="operator-search__results">
      <div className="operator-search__columns" aria-hidden="true">
        <span>Kind</span>
        <span>Result</span>
        <span>Identity or state</span>
      </div>
      <ul
        {...props.menuProps}
        ref={props.itemsParentRef}
        className={["operator-search__list", props.menuProps?.className].filter(Boolean).join(" ")}
      >
        {rows.length ? (
          rows
        ) : (
          <li className="operator-search__empty" role="presentation">
            No results for "{props.query}"
          </li>
        )}
      </ul>
      <footer className="operator-search__footer">
        <span>{resultCount} results</span>
        <span aria-hidden="true">↑↓ move · ↵ open · esc close</span>
      </footer>
    </div>
  );
}
