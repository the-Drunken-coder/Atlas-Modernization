import { sanitizeErrorMessage } from "@the-drunken-coder/atlas-sdk";
import type { AssertionResult, RunEvent } from "../shared/types.js";
import {
  EVENT_MESSAGE_TRUNCATION_SUFFIX,
  MAX_ASSERTION_FIELD_BYTES,
  MAX_EVENT_DATA_DEPTH,
  MAX_EVENT_DATA_NODES,
  MAX_EVENT_DATA_STRING_BYTES,
  MAX_EVENT_HISTORY_BYTES_PER_RUN,
  MAX_EVENTS_PER_RUN
} from "./run-store-limits.js";
import { type RunRecord, timestamp } from "./run-store-types.js";

export function trimEvents(run: RunRecord): void {
  const protectedSequence = latestTerminalStatusSequence(run.events);
  while (run.eventHistoryBytes > MAX_EVENT_HISTORY_BYTES_PER_RUN && run.events.length > 1) {
    if (!removeOldestTrimmableEvent(run, protectedSequence)) break;
  }
  while (run.events.length > MAX_EVENTS_PER_RUN) {
    if (!removeOldestTrimmableEvent(run, protectedSequence)) break;
  }
}

export function eventBytes(event: RunEvent): number {
  return Buffer.byteLength(JSON.stringify(event), "utf8");
}

export function assertionBytes(assertion: AssertionResult): number {
  return Buffer.byteLength(JSON.stringify(assertion), "utf8");
}

export function assertEventJSONValue(
  value: unknown,
  depth = 0,
  state = { nodes: 0, stringBytes: 0, ancestors: new WeakSet<object>() }
): void {
  state.nodes += 1;
  if (state.nodes > MAX_EVENT_DATA_NODES) {
    throw new Error(`Run event data must contain at most ${MAX_EVENT_DATA_NODES} values`);
  }
  if (depth > MAX_EVENT_DATA_DEPTH) {
    throw new Error(`Run event data must be nested at most ${MAX_EVENT_DATA_DEPTH} levels`);
  }
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    addEventDataStringBytes(value, state);
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Run event data must contain only finite numbers");
    return;
  }
  if (typeof value !== "object") {
    throw new Error("Run event data must contain only JSON values");
  }
  if (state.ancestors.has(value)) {
    throw new Error("Run event data must not contain cycles");
  }
  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (const item of value) assertEventJSONValue(item, depth + 1, state);
      return;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("Run event data must contain only JSON objects");
    }
    const record = value as Record<string, unknown>;
    for (const key in record) {
      if (!Object.hasOwn(record, key)) continue;
      const item = record[key];
      addEventDataStringBytes(key, state);
      assertEventJSONValue(item, depth + 1, state);
    }
  } finally {
    state.ancestors.delete(value);
  }
}

export function boundedEventMessage(message: string): string {
  return boundedText(sanitizeSimulationMessage(message), MAX_EVENT_DATA_STRING_BYTES);
}

export function boundedAssertionText(message: string): string {
  return boundedText(sanitizeSimulationMessage(message), MAX_ASSERTION_FIELD_BYTES);
}

export function hasFailedAssertions(run: RunRecord): boolean {
  return run.assertions.some((assertion) => !assertion.passed);
}

export function lateAssertion(name: string, passed: boolean, message?: string): AssertionResult {
  return {
    id: "assert-late",
    name,
    passed,
    ...(message ? { message } : {}),
    timestamp: timestamp()
  };
}

export function errorMessage(error: unknown): string {
  try {
    return boundedEventMessage(error instanceof Error ? error.message : String(error));
  } catch {
    return "Unknown error";
  }
}

function removeOldestTrimmableEvent(run: RunRecord, protectedSequence: number | undefined): boolean {
  const index = run.events.findIndex((event) => event.sequence !== protectedSequence);
  if (index === -1) return false;
  const [event] = run.events.splice(index, 1);
  if (event) run.eventHistoryBytes -= eventBytes(event);
  return true;
}

function latestTerminalStatusSequence(events: RunEvent[]): number | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "status" && event.status !== "running") return event.sequence;
  }
  return undefined;
}

function addEventDataStringBytes(value: string, state: { stringBytes: number }): void {
  state.stringBytes += Buffer.byteLength(value, "utf8");
  if (state.stringBytes > MAX_EVENT_DATA_STRING_BYTES) {
    throw new Error(`Run event data strings must total at most ${MAX_EVENT_DATA_STRING_BYTES} bytes`);
  }
}

function boundedText(message: string, maxBytes: number): string {
  const encoded = Buffer.from(message, "utf8");
  if (encoded.length <= maxBytes) return message;
  const budget = maxBytes - Buffer.byteLength(EVENT_MESSAGE_TRUNCATION_SUFFIX, "utf8");
  let end = budget;
  while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end--;
  return `${encoded.subarray(0, end).toString("utf8")}${EVENT_MESSAGE_TRUNCATION_SUFFIX}`;
}

function sanitizeSimulationMessage(message: string): string {
  return sanitizeErrorMessage(message, { fallback: "Unknown error", maxLength: MAX_EVENT_DATA_STRING_BYTES + 1 });
}
