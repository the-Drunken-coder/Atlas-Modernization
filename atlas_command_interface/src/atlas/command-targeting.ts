import type {
  CommandCatalog,
  CommandDefinition,
  CommandManifestEntry,
  EntityResource
} from "@the-drunken-coder/atlas-sdk";
import {
  COMMAND_INPUT_REGISTRY,
  type CommandInputRegistration,
  type CommandInputRegistry,
  type CommandTargeting
} from "../features/commands/command-input-registry.js";

export type { CommandTargeting } from "../features/commands/command-input-registry.js";

export type CommandAvailability = {
  command: CommandDefinition;
  manifest: CommandManifestEntry;
  input: CommandInputRegistration;
};

/**
 * Commands are operator-visible only when Protocol defines them, the selected
 * Asset advertises them, and a purpose-built input is registered locally.
 */
export function commandsForTargeting(
  catalog: CommandCatalog,
  entity: EntityResource,
  targeting: CommandTargeting,
  registry: CommandInputRegistry = COMMAND_INPUT_REGISTRY
): CommandAvailability[] {
  if (entity.entity_type !== "asset") return [];
  const manifest = new Map(entity.command_manifest?.map((entry) => [entry.command, entry]) ?? []);
  const commands: CommandAvailability[] = [];
  for (const command of catalog) {
    const manifestEntry = manifest.get(command.command);
    const input = registry[command.command];
    if (manifestEntry && input?.targeting === targeting) {
      commands.push({ command, manifest: manifestEntry, input });
    }
  }
  return commands;
}
