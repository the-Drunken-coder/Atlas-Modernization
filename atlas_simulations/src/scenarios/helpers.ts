import type { JSONValue } from "../shared/types.js";
import type { ScenarioInput } from "../server/scenario.js";

export function numberInput(input: ScenarioInput, key: string): number {
  const value = input.fields[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${key} must be a finite number`);
  }
  return value;
}

export function boundedNumberInput(input: ScenarioInput, key: string, min: number, max: number): number {
  const value = numberInput(input, key);
  if (value < min || value > max) {
    throw new Error(`${key} must be between ${min} and ${max}`);
  }
  return value;
}

export function positiveIntegerInput(input: ScenarioInput, key: string): number {
  const value = numberInput(input, key);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${key} must be a positive integer`);
  }
  return value;
}

export function boundedPositiveIntegerInput(input: ScenarioInput, key: string, max: number): number {
  const value = positiveIntegerInput(input, key);
  if (value > max) {
    throw new Error(`${key} must be <= ${max}`);
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

export async function withDeadline<T>(operation: () => Promise<T>, deadline: number): Promise<T | undefined> {
  if (!Number.isFinite(deadline)) return await operation();
  const remaining = deadline - Date.now();
  if (remaining <= 0) return undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<undefined>((resolve) => {
        timeout = setTimeout(() => resolve(undefined), remaining);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function requireBeforeDeadline<T>(operation: () => Promise<T>, deadline: number, label: string): Promise<T> {
  const result = await withDeadline(operation, deadline);
  if (result === undefined) throw new Error(`${label} read timed out`);
  return result;
}

function isRecord(value: JSONValue | undefined): value is Record<string, JSONValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
