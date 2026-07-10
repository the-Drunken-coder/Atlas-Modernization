import type { EntityResource } from "@the-drunken-coder/atlas-sdk";
import {
  type CommandCatalog,
  type CommandDefinition,
  type CommandParameterSchema,
  supportedCommandIds
} from "./command-model.js";

// Parameters that a map-point command receives from the right-click coordinate.
// They are never asked for in a form because the map fills them in.
export const MAP_POINT_PARAMETERS = ["latitude", "longitude"] as const;

export type CommandTargeting = "map_point" | "none";

export type CommandAvailability = {
  command: CommandDefinition;
  targeting: CommandTargeting;
  disabled: boolean;
  /** Tooltip-ready explanation when {@link disabled} is true. */
  disabledReason?: string;
  /** Schema entries the operator must fill in before submit (excludes auto-filled map-point parameters). */
  formParameters: Array<[string, CommandParameterSchema]>;
  /** True when {@link formParameters} is non-empty, i.e. a compact form should be shown before submit. */
  requiresForm: boolean;
};

/**
 * A command is position-based when its schema declares required numeric
 * `latitude` and `longitude` parameters. Everything else is a sidebar command.
 */
export function commandTargeting(command: CommandDefinition): CommandTargeting {
  return isRequiredNumber(command.parameters_schema.latitude) && isRequiredNumber(command.parameters_schema.longitude)
    ? "map_point"
    : "none";
}

/** Parameters the operator still has to provide for the given targeting. */
export function formParameters(command: CommandDefinition, targeting: CommandTargeting): Array<[string, CommandParameterSchema]> {
  const autoFilled = targeting === "map_point" ? new Set<string>(MAP_POINT_PARAMETERS) : new Set<string>();
  return Object.entries(command.parameters_schema).filter(([name]) => !autoFilled.has(name));
}

/**
 * Returns a tooltip-ready reason the entity cannot run the command, or
 * undefined when it is allowed. Only assets ever support commands.
 */
export function disabledReasonForEntity(entity: EntityResource, command: CommandDefinition): string | undefined {
  if (entity.entity_type !== "asset") {
    return "Only assets can receive commands";
  }
  const supported = supportedCommandIds(entity);
  if (supported === undefined) {
    return "This asset has no declared command support";
  }
  if (!supported.includes(command.id)) {
    return "This asset does not support this command";
  }
  return undefined;
}

/** Evaluate one command against the selected entity. */
export function evaluateCommand(entity: EntityResource, command: CommandDefinition): CommandAvailability {
  const targeting = commandTargeting(command);
  const disabledReason = disabledReasonForEntity(entity, command);
  const params = formParameters(command, targeting);
  return {
    command,
    targeting,
    disabled: disabledReason !== undefined,
    disabledReason,
    formParameters: params,
    requiresForm: params.length > 0
  };
}

/**
 * Commands for one targeting bucket (`map_point` for the map context menu,
 * `none` for the sidebar). Valid commands come first, disabled commands sink to
 * the bottom; catalog order is preserved within each group.
 */
export function commandsForTargeting(catalog: CommandCatalog, entity: EntityResource, targeting: CommandTargeting): CommandAvailability[] {
  const matches = catalog.commands.filter((command) => commandTargeting(command) === targeting).map((command) => evaluateCommand(entity, command));
  return [...matches.filter((entry) => !entry.disabled), ...matches.filter((entry) => entry.disabled)];
}

function isRequiredNumber(schema: CommandParameterSchema | undefined): boolean {
  return schema?.type === "number" && schema.required === true;
}
