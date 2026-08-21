import { randomUUID } from "node:crypto";
import {
  AtlasAPIError,
  type AtlasSubscription,
  type AtlasWatchEvent,
  type CommandManifest,
  type EntityCheckInOptions,
  type EntityCreateRequest,
  type EntityResource,
  type JSONValue,
  type ObjectCreateRequest,
  type ObjectDetailResource,
  type ObjectResource,
  type ResourceType,
  type TaskCancellation,
  type TaskCreateRequest,
  type TaskFailure,
  type TaskResource
} from "@the-drunken-coder/atlas-sdk";
import type { AtlasClientFactory, AtlasClientLike, ClientMode } from "../../src/server/atlas.js";

type Stored<T> = { value: T; version: number };
type ResourceHistory<T> = Map<string, Stored<T>[]>;
type WatchableResource = EntityResource | TaskResource | ObjectResource;

type FakeCoreState = {
  version: number;
  entities: ResourceHistory<EntityResource>;
  tasks: ResourceHistory<TaskResource>;
  objects: ResourceHistory<ObjectDetailResource>;
  tombstones: Map<string, number[]>;
  deleted: string[];
  clients: FakeClientState[];
  taskingAttempts: Map<string, { request: string; task: TaskResource }>;
  runtimes: Map<string, { runtimeId: string; ready: boolean; manifest: CommandManifest }>;
};

type Watcher = {
  filter: AtlasSubscription;
  callback: (value: WatchableResource | undefined, event: AtlasWatchEvent) => void;
};

type FakeClientState = {
  sync: ClientMode;
  running: boolean;
  visibleVersion: number;
  watchers: Watcher[];
};

export function createFakeAtlasCore() {
  const state: FakeCoreState = {
    version: 0,
    entities: new Map(),
    tasks: new Map(),
    objects: new Map(),
    tombstones: new Map(),
    deleted: [],
    clients: [],
    taskingAttempts: new Map(),
    runtimes: new Map()
  };
  const factory: AtlasClientFactory = (options = {}) => createClient(state, options.sync ?? false);
  return { state, factory };
}

function createClient(state: FakeCoreState, sync: ClientMode): AtlasClientLike {
  const clientState: FakeClientState = { sync, running: false, visibleVersion: 0, watchers: [] };
  state.clients.push(clientState);
  return {
    entities: {
      get: async (id) => visibleValue(state, clientState, state.entities, id, "entity"),
      create: async (request) => {
        assertCanCreateEntity(state, request.entity_id, request.alias);
        const version = commitVersion(state, clientState);
        return saveValue(state.entities, request.entity_id, entityFromCreate(request, version), version);
      },
      update: async (id, patch) => {
        const current = requireActiveValue(state, state.entities, id, "entity").value;
        if ("alias" in patch) assertCanUseEntityAlias(state, patch.alias ?? null, id);
        const version = commitVersion(state, clientState);
        const updated: EntityResource = {
          ...current,
          ...("entity_type" in patch && patch.entity_type !== undefined ? { entity_type: patch.entity_type } : {}),
          ...("subtype" in patch ? { subtype: patch.subtype ?? null } : {}),
          ...("alias" in patch ? { alias: normalizeAlias(patch.alias) } : {}),
          ...(patch.components ? { components: { ...current.components, ...patch.components } } : {}),
          ...("extra" in patch ? { extra: patch.extra } : {}),
          metadata: metadata(version, current.metadata.created_at)
        };
        return saveValue(state.entities, id, updated, version);
      },
      delete: async (id) => deleteValue(state, clientState, state.entities, id, "entity"),
      checkIn: (async (id: string, options?: EntityCheckInOptions) => {
        const current = requireActiveValue(state, state.entities, id, "entity").value;
        const version = commitVersion(state, clientState);
        const updated: EntityResource = {
          ...current,
          components: {
            ...current.components,
            ...options?.components,
            ...(options?.status ? { status: { value: options.status, last_update: timestamp() } } : {}),
            ...(options?.telemetry
              ? { telemetry: { ...current.components.telemetry, ...options.telemetry, last_update: timestamp() } }
              : {})
          },
          metadata: metadata(version, current.metadata.created_at)
        };
        return { entity: saveValue(state.entities, id, updated, version) };
      }) as AtlasClientLike["entities"]["checkIn"]
    },
    tasks: {
      get: async (id) => visibleValue(state, clientState, state.tasks, id, "task"),
      create: async (request, options) => {
        const encoded = JSON.stringify(request);
        const previous = state.taskingAttempts.get(options.idempotencyKey);
        if (previous) {
          if (previous.request !== encoded) throw conflict("tasking attempt", options.idempotencyKey);
          return cloneValue(previous.task);
        }
        const version = commitVersion(state, clientState);
        const created = taskFromCreate(request);
        saveValue(state.tasks, created.task_id, created, version);
        state.taskingAttempts.set(options.idempotencyKey, { request: encoded, task: created });
        return cloneValue(created);
      },
      acknowledge: async (id) =>
        updateTask(state, clientState, id, { status: "acknowledged", acknowledged_at: timestamp() }),
      start: async (id) => {
        const startedAt = timestamp();
        const current = requireActiveValue(state, state.tasks, id, "task").value;
        return updateTask(state, clientState, id, {
          status: "in_progress",
          acknowledged_at: current.acknowledged_at ?? startedAt,
          started_at: startedAt
        });
      },
      progress: async (id, request) => updateTask(state, clientState, id, { progress: request.progress }),
      complete: async (id, options) =>
        updateTask(state, clientState, id, {
          status: "completed",
          finished_at: timestamp(),
          ...(options.output === undefined ? {} : { output: options.output })
        }),
      fail: async (id, options) =>
        updateTask(state, clientState, id, { status: "failed", failure: options.failure, finished_at: timestamp() }),
      cancel: async (id, options) =>
        updateTask(state, clientState, id, {
          status: "cancelled",
          cancellation: options.cancellation,
          finished_at: timestamp()
        })
    },
    runtime: {
      begin: async (assetId, request) => {
        state.runtimes.set(assetId, { runtimeId: request.runtime_id, ready: false, manifest: [] });
      },
      stop: async (assetId, request) => {
        const runtime = state.runtimes.get(assetId);
        if (!runtime || runtime.runtimeId !== request.runtime_id) return;
        runtime.ready = false;
        runtime.manifest = [];
        const currentEntity = state.entities.get(assetId)?.at(-1)?.value;
        if (currentEntity?.command_manifest !== undefined) {
          const { command_manifest: _manifest, ...withoutManifest } = currentEntity;
          const version = commitVersion(state, clientState);
          saveValue(
            state.entities,
            assetId,
            { ...withoutManifest, metadata: metadata(version, currentEntity.metadata.created_at) },
            version
          );
        }
        for (const task of currentValues(state, state.tasks, "task")) {
          if (
            task.asset_id !== assetId ||
            task.status === "completed" ||
            task.status === "failed" ||
            task.status === "cancelled"
          ) {
            continue;
          }
          updateTask(state, clientState, task.task_id, {
            status: "failed",
            failure: { code: "asset_stopped", message: "The Asset runtime stopped before the Task became terminal." },
            finished_at: timestamp()
          });
        }
      },
      ready: async (assetId, request) => {
        const runtime = state.runtimes.get(assetId);
        if (!runtime || runtime.runtimeId !== request.runtime_id) throw conflict("runtime", request.runtime_id);
        runtime.ready = true;
        runtime.manifest = cloneValue(request.manifest);
        const current = state.entities.get(assetId)?.at(-1);
        if (current) {
          const version = commitVersion(state, clientState);
          const entity = {
            ...current.value,
            command_manifest: cloneValue(request.manifest),
            metadata: metadata(version, current.value.metadata.created_at)
          };
          saveValue(state.entities, assetId, entity, version);
        }
      },
      tasks: async (assetId, options) => {
        const runtime = state.runtimes.get(assetId);
        if (!runtime?.ready || runtime.runtimeId !== options.runtimeId) throw conflict("runtime", options.runtimeId);
        const tasks = currentValues(state, state.tasks, "task").filter(
          (task) => task.asset_id === assetId && task.status === "pending"
        );
        return { tasks };
      }
    },
    objects: {
      get: async (id) => visibleValue(state, clientState, state.objects, id, "object"),
      create: async (request) => {
        assertCanCreate(state, state.objects, request.object_id, "object");
        const version = commitVersion(state, clientState);
        return saveValue(state.objects, request.object_id, objectFromCreate(request, version), version);
      },
      delete: async (id) => deleteValue(state, clientState, state.objects, id, "object")
    },
    queries: {
      full: async () => ({
        version: visibleVersion(state, clientState),
        entities: visibleValues(state, clientState, state.entities, "entity"),
        tasks: visibleValues(state, clientState, state.tasks, "task"),
        objects: visibleValues(state, clientState, state.objects, "object"),
        has_more_entities: false,
        has_more_tasks: false,
        has_more_objects: false
      })
    },
    sync: {
      start: async () => {
        clientState.running = true;
        clientState.visibleVersion = state.version;
      },
      stop: () => {
        clientState.running = false;
      },
      status: () => {
        if (clientState.running) {
          const previousVersion = clientState.visibleVersion;
          clientState.visibleVersion = state.version;
          emitVisibleChanges(state, clientState, previousVersion, clientState.visibleVersion);
        }
        return {
          running: clientState.running,
          healthy: clientState.running,
          degraded: false,
          lastVersion: visibleVersion(state, clientState),
          subscriptions: clientState.sync === "all" ? [{ filter: "all" as const }] : []
        };
      }
    },
    watch: (filter, callback) => {
      const watcher: Watcher = { filter, callback: callback as Watcher["callback"] };
      clientState.watchers.push(watcher);
      return () => {
        const index = clientState.watchers.indexOf(watcher);
        if (index !== -1) clientState.watchers.splice(index, 1);
      };
    },
    subscribe: async () => undefined,
    handshake: async () => undefined
  };
}

function entityFromCreate(request: EntityCreateRequest, version: number): EntityResource {
  return {
    entity_id: request.entity_id,
    entity_type: request.entity_type,
    alias: normalizeAlias(request.alias),
    subtype: request.subtype ?? null,
    components: request.components ?? {},
    ...("extra" in request ? { extra: request.extra } : {}),
    metadata: metadata(version)
  };
}

function taskFromCreate(request: TaskCreateRequest): TaskResource {
  const now = timestamp();
  return {
    task_id: `task-${randomUUID()}`,
    asset_id: request.asset_id,
    command: request.command,
    input: cloneValue(request.input),
    status: "pending",
    created_at: now,
    updated_at: now
  };
}

function objectFromCreate(request: ObjectCreateRequest, version: number): ObjectDetailResource {
  return {
    object_id: request.object_id,
    type: request.type ?? null,
    path: null,
    bucket: null,
    content_type: null,
    size_bytes: null,
    usage_hints: request.usage_hints ?? [],
    referenced_by: request.referenced_by ?? [],
    metadata: metadata(version),
    extra: { ...(request.extra ?? {}) }
  };
}

type TaskPatch =
  | { status: "acknowledged"; acknowledged_at: string }
  | { status: "in_progress"; acknowledged_at: string; started_at: string }
  | { progress: number }
  | { status: "completed"; finished_at: string; output?: JSONValue }
  | { status: "failed"; failure: TaskFailure; finished_at: string }
  | { status: "cancelled"; cancellation: TaskCancellation; finished_at: string };

function updateTask(state: FakeCoreState, clientState: FakeClientState, id: string, patch: TaskPatch): TaskResource {
  const current = requireActiveValue(state, state.tasks, id, "task").value;
  const version = commitVersion(state, clientState);
  const updatedAt = timestamp();
  if ("progress" in patch) {
    if (current.status !== "in_progress") throw new Error(`fake Core cannot progress ${current.status} Task ${id}`);
    return saveValue(state.tasks, id, { ...current, progress: patch.progress, updated_at: updatedAt }, version);
  }
  switch (patch.status) {
    case "acknowledged":
      return saveValue(state.tasks, id, { ...current, ...patch, updated_at: updatedAt }, version);
    case "in_progress":
      return saveValue(state.tasks, id, { ...current, ...patch, updated_at: updatedAt }, version);
    case "completed":
      return saveValue(
        state.tasks,
        id,
        {
          ...current,
          ...patch,
          acknowledged_at: current.acknowledged_at ?? updatedAt,
          started_at: current.started_at ?? updatedAt,
          updated_at: updatedAt
        },
        version
      );
    case "failed":
      return saveValue(state.tasks, id, { ...current, ...patch, updated_at: updatedAt }, version);
    case "cancelled":
      return saveValue(state.tasks, id, { ...current, ...patch, updated_at: updatedAt }, version);
  }
}

function metadata(version: number, createdAt?: string) {
  const now = timestamp();
  return { created_at: createdAt ?? now, updated_at: now, version };
}

function timestamp(): string {
  return new Date().toISOString();
}

function requireHistory<T>(values: ResourceHistory<T>, id: string, type: string): Stored<T>[] {
  const history = values.get(id);
  if (!history?.length) throw notFound(type, id);
  return history;
}

function requireActiveValue<T>(state: FakeCoreState, values: ResourceHistory<T>, id: string, type: string): Stored<T> {
  const stored = requireHistory(values, id, type).at(-1)!;
  if (isDeletedAt(state, type, id, state.version, stored.version)) throw notFound(type, id);
  return stored;
}

function assertCanCreate<T>(state: FakeCoreState, values: ResourceHistory<T>, id: string, type: string): void {
  const current = values.get(id)?.at(-1);
  if (current && !isDeletedAt(state, type, id, state.version, current.version)) throw conflict(type, id);
}

function assertCanCreateEntity(state: FakeCoreState, id: string, alias: string | null | undefined): void {
  assertCanCreate(state, state.entities, id, "entity");
  assertCanUseEntityAlias(state, alias ?? null, id);
}

function assertCanUseEntityAlias(state: FakeCoreState, alias: string | null, ownerId: string): void {
  const normalized = normalizeAlias(alias);
  if (!normalized) return;
  for (const [id, history] of state.entities) {
    if (id === ownerId) continue;
    const current = history.at(-1);
    if (!current || isDeletedAt(state, "entity", id, state.version, current.version)) continue;
    if (normalizeAlias(current.value.alias) === normalized) throw conflict("entity alias", normalized);
  }
}

function normalizeAlias(alias: string | null | undefined): string | null {
  const normalized = alias?.trim();
  return normalized ? normalized : null;
}

function visibleValue<T>(
  state: FakeCoreState,
  clientState: FakeClientState,
  values: ResourceHistory<T>,
  id: string,
  type: string
): T {
  const visible = visibleSnapshot(requireHistory(values, id, type), visibleVersion(state, clientState));
  if (!visible || isDeletedAt(state, type, id, visibleVersion(state, clientState), visible.version)) {
    throw notFound(type, id);
  }
  return cloneValue(visible.value);
}

function visibleValues<T>(
  state: FakeCoreState,
  clientState: FakeClientState,
  values: ResourceHistory<T>,
  type: ResourceType
): T[] {
  const version = visibleVersion(state, clientState);
  return [...values.entries()].flatMap(([id, history]) => {
    const stored = visibleSnapshot(history, version);
    return stored && !isDeletedAt(state, type, id, version, stored.version) ? [cloneValue(stored.value)] : [];
  });
}

function currentValues<T>(state: FakeCoreState, values: ResourceHistory<T>, type: ResourceType): T[] {
  return [...values.entries()].flatMap(([id, history]) => {
    const stored = history.at(-1);
    return stored && !isDeletedAt(state, type, id, state.version, stored.version) ? [cloneValue(stored.value)] : [];
  });
}

function visibleSnapshot<T>(history: Stored<T>[], version: number): Stored<T> | undefined {
  for (let index = history.length - 1; index >= 0; index--) {
    if (history[index]!.version <= version) return history[index];
  }
  return undefined;
}

function visibleVersion(state: FakeCoreState, clientState: FakeClientState): number {
  return clientState.sync ? clientState.visibleVersion : state.version;
}

function emitVisibleChanges(
  state: FakeCoreState,
  clientState: FakeClientState,
  fromVersion: number,
  toVersion: number
): void {
  if (toVersion <= fromVersion || clientState.watchers.length === 0) return;
  emitResourceChanges(state, clientState, "entity", state.entities, fromVersion, toVersion);
  emitResourceChanges(state, clientState, "task", state.tasks, fromVersion, toVersion);
  emitResourceChanges(state, clientState, "object", state.objects, fromVersion, toVersion);
}

function emitResourceChanges<T extends WatchableResource>(
  state: FakeCoreState,
  clientState: FakeClientState,
  type: ResourceType,
  values: ResourceHistory<T>,
  fromVersion: number,
  toVersion: number
): void {
  for (const [id, history] of values) {
    for (const [index, stored] of history.entries()) {
      if (stored.version <= fromVersion || stored.version > toVersion) continue;
      if (isDeletedAt(state, type, id, toVersion, stored.version)) continue;
      const previousVersion = history[index - 1]?.version;
      const followsDeletion =
        previousVersion !== undefined &&
        (state.tombstones.get(resourceKey(type, id)) ?? []).some(
          (deletedVersion) => deletedVersion > previousVersion && deletedVersion < stored.version
        );
      const event = resourceChangeEvent(
        type,
        index === 0 || followsDeletion ? "create" : "update",
        id,
        stored.version,
        stored.value
      );
      emitWatchEvent(clientState, stored.value, event);
    }
  }
}

function resourceChangeEvent(
  type: ResourceType,
  event: "create" | "update",
  id: string,
  version: number,
  resource: WatchableResource
): AtlasWatchEvent {
  if (type === "entity") {
    return event === "create"
      ? { event, resource_type: "entity", id, version, resource: cloneValue(resource as EntityResource) }
      : { event, resource_type: "entity", id, version, resource: cloneValue(resource as EntityResource) };
  }
  if (type === "task") {
    return event === "create"
      ? { event, resource_type: "task", id, version, resource: cloneValue(resource as TaskResource) }
      : { event, resource_type: "task", id, version, resource: cloneValue(resource as TaskResource) };
  }
  return event === "create"
    ? { event, resource_type: "object", id, version, resource: cloneValue(resource as ObjectResource) }
    : { event, resource_type: "object", id, version, resource: cloneValue(resource as ObjectResource) };
}

function emitWatchEvent(clientState: FakeClientState, resource: WatchableResource, event: AtlasWatchEvent): void {
  for (const watcher of [...clientState.watchers]) {
    if (matchesSubscription(watcher.filter, event, resource)) {
      watcher.callback(cloneValue(resource), cloneValue(event));
    }
  }
}

function matchesSubscription(filter: AtlasSubscription, event: AtlasWatchEvent, resource: WatchableResource): boolean {
  if (filter.filter === "all") return true;
  if (filter.filter === "id") return event.resource_type === filter.resource_type && event.id === filter.id;
  if (filter.filter === "type") return event.resource_type === filter.resource_type;
  return event.resource_type === "task" && (resource as TaskResource).asset_id === filter.asset_id;
}

function deleteValue<T>(
  state: FakeCoreState,
  clientState: FakeClientState,
  values: ResourceHistory<T>,
  id: string,
  type: "entity" | "object"
): void {
  const stored = requireActiveValue(state, values, id, type);
  const version = commitVersion(state, clientState);
  const key = resourceKey(type, id);
  state.tombstones.set(key, [...(state.tombstones.get(key) ?? []), version]);
  state.deleted.push(`${type}:${id}`);
  void stored;
}

function commitVersion(state: FakeCoreState, clientState: FakeClientState): number {
  state.version++;
  clientState.visibleVersion = state.version;
  return state.version;
}

function notFound(type: string, id: string): AtlasAPIError {
  const message = `${type} ${id} not found`;
  return new AtlasAPIError(message, 404, { message });
}

function conflict(type: string, id: string): AtlasAPIError {
  const message = `${type} ${id} already exists`;
  return new AtlasAPIError(message, 409, { message });
}

function saveValue<T>(values: ResourceHistory<T>, id: string, value: T, version: number): T {
  const history = values.get(id) ?? [];
  history.push({ value: cloneValue(value), version });
  values.set(id, history);
  return cloneValue(value);
}

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

function isDeletedAt(
  state: FakeCoreState,
  type: string,
  id: string,
  visibleVersionValue: number,
  resourceVersion: number
): boolean {
  return (state.tombstones.get(resourceKey(type, id)) ?? []).some(
    (deletedVersion) => deletedVersion > resourceVersion && deletedVersion <= visibleVersionValue
  );
}

function resourceKey(type: string, id: string): string {
  return `${type}:${id}`;
}
