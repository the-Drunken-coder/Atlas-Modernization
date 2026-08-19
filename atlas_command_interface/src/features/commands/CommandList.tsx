import type { CommandAvailability } from "../../atlas/command-targeting.js";

type CommandListProps = {
  availabilities: CommandAvailability[];
  onPick: (availability: CommandAvailability) => void;
  emptyLabel?: string;
};

/** Sidebar list of Commands supported by both Protocol and the selected Asset. */
export function CommandList({ availabilities, onPick, emptyLabel }: CommandListProps) {
  if (availabilities.length === 0) {
    return <div className="panel__empty">{emptyLabel ?? "No commands available"}</div>;
  }
  return (
    <div className="stack">
      {availabilities.map((availability) => {
        const { command, manifest } = availability;
        return (
          <button
            key={command.command}
            type="button"
            className="command-row"
            title={command.description}
            onClick={() => onPick(availability)}
          >
            <span className="command-row__main">
              <span className="command-row__title">{command.name}</span>
              <span className="command-row__sub">{manifest.description}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
