import type { EntityResource, JSONValue, ObjectResponse, TaskCreateRequest, TaskResource } from "../../../atlas_sdk/src/index.js";

export const COMMAND_CATALOG_OBJECT_ID = "command_catalog";

export type ParameterType = "string" | "number" | "boolean";

export type CommandParameterSchema = {
  type: ParameterType;
  description: string;
  required: boolean;
  minimum?: number;
  maximum?: number;
};

export type CommandDefinition = {
  id: string;
  name: string;
  description: string;
  parameters_schema: Record<string, CommandParameterSchema>;
};

export type CommandCatalog = {
  type: "command_catalog";
  name: string;
  description: string;
  commands: CommandDefinition[];
};

export type CommandSubmitRequest = {
  entity_id: string;
  command_id: string;
  parameters?: Record<string, unknown>;
};

export type CommandSubmitResponse = {
  task: TaskResource;
};

export type APIErrorResponse = {
  success: false;
  error_code: string;
  message: string;
  details?: Record<string, JSONValue>;
};

type CommandModelErrorCode = "INVALID_CATALOG" | "INVALID_PARAMETERS";

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

export function catalogFromObject(object: ObjectResponse): CommandCatalog {
  if (object.payload !== undefined) {
    const payload = requireRecord(object.payload, "$.payload");
    return parseCommandCatalog({
      ...payload,
      type: typeof payload.type === "string" && payload.type.trim() !== "" ? payload.type : object.type
    });
  }
  return parseCommandCatalog(object);
}

export function parseCommandCatalog(value: unknown): CommandCatalog {
  const catalog = requireRecord(value, "catalog");
  const type = requireString(catalog.type, "$.type");
  if (type !== "command_catalog") {
    throw new CommandModelError("INVALID_CATALOG", "$.type must be command_catalog", { path: "$.type" });
  }

  const rawCommands = catalog.commands;
  if (!Array.isArray(rawCommands) || rawCommands.length === 0) {
    throw new CommandModelError("INVALID_CATALOG", "$.commands must be a non-empty array", { path: "$.commands" });
  }

  const seen = new Set<string>();
  const commands = rawCommands.map((rawCommand, index) => {
    const commandPath = `$.commands[${index}]`;
    const command = requireRecord(rawCommand, commandPath);
    const id = requireSnakeCase(command.id, `${commandPath}.id`);
    if (seen.has(id)) {
      throw new CommandModelError("INVALID_CATALOG", `${commandPath}.id is duplicated`, { command_id: id });
    }
    seen.add(id);
    return {
      id,
      name: requireString(command.name, `${commandPath}.name`),
      description: requireString(command.description, `${commandPath}.description`),
      parameters_schema: parseParameterSchema(command.parameters_schema, `${commandPath}.parameters_schema`)
    };
  });

  return {
    type: "command_catalog",
    name: requireString(catalog.name, "$.name"),
    description: requireString(catalog.description, "$.description"),
    commands
  };
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
    throw new CommandModelError("UNSUPPORTED_COMMAND", `${entity.entity_id} does not advertise support for ${commandId}`, {
      entity_id: entity.entity_id,
      command_id: commandId
    });
  }
}

export function coerceParameters(command: CommandDefinition, rawParameters: unknown): Record<string, JSONValue> {
  const raw = rawParameters === undefined || rawParameters === null ? {} : requireRecord(rawParameters, "parameters", "INVALID_PARAMETERS");
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
  taskId: string;
  entityId: string;
  command: CommandDefinition;
  parameters: Record<string, JSONValue>;
}): TaskCreateRequest {
  return {
    task_id: options.taskId,
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

function parseParameterSchema(value: unknown, path: string): Record<string, CommandParameterSchema> {
  const parameters = requireRecord(value, path);
  const parsed: Record<string, CommandParameterSchema> = {};
  for (const [name, rawParameter] of Object.entries(parameters)) {
    if (!isSnakeCase(name)) {
      throw new CommandModelError("INVALID_CATALOG", `${path}.${name}: parameter name must be lowercase snake_case`, { path: `${path}.${name}` });
    }
    const parameterPath = `${path}.${name}`;
    const parameter = requireRecord(rawParameter, parameterPath);
    const type = requireParameterType(parameter.type, `${parameterPath}.type`);
    const parsedParameter: CommandParameterSchema = {
      type,
      description: requireString(parameter.description, `${parameterPath}.description`),
      required: requireBoolean(parameter.required, `${parameterPath}.required`)
    };
    if (parameter.minimum !== undefined) {
      if (type !== "number") {
        throw new CommandModelError("INVALID_CATALOG", `${parameterPath}.minimum is only valid for number parameters`, { path: `${parameterPath}.minimum` });
      }
      parsedParameter.minimum = requireFiniteNumber(parameter.minimum, `${parameterPath}.minimum`);
    }
    if (parameter.maximum !== undefined) {
      if (type !== "number") {
        throw new CommandModelError("INVALID_CATALOG", `${parameterPath}.maximum is only valid for number parameters`, { path: `${parameterPath}.maximum` });
      }
      parsedParameter.maximum = requireFiniteNumber(parameter.maximum, `${parameterPath}.maximum`);
    }
    if (parsedParameter.minimum !== undefined && parsedParameter.maximum !== undefined && parsedParameter.minimum > parsedParameter.maximum) {
      throw new CommandModelError("INVALID_CATALOG", `${parameterPath}.minimum must be <= maximum`, { path: parameterPath });
    }
    parsed[name] = parsedParameter;
  }
  return parsed;
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

  const numberValue = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  if (!Number.isFinite(numberValue)) {
    throw new CommandModelError("INVALID_PARAMETERS", `${name} must be a finite number`, { parameter: name });
  }
  if (schema.minimum !== undefined && numberValue < schema.minimum) {
    throw new CommandModelError("INVALID_PARAMETERS", `${name} must be >= ${schema.minimum}`, { parameter: name, minimum: schema.minimum });
  }
  if (schema.maximum !== undefined && numberValue > schema.maximum) {
    throw new CommandModelError("INVALID_PARAMETERS", `${name} must be <= ${schema.maximum}`, { parameter: name, maximum: schema.maximum });
  }
  return numberValue;
}

function requireRecord(value: unknown, path: string, code: CommandModelErrorCode = "INVALID_CATALOG"): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new CommandModelError(code, `${path} must be an object`, { path });
}

function requireString(value: unknown, path: string): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (trimmed !== "") {
    return trimmed;
  }
  throw new CommandModelError("INVALID_CATALOG", `${path} must be a non-empty string`, { path });
}

function requireSnakeCase(value: unknown, path: string): string {
  const stringValue = requireString(value, path);
  if (!isSnakeCase(stringValue)) {
    throw new CommandModelError("INVALID_CATALOG", `${path} must be lowercase snake_case`, { path });
  }
  return stringValue;
}

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  throw new CommandModelError("INVALID_CATALOG", `${path} must be a boolean`, { path });
}

function requireFiniteNumber(value: unknown, path: string): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  throw new CommandModelError("INVALID_CATALOG", `${path} must be a finite number`, { path });
}

function requireParameterType(value: unknown, path: string): ParameterType {
  if (value === "string" || value === "number" || value === "boolean") {
    return value;
  }
  throw new CommandModelError("INVALID_CATALOG", `${path} must be one of string, number, boolean`, { path });
}

function isSnakeCase(value: string): boolean {
  return /^[a-z][a-z0-9_]*$/.test(value);
}

function isEmptyOptionalInput(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}
