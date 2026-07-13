import type { EntityResource } from "@the-drunken-coder/atlas-sdk";
import type { CommandCatalog } from "../../atlas/command-model.js";
import { commandsForTargeting, type CommandAvailability } from "../../atlas/command-targeting.js";
import { Button } from "../../ui/primitives/controls.js";
import { CommandList } from "./CommandList.js";

type CommandActionsProps = {
  entity: EntityResource;
  catalog?: CommandCatalog;
  positionPicking: boolean;
  onPickCommand: (availability: CommandAvailability) => void;
  onTogglePositionPicking: () => void;
};

export function CommandActions({ entity, catalog, positionPicking, onPickCommand, onTogglePositionPicking }: CommandActionsProps) {
  const sidebarCommands = catalog ? commandsForTargeting(catalog, entity, "none") : [];
  const positionCommands = catalog ? commandsForTargeting(catalog, entity, "map_point") : [];
  const unavailablePositionCommands = positionCommands.filter((availability) => availability.disabled);
  const hasAvailablePositionCommand = positionCommands.length > unavailablePositionCommands.length;

  return (
    <div className="command-actions">
      {hasAvailablePositionCommand ? (
        <div className="position-command-action">
          <Button variant={positionPicking ? "default" : "primary"} aria-pressed={positionPicking} onClick={onTogglePositionPicking}>
            {positionPicking ? "Cancel position selection" : "Choose map position"}
          </Button>
          <span className="field__hint">
            {positionPicking
              ? "Click or tap the map, or press Enter to use its center."
              : "Choose a point for position commands. Right-click remains available."}
          </span>
        </div>
      ) : null}
      {sidebarCommands.length > 0 || unavailablePositionCommands.length > 0 || !hasAvailablePositionCommand ? (
        <CommandList
          availabilities={sidebarCommands}
          additionalUnavailable={unavailablePositionCommands}
          onPick={onPickCommand}
          emptyLabel={catalog ? "No commands available" : "Command catalog unavailable"}
        />
      ) : null}
    </div>
  );
}
