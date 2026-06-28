import type {
  HealthResponse,
  RunListResponse,
  RunSummary,
  ScenarioDescriptor,
  ScenarioListResponse,
  StartRunRequest,
  StartRunResponse
} from "../shared/types.js";

export async function loadHealth(): Promise<HealthResponse> {
  const response = await fetch("/api/health", { headers: { Accept: "application/json" } });
  const body = await responseJSON(response);
  if (!isHealthResponse(body)) {
    throw new Error(`Expected health response (${response.status})`);
  }
  return { ...body, status: body.status ?? response.status };
}

export async function loadScenarios(): Promise<ScenarioDescriptor[]> {
  const response = await apiJSON<ScenarioListResponse>("/api/scenarios");
  return response.scenarios;
}

export async function loadRuns(): Promise<RunSummary[]> {
  const response = await apiJSON<RunListResponse>("/api/runs");
  return response.runs;
}

export async function startRun(request: StartRunRequest): Promise<RunSummary> {
  const response = await apiJSON<StartRunResponse>("/api/runs", {
    method: "POST",
    body: JSON.stringify(request)
  });
  return response.run;
}

export async function loadRun(id: string): Promise<RunSummary> {
  const response = await apiJSON<{ run: RunSummary }>(`/api/runs/${encodeURIComponent(id)}`);
  return response.run;
}

export async function stopRun(id: string): Promise<RunSummary> {
  const response = await apiJSON<{ run: RunSummary }>(`/api/runs/${encodeURIComponent(id)}/stop`, { method: "POST" });
  return response.run;
}

export async function cleanupRun(id: string): Promise<RunSummary> {
  const response = await apiJSON<{ run: RunSummary }>(`/api/runs/${encodeURIComponent(id)}/cleanup`, { method: "POST" });
  return response.run;
}

async function apiJSON<T>(url: string, init?: RequestInit): Promise<T> {
  const method = init?.method?.toUpperCase() ?? "GET";
  const fetchInit = init ?? {};
  const response = await fetch(url, {
    ...fetchInit,
    headers: {
      Accept: "application/json",
      ...(method === "GET" ? {} : { "X-Atlas-Simulations-Request": "1" }),
      ...(fetchInit.body ? { "Content-Type": "application/json" } : {}),
      ...fetchInit.headers
    }
  });
  const body = await responseJSON(response);
  if (!response.ok) {
    throw new Error(
      typeof body === "object" && body && "message" in body && typeof body.message === "string" && body.message
        ? body.message
        : `Request failed (${response.status})`
    );
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
    (!("status" in value) || value.status === undefined || typeof value.status === "number") &&
    (!("message" in value) || value.message === undefined || typeof value.message === "string")
  );
}
