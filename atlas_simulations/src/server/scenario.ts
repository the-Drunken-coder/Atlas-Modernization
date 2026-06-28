import type {
  AssertionResult,
  CreatedResource,
  JSONValue,
  ScenarioDescriptor,
  ScenarioInputField
} from "../shared/types.js";
import type { AtlasClientFactory, AtlasClientLike, ClientMode } from "./atlas.js";

type NumberInputField = Extract<ScenarioInputField, { type: "number" }>;

const MAX_JSON_INPUT_DEPTH = 200;

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

export function parseStartRequest(scenario: Scenario, request: unknown): ParsedStart {
  if (!isRecord(request)) {
    throw new Error("Start request must be a JSON object");
  }
  if (typeof request.scenarioId !== "string") {
    throw new Error("scenarioId is required");
  }
  if (request.scenarioId !== scenario.id) {
    throw new Error(`scenarioId must be ${scenario.id}`);
  }
  if (request.jsonInput !== undefined && typeof request.jsonInput !== "string") {
    throw new Error("jsonInput must be a string");
  }
  const inputs = request.inputs === undefined ? {} : request.inputs;
  if (!isRecord(inputs)) {
    throw new Error("inputs must be a JSON object");
  }
  rejectUnknownInputFields(scenario.inputFields, inputs);
  if (!scenario.acceptsJson && request.jsonInput?.trim()) {
    throw new Error(`${scenario.name} does not accept JSON input`);
  }
  return {
    input: {
      fields: parseFields(scenario.inputFields, inputs),
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
    throwIfCancelled();
    const rawClient = args.clientFactory({ ...options, signal: args.signal });
    args.registerClient(rawClient);
    return trackClientCreates(rawClient, args.track, throwIfCancelled);
  };
  const client = newClient({ sync: false });
  const idForName = createIdFactory(args.runId);
  return {
    runId: args.runId,
    signal: args.signal,
    client,
    newClient,
    id: idForName,
    log: args.log,
    assert: args.assert,
    wait: (ms) => waitFor(ms, args.signal),
    track: args.track,
    createEntity: (entity) => client.entities.create(entity),
    createTask: (task) => client.tasks.create(task),
    createObject: (object) => client.objects.create(object)
  };
}

function trackClientCreates(client: AtlasClientLike, track: (resource: CreatedResource) => void, throwIfCancelled: () => void): AtlasClientLike {
  const guarded = async <T>(operation: () => Promise<T>): Promise<T> => {
    throwIfCancelled();
    const result = await operation();
    throwIfCancelled();
    return result;
  };
  const guardedSync = <T>(operation: () => T): T => {
    throwIfCancelled();
    const result = operation();
    throwIfCancelled();
    return result;
  };
  const checkIn = ((id: string, options?: Parameters<AtlasClientLike["entities"]["checkIn"]>[1]) =>
    guarded(() => client.entities.checkIn(id, options))) as AtlasClientLike["entities"]["checkIn"];
  return {
    entities: {
      get: (id) => guarded(() => client.entities.get(id)),
      create: async (entity) => {
        throwIfCancelled();
        const created = await client.entities.create(entity);
        track({ type: "entity", id: created.entity_id });
        throwIfCancelled();
        return created;
      },
      update: (id, patch) => guarded(() => client.entities.update(id, patch)),
      delete: (id) => guarded(() => client.entities.delete(id)),
      checkIn
    },
    tasks: {
      get: (id) => guarded(() => client.tasks.get(id)),
      create: async (task) => {
        throwIfCancelled();
        const created = await client.tasks.create(task);
        track({ type: "task", id: created.task_id });
        throwIfCancelled();
        return created;
      },
      delete: (id) => guarded(() => client.tasks.delete(id)),
      acknowledge: (id, options) => guarded(() => client.tasks.acknowledge(id, options)),
      complete: (id, options) => guarded(() => client.tasks.complete(id, options)),
      fail: (id, options) => guarded(() => client.tasks.fail(id, options)),
      setStatus: (id, status, options) => guarded(() => client.tasks.setStatus(id, status, options))
    },
    objects: {
      get: (id) => guarded(() => client.objects.get(id)),
      create: async (object) => {
        throwIfCancelled();
        const created = await client.objects.create(object);
        track({ type: "object", id: created.object_id });
        throwIfCancelled();
        return created;
      },
      delete: (id) => guarded(() => client.objects.delete(id))
    },
    queries: {
      full: () => guarded(() => client.queries.full())
    },
    sync: {
      start: () => guarded(() => client.sync.start()),
      stop: () => client.sync.stop(),
      status: () => guardedSync(() => client.sync.status())
    },
    watch: (filter, callback) => guardedSync(() => client.watch(filter, callback)),
    handshake: () => guarded(() => client.handshake())
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error("jsonInput must be valid JSON");
  }
  assertJSONValue(parsed);
  return { json: parsed };
}

function assertJSONValue(value: unknown, depth = 0): asserts value is JSONValue {
  if (depth > MAX_JSON_INPUT_DEPTH) {
    throw new Error(`JSON input must be nested at most ${MAX_JSON_INPUT_DEPTH} levels`);
  }
  if (value === null || typeof value === "boolean" || typeof value === "string") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("JSON input must contain only finite numbers");
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertJSONValue(item, depth + 1);
    return;
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) assertJSONValue(item, depth + 1);
    return;
  }
  throw new Error("JSON input must be JSON-serializable");
}

function rejectUnknownInputFields(fields: ScenarioInputField[], raw: Record<string, unknown>): void {
  const allowed = new Set(fields.map((field) => field.key));
  const unknown = Object.keys(raw).find((key) => !allowed.has(key));
  if (unknown) {
    throw new Error(`Unknown input field: ${unknown}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function waitFor(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error("Simulation cancelled"));
  if (!Number.isFinite(ms) || ms < 0 || ms > 2_147_483_647) {
    return Promise.reject(new Error("Wait duration must be between 0 and 2147483647 milliseconds"));
  }
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

function createIdFactory(runId: string): (name: string) => string {
  const issued = new Map<string, string>();
  const usedIds = new Set<string>();
  return (name) => {
    const existing = issued.get(name);
    if (existing) return existing;
    const base = slug(name);
    let id = `${runId}-${base}`;
    if (usedIds.has(id)) {
      const hashedId = `${runId}-${base}-${hashName(name)}`;
      id = hashedId;
      let counter = 2;
      while (usedIds.has(id)) {
        id = `${hashedId}-${counter}`;
        counter += 1;
      }
    }
    issued.set(name, id);
    usedIds.add(id);
    return id;
  };
}

function slug(value: string): string {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "resource";
}

function hashName(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36);
}
