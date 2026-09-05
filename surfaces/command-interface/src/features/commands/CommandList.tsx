import { Button } from "@blueprintjs/core";
import type { CommandAvailability } from "../../atlas/command-targeting.js";
import { CommandDetails } from "./CommandDetails.js";

type CommandListProps = {
  availabilities: CommandAvailability[];
  onPick: (availability: CommandAvailability) => void;
  emptyLabel?: string;
  disabled?: boolean;
};

/** Sidebar list of Commands supported by both Protocol and the selected Asset. */
export function CommandList({ availabilities, onPick, emptyLabel, disabled = false }: CommandListProps) {
  if (availabilities.length === 0) {
    return <div className="panel__empty">{emptyLabel ?? "No commands available"}</div>;
  }
  return (
    <div className="stack">
      {availabilities.map((availability) => {
        const { command, manifest } = availability;
        return (
          <Button
            key={command.command}
            type="button"
            className="command-row"
            fill
            alignText="start"
            disabled={disabled}
            onClick={() => onPick(availability)}
          >
            <span className="command-row__main">
              <span className="command-row__title">{command.name}</span>
              <CommandDetails command={command} manifest={manifest} />
            </span>
          </Button>
        );
      })}
    </div>
  );
}
