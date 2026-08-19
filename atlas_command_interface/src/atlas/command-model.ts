import type {
  CommandCatalog,
  CommandDefinition,
  EntityResource,
  JSONValue,
  TaskCreateRequest
} from "@the-drunken-coder/atlas-sdk";

export type { CommandCatalog, CommandDefinition } from "@the-drunken-coder/atlas-sdk";

export class CommandModelError extends Error {
  readonly code: string;
  readonly details: Record<string, JSONValue>;

  constructor(code: string, message: string, details: Record<string, JSONValue> = {}) {
    super(message);
    this.name = "CommandModelError";
    this.code = code;
    this.details = details;
  }
}

export function commandById(catalog: CommandCatalog, commandId: string): CommandDefinition {
  const command = catalog.find((candidate) => candidate.command === commandId);
  if (!command) {
    throw new CommandModelError("UNKNOWN_COMMAND", `Unknown Command ${commandId}`, { command: commandId });
  }
  return command;
}

export function supportedCommandIds(entity: EntityResource): string[] {
  return entity.command_manifest?.map((entry) => entry.command) ?? [];
}

export function buildCommandTaskRequest(options: {
  assetId: string;
  command: CommandDefinition;
  input: JSONValue;
}): TaskCreateRequest {
  return { asset_id: options.assetId, command: options.command.command, input: options.input };
}
