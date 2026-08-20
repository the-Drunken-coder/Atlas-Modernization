import type {
  EntityCheckInFullResponse,
  EntityCheckInMinimalResponse,
  EntityCheckInOptions,
  EntityCheckInResponse,
  TaskCreateRequest,
  TaskResource
} from "@the-drunken-coder/atlas-sdk";
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
const MAX_JSON_INPUT_BYTES = 200_000;
const MAX_JSON_INPUT_NODES = 10_000;
const MAX_ID_SLUG_LENGTH = 64;

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
  createTask(task: TaskCreateRequest): Promise<TaskResource>;
  createObject: AtlasClientLike["objects"]["create"];
};

export type Scenario = ScenarioDescriptor & {
  run(ctx: ScenarioContext, input: ScenarioInput): Promise<void>;
};

export type ParsedStart = {
  input: ScenarioInput;
  targetId?: string;
  confirmDeployedMutation?: true;
};

export function descriptorForScenario(scenario: Readonly<Scenario>): ScenarioDescriptor {
  return {
    id: scenario.id,
    name: scenario.name,
    summary: scenario.summary,
    inputFields: scenario.inputFields,
    acceptsJson: scenario.acceptsJson
  };
}

export function parseStartRequest(scenario: Readonly<Scenario>, request: unknown): ParsedStart {
  if (!isRecord(request)) {
    throw new Error("Start request must be a JSON object");
  }
  rejectUnknownStartRequestFields(request);
  if (typeof request.scenarioId !== "string") {
    throw new Error("scenarioId is required");
  }
  if (request.scenarioId !== scenario.id) {
    throw new Error(`scenarioId must be ${scenario.id}`);
  }
  if (request.targetId !== undefined && (typeof request.targetId !== "string" || request.targetId.trim() === "")) {
    throw new Error("targetId must be a non-empty string");
  }
  if (request.confirmDeployedMutation !== undefined && request.confirmDeployedMutation !== true) {
    throw new Error("confirmDeployedMutation must be true when provided");
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
    ...(request.targetId === undefined ? {} : { targetId: request.targetId }),
    ...(request.confirmDeployedMutation === true ? { confirmDeployedMutation: true as const } : {}),
    input: {
      fields: parseFields(scenario.inputFields, inputs),
      ...(scenario.acceptsJson ? parseJsonInput(request.jsonInput) : {})
    }
  };
}

function rejectUnknownStartRequestFields(raw: Record<string, unknown>): void {
  const allowed = new Set(["scenarioId", "targetId", "confirmDeployedMutation", "inputs", "jsonInput"]);
  const unknown = Object.keys(raw).find((key) => !allowed.has(key));
  if (unknown !== undefined) {
    throw new Error(`Unknown start request field: ${unknown}`);
  }
}

export function createScenarioContext(args: {
  runId: string;
  signal: AbortSignal;
  clientFactory: AtlasClientFactory;
  log(message: string, data?: JSONValue): void;
  assert(name: string, passed: boolean, message?: string): AssertionResult;
  track(resource: CreatedResource): void;
  trackCleanupCandidate?(resource: CreatedResource): void;
  registerClient(client: AtlasClientLike): void;
}): ScenarioContext {
  const throwIfCancelled = () => {
    if (args.signal.aborted) {
      throw new Error("Simulation cancelled");
    }
  };
  const track = (resource: CreatedResource) => {
    if (resource.type !== "task") assertRunOwnedResourceId(args.runId, resource);
    args.track(resource);
  };
  const trackCleanupCandidate = (resource: CreatedResource) => {
    if (resource.type === "task") return;
    assertRunOwnedResourceId(args.runId, resource);
    args.trackCleanupCandidate?.(resource);
  };
  const assertRunOwned = (resource: CreatedResource) => {
    assertRunOwnedResourceId(args.runId, resource);
  };
  const newClient = (options?: { sync?: ClientMode; pollIntervalMs?: number }) => {
    throwIfCancelled();
    const rawClient = args.clientFactory({ ...options, signal: args.signal });
    args.registerClient(rawClient);
    return trackClientCreates(rawClient, track, trackCleanupCandidate, assertRunOwned, throwIfCancelled, args.signal);
  };
  const client = newClient({ sync: false });
  const idForName = createIdFactory(args.runId);
  let taskingAttempt = 0;
  return {
    runId: args.runId,
    signal: args.signal,
    client,
    newClient,
    id: idForName,
    log: args.log,
    assert: args.assert,
    wait: (ms) => waitFor(ms, args.signal),
    track,
    createEntity: (entity) => client.entities.create(entity),
    createTask: (task) => client.tasks.create(task, { idempotencyKey: `${args.runId}-tasking-${++taskingAttempt}` }),
    createObject: (object) => client.objects.create(object)
  };
}

function assertRunOwnedResourceId(runId: string, resource: CreatedResource): void {
  const prefix = `${runId}-`;
  if (!resource.id.startsWith(prefix)) {
    throw new Error(`${resource.type} ID must start with run ID prefix ${prefix}`);
  }
}

function trackClientCreates(
  client: AtlasClientLike,
  track: (resource: CreatedResource) => void,
  trackCleanupCandidate: (resource: CreatedResource) => void,
  assertRunOwned: (resource: CreatedResource) => void,
  throwIfCancelled: () => void,
  signal: AbortSignal
): AtlasClientLike {
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
  const createTracked = async <T>(resource: CreatedResource, operation: () => Promise<T>): Promise<T> => {
    throwIfCancelled();
    assertRunOwned(resource);
    trackCleanupCandidate(resource);
    const created = await operation();
    track(resource);
    throwIfCancelled();
    return created;
  };
  const guardedWatch: AtlasClientLike["watch"] = (filter, callback) => {
    throwIfCancelled();
    let active = true;
    let unsubscribe: () => void = () => undefined;
    const stop = () => {
      if (!active) return;
      active = false;
      signal.removeEventListener("abort", stop);
      unsubscribe();
    };
    const guardedCallback = ((value: Parameters<typeof callback>[0], event: Parameters<typeof callback>[1]) => {
      if (!active || signal.aborted) {
        stop();
        return;
      }
      callback(value, event);
    }) as typeof callback;
    unsubscribe = client.watch(filter, guardedCallback);
    signal.addEventListener("abort", stop, { once: true });
    try {
      throwIfCancelled();
    } catch (error) {
      stop();
      throw error;
    }
    return stop;
  };
  function checkIn(id: string, options: EntityCheckInOptions<"minimal">): Promise<EntityCheckInMinimalResponse>;
  function checkIn(id: string, options?: EntityCheckInOptions<"full">): Promise<EntityCheckInFullResponse>;
  function checkIn(id: string, options?: EntityCheckInOptions): Promise<EntityCheckInResponse>;
  function checkIn(id: string, options?: EntityCheckInOptions): Promise<EntityCheckInResponse> {
    if (options?.fields === "minimal") return guarded(() => client.entities.checkIn(id, options));
    return guarded(() => client.entities.checkIn(id, options));
  }
  return {
    entities: {
      get: (id) => guarded(() => client.entities.get(id)),
      create: async (entity) => {
        const resource = { type: "entity", id: entity.entity_id } satisfies CreatedResource;
        return createTracked(resource, () => client.entities.create(entity));
      },
      update: (id, patch) => guarded(() => client.entities.update(id, patch)),
      delete: (id) => guarded(() => client.entities.delete(id)),
      checkIn
    },
    tasks: {
      get: (id) => guarded(() => client.tasks.get(id)),
      create: async (task, options) => {
        throwIfCancelled();
        const created = await client.tasks.create(task, options);
        track({ type: "task", id: created.task_id });
        throwIfCancelled();
        return created;
      },
      acknowledge: (id, options) => guarded(() => client.tasks.acknowledge(id, options)),
      start: (id, options) => guarded(() => client.tasks.start(id, options)),
      progress: (id, request, options) => guarded(() => client.tasks.progress(id, request, options)),
      complete: (id, options) => guarded(() => client.tasks.complete(id, options)),
      fail: (id, options) => guarded(() => client.tasks.fail(id, options)),
      cancel: (id, options) => guarded(() => client.tasks.cancel(id, options))
    },
    runtime: {
      begin: (assetId, request, options) => guarded(() => client.runtime.begin(assetId, request, options)),
      stop: (assetId, request, options) => client.runtime.stop(assetId, request, options),
      ready: (assetId, request, options) => guarded(() => client.runtime.ready(assetId, request, options)),
      tasks: (assetId, options) => guarded(() => client.runtime.tasks(assetId, options))
    },
    objects: {
      get: (id) => guarded(() => client.objects.get(id)),
      create: async (object) => {
        const resource = { type: "object", id: object.object_id } satisfies CreatedResource;
        return createTracked(resource, () => client.objects.create(object));
      },
      delete: (id) => guarded(() => client.objects.delete(id))
    },
    queries: {
      full: () => guarded(() => client.queries.full())
    },
    sync: {
      start: () => guarded(() => client.sync.start()),
      // Stop must still run from scenario finally blocks after cancellation.
      stop: () => client.sync.stop(),
      status: () => guardedSync(() => client.sync.status())
    },
    watch: guardedWatch,
    subscribe: (filter) => guarded(() => client.subscribe(filter)),
    handshake: () => guarded(() => client.handshake())
  };
}

function parseFields(
  fields: readonly ScenarioInputField[],
  raw: Record<string, unknown>
): Record<string, string | number | boolean> {
  const values = Object.create(null) as Record<string, string | number | boolean>;
  for (const field of fields) {
    const value = Object.hasOwn(raw, field.key) ? raw[field.key] : field.defaultValue;
    if (value === undefined) {
      throw new Error(`${field.label} is required`);
    }
    switch (field.type) {
      case "number":
        values[field.key] = parseNumberField(field, value);
        break;
      case "text":
        if (typeof value !== "string") {
          throw new Error(`${field.label} must be a string`);
        }
        values[field.key] = value;
        break;
      case "boolean":
        values[field.key] = parseBoolean(field, value);
        break;
      default: {
        const exhaustive: never = field;
        throw new Error(`Unsupported input field type: ${String((exhaustive as ScenarioInputField).type)}`);
      }
    }
  }
  return values;
}

function parseNumberField(field: NumberInputField, value: unknown): number {
  let parsed: number;
  if (typeof value === "number") {
    parsed = value;
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") {
      throw new Error(`${field.label} is required`);
    }
    if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed)) {
      throw new Error(`${field.label} must be a number`);
    }
    parsed = Number(trimmed);
  } else {
    parsed = NaN;
  }
  if (!Number.isFinite(parsed)) {
    throw new Error(`${field.label} must be a number`);
  }
  if (field.min !== undefined && parsed < field.min) {
    throw new Error(`${field.label} must be at least ${field.min}`);
  }
  if (field.max !== undefined && parsed > field.max) {
    throw new Error(`${field.label} must be at most ${field.max}`);
  }
  if (field.step !== undefined && field.step > 0) {
    const aligned = alignToStep(parsed, field.step, field.min ?? 0);
    if (aligned === undefined) {
      throw new Error(`${field.label} must align to step ${field.step}`);
    }
    parsed = aligned;
  }
  return parsed;
}

function alignToStep(value: number, step: number, base: number): number | undefined {
  const steps = (value - base) / step;
  const rounded = Math.round(steps);
  if (Math.abs(steps - rounded) >= 1e-9) return undefined;
  return base + rounded * step;
}

function parseBoolean(field: ScenarioInputField, value: unknown): boolean {
  if (typeof value === "boolean") return value;
  throw new Error(`${field.label} must be a boolean`);
}

function parseJsonInput(raw: string | undefined): { json?: JSONValue } {
  if (raw === undefined) return {};
  if (Buffer.byteLength(raw, "utf8") > MAX_JSON_INPUT_BYTES) {
    throw new Error(`JSON input must be at most ${MAX_JSON_INPUT_BYTES} bytes`);
  }
  const trimmed = raw.trim();
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

function assertJSONValue(value: unknown, depth = 0, state = { nodes: 0 }): asserts value is JSONValue {
  state.nodes += 1;
  if (state.nodes > MAX_JSON_INPUT_NODES) {
    throw new Error(`JSON input must contain at most ${MAX_JSON_INPUT_NODES} values`);
  }
  if (depth > MAX_JSON_INPUT_DEPTH) {
    throw new Error(`JSON input must be nested at most ${MAX_JSON_INPUT_DEPTH} levels`);
  }
  if (value === null || typeof value === "boolean" || typeof value === "string") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("JSON input must contain only finite numbers");
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertJSONValue(item, depth + 1, state);
    return;
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) assertJSONValue(item, depth + 1, state);
    return;
  }
  throw new Error("JSON input must be JSON-serializable");
}

function rejectUnknownInputFields(fields: readonly ScenarioInputField[], raw: Record<string, unknown>): void {
  const allowed = new Set(fields.map((field) => field.key));
  const unknown = Object.keys(raw).find((key) => !allowed.has(key));
  if (unknown !== undefined) {
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
    const stableId = `${runId}-${base}-${hashName(name)}`;
    let id = stableId;
    let counter = 2;
    while (usedIds.has(id)) {
      id = `${stableId}-${counter}`;
      counter += 1;
    }
    issued.set(name, id);
    usedIds.add(id);
    return id;
  };
}

function slug(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned.slice(0, MAX_ID_SLUG_LENGTH).replace(/-+$/g, "") || "resource";
}

function hashName(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36);
}
