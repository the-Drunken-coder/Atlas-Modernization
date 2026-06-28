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

export type ScenarioInputType = ScenarioInputField["type"];

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

export type RunStatus = "running" | "completed" | "failed" | "cancelled";

type RunEventBase = {
  sequence: number;
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
  status: RunStatus;
  startedAt: string;
  finishedAt?: string;
  inputs: Record<string, string | number | boolean>;
  jsonInput?: JSONValue;
  createdResources: CreatedResource[];
  assertions: AssertionResult[];
  cleaned: boolean;
  lastError?: string;
};

export type StartRunRequest = {
  scenarioId: string;
  inputs?: Record<string, string | number | boolean>;
  jsonInput?: string;
};

export type StartRunResponse = {
  run: RunSummary;
};

export type HealthResponse = {
  ok: boolean;
  status?: number;
  message?: string;
};

export type ScenarioListResponse = {
  scenarios: ScenarioDescriptor[];
};

export type RunListResponse = {
  runs: RunSummary[];
};
