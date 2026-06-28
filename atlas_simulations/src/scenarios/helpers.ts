import type { JSONValue } from "../shared/types.js";
import type { ScenarioInput } from "../server/scenario.js";

export function numberInput(input: ScenarioInput, key: string): number {
  const value = input.fields[key];
  if (typeof value !== "number") {
    throw new Error(`${key} must be a number`);
  }
  return value;
}

export function jsonObject(input: ScenarioInput): Record<string, JSONValue> {
  return isRecord(input.json) ? input.json : {};
}

export function isoNow(): string {
  return new Date().toISOString();
}

export function point(longitude: number, latitude: number): { type: "Point"; coordinates: [number, number] } {
  return { type: "Point", coordinates: [longitude, latitude] };
}

function isRecord(value: JSONValue | undefined): value is Record<string, JSONValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
