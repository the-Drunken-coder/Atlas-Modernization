import type { JSONValue } from "@the-drunken-coder/atlas-sdk";

export function canonicalJSON(value: unknown): string {
  return JSON.stringify(sortJSON(value));
}

export function encodeCanonicalJSON(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJSON(value));
}

export function decodeJSON(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

function sortJSON(value: unknown): JSONValue {
  if (Array.isArray(value)) return value.map(sortJSON);
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (typeof value === "number" && !Number.isFinite(value)) throw new TypeError("Radio JSON numbers must be finite");
    return value;
  }
  if (typeof value !== "object") throw new TypeError("Radio messages must contain only JSON values");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Radio messages must contain only plain JSON objects");
  }

  const sorted: Record<string, JSONValue> = Object.create(null);
  for (const key of Object.keys(value).sort()) {
    const child = (value as Record<string, unknown>)[key];
    if (child !== undefined) sorted[key] = sortJSON(child);
  }
  return sorted;
}
