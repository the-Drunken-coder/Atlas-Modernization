import type { CommandAvailability } from "../../atlas/command-targeting.js";

type CommandListProps = {
  availabilities: CommandAvailability[];
  onPick: (availability: CommandAvailability) => void;
  emptyLabel?: string;
};

/** Sidebar list of non-position commands. Valid first, disabled greyed below. */
export function CommandList({ availabilities, onPick, emptyLabel }: CommandListProps) {
  if (availabilities.length === 0) {
    return <div className="panel__empty">{emptyLabel ?? "No commands available"}</div>;
  }
  return (
    <div className="stack">
      {availabilities.map((availability) => {
        const { command, disabled, disabledReason, requiresForm } = availability;
        return (
          <button
            key={command.id}
            type="button"
            className="command-row"
            disabled={disabled}
            title={disabled ? disabledReason : command.description}
            onClick={() => onPick(availability)}
          >
            <span className="command-row__main">
              <span className="command-row__title">{command.name}</span>
              <span className="command-row__sub">
                {disabled ? disabledReason : requiresForm ? `${command.id} · needs parameters` : command.id}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
