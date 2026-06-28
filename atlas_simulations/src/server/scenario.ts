import type {
  AssertionResult,
  CreatedResource,
  JSONValue,
  ScenarioDescriptor,
  ScenarioInputField,
  StartRunRequest
} from "../shared/types.js";
import type { AtlasClientFactory, AtlasClientLike, ClientMode } from "./atlas.js";

type NumberInputField = Extract<ScenarioInputField, { type: "number" }>;

export type ScenarioInput = {
  fields: Record<string, string | number | boolean>;
  json?: JSONValue;
};

export type ScenarioContext = {
  runId: string;
  signal: AbortSignal;
  client: AtlasClientLike;
  newClient(options?: { sync?: ClientMode; pollIntervalMs?: number }): AtlasClientLike;
  id(name: string): string;
  log(message: string, data?: JSONValue): void;
  assert(name: string, passed: boolean, message?: string): AssertionResult;
  wait(ms: number): Promise<void>;
  track(resource: CreatedResource): void;
  createEntity: AtlasClientLike["entities"]["create"];
  createTask: AtlasClientLike["tasks"]["create"];
  createObject: AtlasClientLike["objects"]["create"];
};

export type Scenario = ScenarioDescriptor & {
  run(ctx: ScenarioContext, input: ScenarioInput): Promise<void>;
};

export type ParsedStart = {
  input: ScenarioInput;
};

export function descriptorForScenario(scenario: Scenario): ScenarioDescriptor {
  return {
    id: scenario.id,
    name: scenario.name,
    summary: scenario.summary,
    inputFields: scenario.inputFields,
    acceptsJson: scenario.acceptsJson
  };
}

export function parseStartRequest(scenario: Scenario, request: StartRunRequest): ParsedStart {
  return {
    input: {
      fields: parseFields(scenario.inputFields, request.inputs ?? {}),
      ...(scenario.acceptsJson ? parseJsonInput(request.jsonInput) : {})
    }
  };
}

export function createScenarioContext(args: {
  runId: string;
  signal: AbortSignal;
  clientFactory: AtlasClientFactory;
  log(message: string, data?: JSONValue): void;
  assert(name: string, passed: boolean, message?: string): AssertionResult;
  track(resource: CreatedResource): void;
  registerClient(client: AtlasClientLike): void;
}): ScenarioContext {
  const throwIfCancelled = () => {
    if (args.signal.aborted) {
      throw new Error("Simulation cancelled");
    }
  };
  const newClient = (options?: { sync?: ClientMode; pollIntervalMs?: number }) => {
    const client = args.clientFactory(options);
    args.registerClient(client);
    return client;
  };
  const client = newClient({ sync: false });
  return {
    runId: args.runId,
    signal: args.signal,
    client,
    newClient,
    id: (name) => `${args.runId}-${slug(name)}`,
    log: args.log,
    assert: args.assert,
    wait: (ms) => waitFor(ms, args.signal),
    track: args.track,
    createEntity: async (entity) => {
      throwIfCancelled();
      const created = await client.entities.create(entity);
      args.track({ type: "entity", id: created.entity_id });
      return created;
    },
    createTask: async (task) => {
      throwIfCancelled();
      const created = await client.tasks.create(task);
      args.track({ type: "task", id: created.task_id });
      return created;
    },
    createObject: async (object) => {
      throwIfCancelled();
      const created = await client.objects.create(object);
      args.track({ type: "object", id: created.object_id });
      return created;
    }
  };
}

function parseFields(fields: ScenarioInputField[], raw: Record<string, unknown>): Record<string, string | number | boolean> {
  const values: Record<string, string | number | boolean> = {};
  for (const field of fields) {
    const value = Object.prototype.hasOwnProperty.call(raw, field.key) ? raw[field.key] : field.defaultValue;
    if (value === undefined) {
      throw new Error(`${field.label} is required`);
    }
    if (field.type === "number") values[field.key] = parseNumberField(field, value);
    if (field.type === "text") {
      if (typeof value !== "string") {
        throw new Error(`${field.label} must be a string`);
      }
      values[field.key] = value;
    }
    if (field.type === "boolean") values[field.key] = parseBoolean(field, value);
  }
  return values;
}

function parseNumberField(field: NumberInputField, value: unknown): number {
  if (typeof value === "string" && value.trim() === "") {
    throw new Error(`${field.label} is required`);
  }
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(parsed)) {
    throw new Error(`${field.label} must be a number`);
  }
  if (field.min !== undefined && parsed < field.min) {
    throw new Error(`${field.label} must be at least ${field.min}`);
  }
  if (field.max !== undefined && parsed > field.max) {
    throw new Error(`${field.label} must be at most ${field.max}`);
  }
  if (field.step !== undefined && field.step > 0 && !alignsToStep(parsed, field.step, field.min ?? 0)) {
    throw new Error(`${field.label} must align to step ${field.step}`);
  }
  return parsed;
}

function alignsToStep(value: number, step: number, base: number): boolean {
  const steps = (value - base) / step;
  return Math.abs(steps - Math.round(steps)) < 1e-9;
}

function parseBoolean(field: ScenarioInputField, value: unknown): boolean {
  if (typeof value === "boolean") return value;
  throw new Error(`${field.label} must be a boolean`);
}

function parseJsonInput(raw: string | undefined): { json?: JSONValue } {
  const trimmed = raw?.trim();
  if (!trimmed) return {};
  return { json: JSON.parse(trimmed) as JSONValue };
}

function waitFor(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error("Simulation cancelled"));
  return new Promise((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout>;
    const abort = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      reject(new Error("Simulation cancelled"));
    };
    timeout = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

function slug(value: string): string {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "resource";
}
