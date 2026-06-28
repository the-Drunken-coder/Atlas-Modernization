export type JSONValue = null | boolean | string | number | JSONValue[] | { [key: string]: JSONValue };

export type ScenarioInputType = "number" | "text" | "boolean";

type ScenarioInputFieldBase = {
  key: string;
  label: string;
};

export type ScenarioInputField =
  | (ScenarioInputFieldBase & {
      type: "number";
      defaultValue: number;
      min?: number;
      max?: number;
      step?: number;
    })
  | (ScenarioInputFieldBase & {
      type: "text";
      defaultValue: string;
    })
  | (ScenarioInputFieldBase & {
      type: "boolean";
      defaultValue: boolean;
    });

export type ScenarioDescriptor = {
  id: string;
  name: string;
  summary: string;
  inputFields: ScenarioInputField[];
  acceptsJson: boolean;
};

export type CreatedResourceType = "entity" | "task" | "object";

export type CreatedResource = {
  type: CreatedResourceType;
  id: string;
};

export type AssertionResult = {
  id: string;
  name: string;
  passed: boolean;
  message?: string;
  timestamp: string;
};

export type RunStatus = "running" | "completed" | "failed" | "cancelled" | "cleaned";

export type RunEventType = "status" | "log" | "assertion" | "resource" | "error" | "cleanup";

export type RunEvent = {
  sequence: number;
  runId: string;
  timestamp: string;
  type: RunEventType;
  level?: "info" | "warn" | "error";
  message: string;
  status?: RunStatus;
  assertion?: AssertionResult;
  resource?: CreatedResource;
  data?: JSONValue;
};

export type RunSummary = {
  id: string;
  scenarioId: string;
  scenarioName: string;
  status: RunStatus;
  startedAt: string;
  finishedAt?: string;
  inputs: Record<string, string | number | boolean>;
  jsonInput?: JSONValue;
  createdResources: CreatedResource[];
  assertions: AssertionResult[];
  lastError?: string;
};

export type StartRunRequest = {
  scenarioId: string;
  inputs?: Record<string, unknown>;
  jsonInput?: string;
};

export type StartRunResponse = {
  run: RunSummary;
};

export type HealthResponse = {
  ok: boolean;
  atlasBaseUrl: string;
  status?: number;
  message?: string;
};

export type ScenarioListResponse = {
  scenarios: ScenarioDescriptor[];
};

export type RunListResponse = {
  runs: RunSummary[];
};
