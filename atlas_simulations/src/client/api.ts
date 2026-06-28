import type {
  HealthResponse,
  JSONValue,
  RunListResponse,
  RunSummary,
  ScenarioDescriptor,
  ScenarioListResponse,
  StartRunRequest,
  StartRunResponse
} from "../shared/types.js";
import { isCreatedResource, jsonNumber } from "../shared/types.js";

export async function loadHealth(): Promise<HealthResponse> {
  let response: Response;
  try {
    response = await fetch("/api/health", { headers: { Accept: "application/json" } });
  } catch (error) {
    return { ok: false, status: jsonNumber(0), message: transportErrorMessage(error) };
  }
  const body = await responseJSON(response).catch((error: unknown) => {
    if (!response.ok) return undefined;
    throw error;
  });
  if (!isHealthResponse(body)) {
    if (!response.ok) {
      return { ok: false, status: jsonNumber(response.status), message: `Request failed (${response.status})` };
    }
    throw new Error(`Expected health response (${response.status})`);
  }
  if (!response.ok) {
    return {
      ...body,
      ok: false,
      status: jsonNumber(body.status ?? response.status),
      message: body.message || `Request failed (${response.status})`
    };
  }
  return { ...body, status: jsonNumber(body.status ?? response.status) };
}

export async function loadScenarios(): Promise<ScenarioDescriptor[]> {
  const response = await apiJSON<ScenarioListResponse>("/api/scenarios", undefined, isScenarioListResponse, "scenario list response");
  return response.scenarios;
}

export async function loadRuns(): Promise<RunSummary[]> {
  const response = await apiJSON<RunListResponse>("/api/runs", undefined, isRunListResponse, "run list response");
  return response.runs;
}

export async function startRun(request: StartRunRequest): Promise<RunSummary> {
  if (!isStartRunRequest(request)) {
    throw new Error("Invalid start run request");
  }
  const response = await apiJSON<StartRunResponse>(
    "/api/runs",
    {
      method: "POST",
      body: JSON.stringify(request)
    },
    isStartRunResponse,
    "start run response"
  );
  return response.run;
}

export async function loadRun(id: string): Promise<RunSummary> {
  const response = await apiJSON<{ run: RunSummary }>(`/api/runs/${encodeURIComponent(id)}`, undefined, isRunResponse, "run response");
  return response.run;
}

export async function stopRun(id: string): Promise<RunSummary> {
  const response = await apiJSON<{ run: RunSummary }>(`/api/runs/${encodeURIComponent(id)}/stop`, { method: "POST" }, isRunResponse, "run response");
  return response.run;
}

export async function cleanupRun(id: string): Promise<RunSummary> {
  const response = await apiJSON<{ run: RunSummary }>(`/api/runs/${encodeURIComponent(id)}/cleanup`, { method: "POST" }, isRunResponse, "run response");
  return response.run;
}

async function apiJSON<T>(url: string, init: RequestInit | undefined, guard: (value: unknown) => value is T, label: string): Promise<T> {
  const method = init?.method?.toUpperCase() ?? "GET";
  const fetchInit = init ?? {};
  const headers = new Headers(fetchInit.headers);
  if (!headers.has("Accept")) headers.set("Accept", "application/json");
  if (method !== "GET" && !headers.has("X-Atlas-Simulations-Request")) headers.set("X-Atlas-Simulations-Request", "1");
  if (fetchInit.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(url, {
    ...fetchInit,
    headers
  });
  const body = await responseJSON(response).catch((error: unknown) => {
    if (!response.ok) return undefined;
    throw error;
  });
  if (!response.ok) {
    throw new Error(
      isRecord(body) && typeof body.message === "string" && body.message
        ? body.message
        : `Request failed (${response.status})`
    );
  }
  if (!guard(body)) {
    throw new Error(`Expected ${label} (${response.status})`);
  }
  return body as T;
}

async function responseJSON(response: Response): Promise<unknown> {
  const invalidJSON = Symbol("invalidJSON");
  const body = (await response.json().catch(() => invalidJSON)) as unknown | typeof invalidJSON;
  if (body === invalidJSON) {
    throw new Error(`Expected JSON response (${response.status})`);
  }
  return body;
}

function isHealthResponse(value: unknown): value is HealthResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "ok" in value &&
    typeof value.ok === "boolean" &&
    (!("status" in value) || value.status === undefined || isFiniteNumber(value.status)) &&
    (!("message" in value) || value.message === undefined || typeof value.message === "string")
  );
}

function isScenarioListResponse(value: unknown): value is ScenarioListResponse {
  return isRecord(value) && Array.isArray(value.scenarios) && value.scenarios.every(isScenarioDescriptor);
}

function isStartRunRequest(value: unknown): value is StartRunRequest {
  return (
    isRecord(value) &&
    typeof value.scenarioId === "string" &&
    (value.inputs === undefined || isInputRecord(value.inputs)) &&
    (value.jsonInput === undefined || typeof value.jsonInput === "string")
  );
}

function isScenarioDescriptor(value: unknown): value is ScenarioDescriptor {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.summary === "string" &&
    typeof value.acceptsJson === "boolean" &&
    Array.isArray(value.inputFields) &&
    value.inputFields.every(isScenarioInputField)
  );
}

function isScenarioInputField(value: unknown): boolean {
  if (!isRecord(value) || typeof value.key !== "string" || typeof value.label !== "string") return false;
  if (value.type === "number") {
    if (!isFiniteNumber(value.defaultValue)) return false;
    if (value.min !== undefined && !isFiniteNumber(value.min)) return false;
    if (value.max !== undefined && !isFiniteNumber(value.max)) return false;
    if (value.min !== undefined && value.max !== undefined && value.min > value.max) return false;
    if (value.defaultValue < (value.min ?? value.defaultValue)) return false;
    if (value.defaultValue > (value.max ?? value.defaultValue)) return false;
    return value.step === undefined || (isFiniteNumber(value.step) && value.step > 0);
  }
  if (value.type === "text") return typeof value.defaultValue === "string";
  if (value.type === "boolean") return typeof value.defaultValue === "boolean";
  return false;
}

function isRunListResponse(value: unknown): value is RunListResponse {
  return isRecord(value) && Array.isArray(value.runs) && value.runs.every(isRunSummary);
}

function isStartRunResponse(value: unknown): value is StartRunResponse {
  return isRunResponse(value);
}

function isRunResponse(value: unknown): value is { run: RunSummary } {
  return isRecord(value) && isRunSummary(value.run);
}

function isRunSummary(value: unknown): value is RunSummary {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.scenarioId === "string" &&
    typeof value.scenarioName === "string" &&
    isRunStatus(value.status) &&
    typeof value.startedAt === "string" &&
    (value.finishedAt === undefined || typeof value.finishedAt === "string") &&
    (value.updatedAt === undefined || typeof value.updatedAt === "string") &&
    isInputRecord(value.inputs) &&
    (value.jsonInput === undefined || isJSONValue(value.jsonInput)) &&
    Array.isArray(value.createdResources) &&
    value.createdResources.every(isCreatedResource) &&
    Array.isArray(value.assertions) &&
    value.assertions.every(isAssertionResult) &&
    typeof value.cleaned === "boolean" &&
    (value.lastError === undefined || typeof value.lastError === "string")
  );
}

function isRunStatus(value: unknown): boolean {
  return value === "running" || value === "completed" || value === "failed" || value === "cancelled";
}

function isInputRecord(value: unknown): boolean {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "string" || typeof item === "boolean" || isFiniteNumber(item));
}

function isAssertionResult(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.passed === "boolean" &&
    typeof value.timestamp === "string" &&
    (value.message === undefined || typeof value.message === "string")
  );
}

function isJSONValue(value: unknown): value is JSONValue {
  if (value === null || typeof value === "boolean" || typeof value === "string" || isFiniteNumber(value)) return true;
  if (Array.isArray(value)) return value.every(isJSONValue);
  return isRecord(value) && Object.values(value).every(isJSONValue);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function transportErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Unable to reach simulation server";
}
