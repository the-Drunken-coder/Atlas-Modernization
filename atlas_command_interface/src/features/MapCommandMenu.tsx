import type { EntityResource } from "@the-drunken-coder/atlas-sdk";
import type { CommandCatalog } from "../atlas/command-model.js";
import { type CommandAvailability, commandsForTargeting } from "../atlas/command-targeting.js";
import { ContextMenu, type MenuItemDef } from "../ui/primitives/Menu.js";
import type { MapMenuState } from "./useCommandFlow.js";

type MapCommandMenuProps = {
  menu: MapMenuState;
  entity?: EntityResource;
  catalog?: CommandCatalog;
  onPickCommand: (availability: CommandAvailability, point: { lat: number; lng: number }) => void;
  onClose: () => void;
};

/** Context menu listing the selected asset's map-point commands for a clicked coordinate. */
export function MapCommandMenu({ menu, entity, catalog, onPickCommand, onClose }: MapCommandMenuProps) {
  const items: MenuItemDef[] =
    entity && catalog
      ? commandsForTargeting(catalog, entity, "map_point").map((availability) => ({
          key: availability.command.id,
          title: availability.command.name,
          sub: availability.requiresForm ? "needs parameters" : undefined,
          disabled: availability.disabled,
          disabledReason: availability.disabledReason,
          onSelect: () => onPickCommand(availability, { lat: menu.lat, lng: menu.lng })
        }))
      : [];

  return (
    <ContextMenu
      x={menu.x}
      y={menu.y}
      header={`Commands · ${menu.lat.toFixed(4)}, ${menu.lng.toFixed(4)}`}
      items={items}
      emptyLabel="No position commands"
      onClose={onClose}
    />
  );
}
