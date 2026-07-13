import type { CommandAvailability } from "../../atlas/command-targeting.js";

type CommandListProps = {
  availabilities: CommandAvailability[];
  additionalUnavailable?: CommandAvailability[];
  onPick: (availability: CommandAvailability) => void;
  emptyLabel?: string;
};

/** Sidebar list of available commands, with unavailable reasons collapsed below. */
export function CommandList({ availabilities, additionalUnavailable = [], onPick, emptyLabel }: CommandListProps) {
  const available = availabilities.filter((availability) => !availability.disabled);
  const unavailable = [...availabilities.filter((availability) => availability.disabled), ...additionalUnavailable];

  if (available.length === 0 && unavailable.length === 0) {
    return <div className="panel__empty">{emptyLabel ?? "No commands available"}</div>;
  }

  return (
    <div className="command-list">
      <div className="stack">
        {available.map((availability) => {
          const { command, requiresForm } = availability;
          return (
            <button key={command.id} type="button" className="command-row" title={command.description} onClick={() => onPick(availability)}>
              <span className="command-row__main">
                <span className="command-row__title">{command.name}</span>
                <span className="command-row__sub">{requiresForm ? `${command.id} · needs parameters` : command.id}</span>
              </span>
            </button>
          );
        })}
      </div>
      {unavailable.length > 0 ? (
        <details className="unavailable-commands">
          <summary>
            {unavailable.length} unavailable {unavailable.length === 1 ? "command" : "commands"}
          </summary>
          <ul>
            {unavailable.map(({ command, disabledReason }) => (
              <li key={command.id}>
                <span className="unavailable-command__name">{command.name}</span>
                <span className="unavailable-command__reason">{disabledReason}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
