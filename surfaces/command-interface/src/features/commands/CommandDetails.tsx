import type { CommandDefinition, CommandManifestEntry } from "@the-drunken-coder/atlas-sdk";

export type CommandDetailsProps = {
  command: CommandDefinition;
  manifest: CommandManifestEntry;
  density?: "row" | "menu";
};

/** Visible Protocol, Asset, and execution-contract details for an available Command. */
export function CommandDetails({ command, manifest, density = "row" }: CommandDetailsProps) {
  return (
    <span className={`command-details command-details--${density}`}>
      <span className="command-details__description">
        <span className="command-details__label">Protocol</span> {command.description}
      </span>
      <span className="command-details__description">
        <span className="command-details__label">Asset</span> {manifest.description}
      </span>
      <span className="command-details__capabilities">
        {manifest.scheduling === "queued" ? "Queued" : "Immediate"} · Cancel {manifest.supports_cancel ? "yes" : "no"} ·{" "}
        Progress {manifest.supports_progress ? "yes" : "no"}
      </span>
    </span>
  );
}
