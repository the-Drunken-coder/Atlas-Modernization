import { sanitizeErrorMessage } from "@the-drunken-coder/atlas-sdk";
import {
  type AtlasTargetSummary,
  isCreatedResource,
  jsonNumber,
  type RunEvent,
  type RunSummary,
  type ScenarioDescriptor,
  type StartRunRequest
} from "../shared/types.js";

export type FieldValues = Record<string, string | number | boolean>;

const MAX_CLIENT_EVENTS = 500;

export function appendRunEvent(current: RunEvent[], event: RunEvent): RunEvent[] | undefined {
  if (current.some((existing) => existing.runId === event.runId && existing.sequence === event.sequence))
    return undefined;
  return [...current, event].slice(-MAX_CLIENT_EVENTS);
}

export function applyRunEvent(run: RunSummary, event: RunEvent): RunSummary {
  switch (event.type) {
    case "status":
      if (event.status === "running" && isTerminalStatus(run.status)) return run;
      return {
        ...run,
        status: event.status,
        updatedAt: event.timestamp,
        ...(event.status === "running" || run.finishedAt ? {} : { finishedAt: event.timestamp })
      };
    case "assertion":
      if (run.assertions.some((assertion) => assertion.id === event.assertion.id)) return run;
      return { ...run, assertions: [...run.assertions, event.assertion], updatedAt: event.timestamp };
    case "resource":
      if (
        run.createdResources.some(
          (resource) => resource.type === event.resource.type && resource.id === event.resource.id
        )
      )
        return run;
      return { ...run, createdResources: [...run.createdResources, event.resource], updatedAt: event.timestamp };
    case "error":
      return { ...run, lastError: event.message, updatedAt: event.timestamp };
    case "cleanup":
      if (!event.resource) return { ...run, cleaned: true, updatedAt: event.timestamp };
      return { ...run, updatedAt: event.timestamp };
    case "log":
      return { ...run, updatedAt: event.timestamp };
  }
}

export function isTerminalStatus(status: RunSummary["status"]): boolean {
  return status !== "running";
}

export function displayStatus(run: RunSummary | undefined): string {
  return run?.cleaned ? "cleaned" : (run?.status ?? "idle");
}

export function mergeRunLists(
  current: RunSummary[],
  incoming: RunSummary[],
  runIdsAtRequestStart: Set<string>
): RunSummary[] {
  const byId = new Map(current.map((run) => [run.id, run]));
  const incomingIds = new Set(incoming.map((run) => run.id));
  const retained = current.filter((run) => !incomingIds.has(run.id) && !runIdsAtRequestStart.has(run.id));
  return [...incoming.map((run) => mergeRunSummary(byId.get(run.id), run)), ...retained].sort(
    (left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt)
  );
}

export function mergeRunSummary(existing: RunSummary | undefined, incoming: RunSummary): RunSummary {
  if (!existing) return incoming;
  const existingIsNewer = runRecency(existing) >= runRecency(incoming);
  const fresher = existingIsNewer ? existing : incoming;
  return {
    id: incoming.id,
    scenarioId: incoming.scenarioId,
    scenarioName: incoming.scenarioName,
    ...((incoming.target ?? existing.target) ? { target: incoming.target ?? existing.target } : {}),
    status: fresher.status,
    startedAt: incoming.startedAt,
    ...(fresher.finishedAt ? { finishedAt: fresher.finishedAt } : {}),
    ...(fresher.updatedAt ? { updatedAt: fresher.updatedAt } : {}),
    inputs: incoming.inputs,
    ...(incoming.jsonInput === undefined ? {} : { jsonInput: incoming.jsonInput }),
    assertions: mergeAssertions(existing.assertions, incoming.assertions),
    createdResources: mergeResources(existing.createdResources, incoming.createdResources),
    cleaned: existing.cleaned || incoming.cleaned,
    ...(fresher.lastError ? { lastError: fresher.lastError } : {})
  };
}

export function buildStartRunRequest(
  scenario: ScenarioDescriptor,
  target: AtlasTargetSummary,
  values: FieldValues,
  jsonInput: string,
  deployedMutationConfirmed: boolean
): StartRunRequest {
  if (target.deployed && !deployedMutationConfirmed) {
    throw new Error("Confirm the deployed mutation before starting the run");
  }
  const normalizedJsonInput = scenario.acceptsJson && jsonInput.trim() !== "" ? jsonInput : undefined;
  if (normalizedJsonInput !== undefined) {
    try {
      JSON.parse(normalizedJsonInput);
    } catch {
      throw new Error("JSON input must be valid JSON");
    }
  }
  return {
    scenarioId: scenario.id,
    targetId: target.id,
    ...(target.deployed ? { confirmDeployedMutation: true as const } : {}),
    inputs: submissionInputs(scenario, values),
    ...(normalizedJsonInput ? { jsonInput: normalizedJsonInput } : {})
  };
}

function submissionInputs(scenario: ScenarioDescriptor, values: FieldValues): NonNullable<StartRunRequest["inputs"]> {
  return Object.fromEntries(
    scenario.inputFields.map((field): [string, string | boolean | ReturnType<typeof jsonNumber>] => {
      const value = values[field.key];
      if (field.type === "text") return [field.key, typeof value === "string" ? value : field.defaultValue];
      if (field.type === "boolean") return [field.key, typeof value === "boolean" ? value : field.defaultValue];
      if (typeof value === "number") return [field.key, jsonNumber(value)];
      if (typeof value !== "string") return [field.key, field.defaultValue];
      const trimmed = value.trim();
      if (trimmed === "") return [field.key, field.defaultValue];
      const parsed = Number(trimmed);
      if (!Number.isFinite(parsed)) throw new Error(`${field.label} must be a number`);
      if (field.min !== undefined && parsed < field.min)
        throw new Error(`${field.label} must be at least ${field.min}`);
      if (field.max !== undefined && parsed > field.max) throw new Error(`${field.label} must be at most ${field.max}`);
      if (field.step !== undefined && field.step > 0 && !alignsToStep(parsed, field.step, field.min ?? 0)) {
        throw new Error(`${field.label} must align to step ${field.step}`);
      }
      return [field.key, jsonNumber(parsed)];
    })
  );
}

export function parseRunEvent(value: unknown): RunEvent {
  if (
    !isRecord(value) ||
    typeof value.sequence !== "number" ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 1 ||
    typeof value.runId !== "string" ||
    typeof value.timestamp !== "string" ||
    Number.isNaN(Date.parse(value.timestamp)) ||
    typeof value.message !== "string"
  ) {
    throw new Error("Invalid run event");
  }
  switch (value.type) {
    case "status":
      if (
        value.status === "running" ||
        value.status === "completed" ||
        value.status === "failed" ||
        value.status === "cancelled" ||
        value.status === "abandoned"
      )
        return sanitizedRunEvent(value as RunEvent);
      break;
    case "log":
      if (value.level === undefined || isRunEventLevel(value.level)) return sanitizedRunEvent(value as RunEvent);
      break;
    case "assertion":
      if (
        isRecord(value.assertion) &&
        typeof value.assertion.id === "string" &&
        typeof value.assertion.name === "string" &&
        typeof value.assertion.passed === "boolean" &&
        typeof value.assertion.timestamp === "string" &&
        (value.assertion.message === undefined || typeof value.assertion.message === "string")
      )
        return sanitizedRunEvent(value as RunEvent);
      break;
    case "resource":
      if (isCreatedResource(value.resource)) return sanitizedRunEvent(value as RunEvent);
      break;
    case "error":
      if (value.level === "error") return sanitizedRunEvent(value as RunEvent);
      break;
    case "cleanup":
      if (value.resource === undefined || isCreatedResource(value.resource))
        return sanitizedRunEvent(value as RunEvent);
      break;
  }
  throw new Error("Invalid run event");
}

export function errorMessage(errorValue: unknown): string {
  return sanitizeErrorMessage(errorValue, { fallback: "Unknown error" });
}

function sanitizedRunEvent(event: RunEvent): RunEvent {
  if (event.type !== "assertion" || event.assertion.message === undefined) {
    return { ...event, message: sanitizeErrorMessage(event.message) };
  }
  return {
    ...event,
    message: sanitizeErrorMessage(event.message),
    assertion: { ...event.assertion, message: sanitizeErrorMessage(event.assertion.message) }
  };
}

function runRecency(run: RunSummary): number {
  return Date.parse(run.updatedAt ?? run.finishedAt ?? run.startedAt);
}

function mergeAssertions(
  existing: RunSummary["assertions"],
  incoming: RunSummary["assertions"]
): RunSummary["assertions"] {
  const byId = new Map(existing.map((assertion) => [assertion.id, assertion]));
  for (const assertion of incoming) byId.set(assertion.id, assertion);
  return [...byId.values()];
}

function mergeResources(
  existing: RunSummary["createdResources"],
  incoming: RunSummary["createdResources"]
): RunSummary["createdResources"] {
  const byId = new Map(existing.map((resource) => [`${resource.type}:${resource.id}`, resource]));
  for (const resource of incoming) byId.set(`${resource.type}:${resource.id}`, resource);
  return [...byId.values()];
}

function alignsToStep(value: number, step: number, base: number): boolean {
  const steps = (value - base) / step;
  return Math.abs(steps - Math.round(steps)) < 1e-9;
}

function isRunEventLevel(value: unknown): boolean {
  return value === "info" || value === "warn" || value === "error";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
