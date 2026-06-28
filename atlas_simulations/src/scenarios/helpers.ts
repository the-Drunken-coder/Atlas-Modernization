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
  if (input.json === undefined) return {};
  if (!isRecord(input.json)) {
    throw new Error("JSON input must be an object");
  }
  return input.json;
}

export function isoNow(): string {
  return new Date().toISOString();
}

export function point(longitude: number, latitude: number): { type: "Point"; coordinates: [number, number] } {
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new Error("longitude must be between -180 and 180");
  }
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    throw new Error("latitude must be between -90 and 90");
  }
  return { type: "Point", coordinates: [longitude, latitude] };
}

function isRecord(value: JSONValue | undefined): value is Record<string, JSONValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
