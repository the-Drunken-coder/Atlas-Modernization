declare const jsonNumberBrand: unique symbol;
export type JSONNumber = number & { readonly [jsonNumberBrand]: "JSONNumber" };
export type JSONValue = null | boolean | string | JSONNumber | JSONValue[] | { [key: string]: JSONValue };

export function jsonNumber(value: number): JSONNumber {
  if (!Number.isFinite(value)) throw new Error("JSON numbers must be finite");
  return value as JSONNumber;
}

type ScenarioInputFieldBase = {
  key: string;
  label: string;
};

export type ScenarioInputField =
  | (ScenarioInputFieldBase & {
      type: "number";
      defaultValue: JSONNumber;
      min?: JSONNumber;
      max?: JSONNumber;
      step?: JSONNumber;
    })
  | (ScenarioInputFieldBase & {
      type: "text";
      defaultValue: string;
    })
  | (ScenarioInputFieldBase & {
      type: "boolean";
      defaultValue: boolean;
    });

export type ScenarioInputType = ScenarioInputField["type"];

export type ScenarioDescriptor = {
  id: string;
  name: string;
  summary: string;
  inputFields: readonly ScenarioInputField[];
  acceptsJson: boolean;
};

export const CREATED_RESOURCE_TYPES = ["entity", "task", "object"] as const;

export type CreatedResourceType = (typeof CREATED_RESOURCE_TYPES)[number];

export type CreatedResource = {
  type: CreatedResourceType;
  id: string;
};

const CREATED_RESOURCE_TYPE_SET = new Set<string>(CREATED_RESOURCE_TYPES);

export function isCreatedResource(value: unknown): value is CreatedResource {
  return isRecord(value) && typeof value.type === "string" && CREATED_RESOURCE_TYPE_SET.has(value.type) && typeof value.id === "string";
}

export type AssertionResult = {
  id: string;
  name: string;
  passed: boolean;
  message?: string;
  timestamp: string;
};

export type RunStatus = "running" | "completed" | "failed" | "cancelled";

type RunEventBase = {
  sequence: JSONNumber;
  runId: string;
  timestamp: string;
  level?: "info" | "warn" | "error";
  message: string;
  data?: JSONValue;
};

export type RunEvent =
  | (RunEventBase & { type: "status"; status: RunStatus })
  | (RunEventBase & { type: "log" })
  | (RunEventBase & { type: "assertion"; assertion: AssertionResult })
  | (RunEventBase & { type: "resource"; resource: CreatedResource })
  | (RunEventBase & { type: "error"; level: "error" })
  | (RunEventBase & { type: "cleanup"; resource?: CreatedResource });

export type RunEventType = RunEvent["type"];
type RunEventDetailsFor<Event extends RunEvent> = Event extends RunEvent ? Omit<Event, "sequence" | "runId" | "timestamp"> : never;
export type RunEventDetails = RunEventDetailsFor<RunEvent>;

export type RunSummary = {
  id: string;
  scenarioId: string;
  scenarioName: string;
  target?: AtlasTargetSummary;
  status: RunStatus;
  startedAt: string;
  finishedAt?: string;
  updatedAt?: string;
  inputs: Record<string, string | JSONNumber | boolean>;
  jsonInput?: JSONValue;
  createdResources: CreatedResource[];
  assertions: AssertionResult[];
  cleaned: boolean;
  lastError?: string;
};

export type StartRunRequest = {
  scenarioId: string;
  targetId?: string;
  inputs?: Record<string, string | JSONNumber | boolean>;
  jsonInput?: string;
};

export type StartRunResponse = {
  run: RunSummary;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type HealthResponse = {
  ok: boolean;
  status?: JSONNumber;
  message?: string;
  target?: AtlasTargetSummary;
};

export type AtlasTargetSummary = {
  id: string;
  label: string;
  baseUrl: string;
  apiKeyConfigured: boolean;
};

export type TargetListResponse = {
  targets: AtlasTargetSummary[];
  defaultTargetId: string;
};

export type ScenarioListResponse = {
  scenarios: ScenarioDescriptor[];
};

export type RunListResponse = {
  runs: RunSummary[];
};
