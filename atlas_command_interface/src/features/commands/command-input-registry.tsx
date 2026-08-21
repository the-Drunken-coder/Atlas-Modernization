import type { CommandDefinition, EntityResource, JSONValue } from "@the-drunken-coder/atlas-sdk";
import type { ComponentType } from "react";

export type CommandTargeting = "map_point" | "none";
export type CommandMapPoint = { lat: number; lng: number };

export type CommandInputContext = {
  asset: EntityResource;
  command: CommandDefinition;
  mapPoint?: CommandMapPoint;
};

export type CommandInputFormProps = CommandInputContext & {
  submitting: boolean;
  error?: string;
  onCancel: () => void;
  onSubmit: (input: JSONValue) => void;
};

type DirectCommandInput = {
  Form?: never;
  buildInput: (context: CommandInputContext) => JSONValue;
};

type FormCommandInput = {
  Form: ComponentType<CommandInputFormProps>;
  buildInput?: never;
};

export type CommandInputRegistration = { targeting: CommandTargeting } & (DirectCommandInput | FormCommandInput);
export type CommandInputRegistry = Readonly<Record<string, CommandInputRegistration>>;

// A real Command adds its purpose-built input in the same change that adds the
// Protocol definition. The initial Protocol catalog and this registry are empty.
export const COMMAND_INPUT_REGISTRY = {} satisfies CommandInputRegistry;
