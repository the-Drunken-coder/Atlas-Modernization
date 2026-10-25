import type { CommandDefinition, EntityResource, JSONValue } from "@the-drunken-coder/atlas-sdk";
import type { ComponentType } from "react";
import { GotoForm, LandForm, ReturnToLaunchForm, TakeoffForm } from "./flight-inputs.js";

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
// Protocol definition. Flight inputs are dedicated forms, never generic
// schema-generated ones: choosing a map point alone never dispatches.
export const COMMAND_INPUT_REGISTRY = {
  "flight.takeoff": { targeting: "none", Form: TakeoffForm },
  "flight.goto": { targeting: "map_point", Form: GotoForm },
  "flight.return_to_launch": { targeting: "none", Form: ReturnToLaunchForm },
  "flight.land": { targeting: "none", Form: LandForm }
} satisfies CommandInputRegistry;
