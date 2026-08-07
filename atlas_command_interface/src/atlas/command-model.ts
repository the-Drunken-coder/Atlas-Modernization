import type {
  CommandCatalog,
  CommandDefinition,
  CommandParameterSchema,
  EntityResource,
  JSONValue
} from "@the-drunken-coder/atlas-sdk";

export type { CommandCatalog, CommandDefinition, CommandParameterSchema } from "@the-drunken-coder/atlas-sdk";

export type CommandTaskCreateRequest = {
  status: "pending";
  entity_id: string;
  components: {
    command: { type: string; id: string };
    parameters: Record<string, JSONValue>;
  };
};

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
  const command = catalog.commands.find((candidate) => candidate.id === commandId);
  if (!command) {
    throw new CommandModelError("UNKNOWN_COMMAND", `Unknown command ${commandId}`, { command_id: commandId });
  }
  return command;
}

export function supportedCommandIds(entity: EntityResource): string[] | undefined {
  const supported = entity.components.task_catalog?.supported_tasks;
  if (!Array.isArray(supported)) {
    return undefined;
  }
  return supported.filter((value): value is string => typeof value === "string" && value.trim() !== "");
}

export function commandsForEntity(catalog: CommandCatalog, entity: EntityResource): CommandDefinition[] {
  if (entity.entity_type !== "asset") {
    return [];
  }
  const supported = supportedCommandIds(entity);
  if (supported === undefined) {
    return [];
  }
  const supportedSet = new Set(supported);
  return catalog.commands.filter((command) => supportedSet.has(command.id));
}

export function assertEntitySupportsCommand(entity: EntityResource, commandId: string): void {
  if (entity.entity_type !== "asset") {
    throw new CommandModelError("UNSUPPORTED_COMMAND", "Only assets can receive commands", {
      entity_id: entity.entity_id,
      entity_type: entity.entity_type,
      command_id: commandId
    });
  }
  const supported = supportedCommandIds(entity);
  if (supported === undefined || !supported.includes(commandId)) {
    throw new CommandModelError(
      "UNSUPPORTED_COMMAND",
      `${entity.entity_id} does not advertise support for ${commandId}`,
      {
        entity_id: entity.entity_id,
        command_id: commandId
      }
    );
  }
}

export function coerceParameters(command: CommandDefinition, rawParameters: unknown): Record<string, JSONValue> {
  const raw = rawParameters === undefined || rawParameters === null ? {} : requireParameterRecord(rawParameters);
  const result: Record<string, JSONValue> = {};
  const schemaEntries = Object.entries(command.parameters_schema);
  const knownNames = new Set(schemaEntries.map(([name]) => name));

  for (const key of Object.keys(raw)) {
    if (!knownNames.has(key)) {
      throw new CommandModelError("INVALID_PARAMETERS", `Unknown parameter ${key}`, { parameter: key });
    }
  }

  for (const [name, schema] of schemaEntries) {
    const value = raw[name];
    if (isEmptyOptionalInput(value)) {
      if (schema.required) {
        throw new CommandModelError("INVALID_PARAMETERS", `${name} is required`, { parameter: name });
      }
      continue;
    }
    result[name] = coerceParameterValue(name, schema, value);
  }

  return result;
}

export function buildCommandTaskRequest(options: {
  entityId: string;
  command: CommandDefinition;
  parameters: Record<string, JSONValue>;
}): CommandTaskCreateRequest {
  return {
    status: "pending",
    entity_id: options.entityId,
    components: {
      command: {
        type: options.command.id,
        id: options.command.id
      },
      parameters: options.parameters
    }
  };
}

export function commandLabel(command: CommandDefinition): string {
  return `${command.name} (${command.id})`;
}

function coerceParameterValue(name: string, schema: CommandParameterSchema, value: unknown): JSONValue {
  if (schema.type === "string") {
    if (typeof value !== "string") {
      throw new CommandModelError("INVALID_PARAMETERS", `${name} must be a string`, { parameter: name });
    }
    return value;
  }
  if (schema.type === "boolean") {
    if (typeof value === "boolean") return value;
    if (value === "true") return true;
    if (value === "false") return false;
    throw new CommandModelError("INVALID_PARAMETERS", `${name} must be a boolean`, { parameter: name });
  }

  const numberValue =
    typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  if (!Number.isFinite(numberValue)) {
    throw new CommandModelError("INVALID_PARAMETERS", `${name} must be a finite number`, { parameter: name });
  }
  if (schema.minimum !== undefined && numberValue < schema.minimum) {
    throw new CommandModelError("INVALID_PARAMETERS", `${name} must be >= ${schema.minimum}`, {
      parameter: name,
      minimum: schema.minimum
    });
  }
  if (schema.maximum !== undefined && numberValue > schema.maximum) {
    throw new CommandModelError("INVALID_PARAMETERS", `${name} must be <= ${schema.maximum}`, {
      parameter: name,
      maximum: schema.maximum
    });
  }
  return numberValue;
}

function requireParameterRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new CommandModelError("INVALID_PARAMETERS", "parameters must be an object", { path: "parameters" });
}

function isEmptyOptionalInput(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}
