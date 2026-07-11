import { randomUUID } from "node:crypto";
import {
  AtlasAPIError,
  type AtlasSubscription,
  type AtlasWatchEvent,
  type EntityCheckInMinimalTask,
  type EntityCreateRequest,
  type EntityResource,
  type ObjectCreateRequest,
  type ObjectResource,
  type ResourceType,
  type TaskCreateRequest,
  type TaskResource
} from "@the-drunken-coder/atlas-sdk";
import type { AtlasClientLike, AtlasClientFactory, ClientMode } from "../../src/server/atlas.js";

type FakeCoreState = {
  version: number;
  entities: ResourceHistory<EntityResource>;
  tasks: ResourceHistory<TaskResource>;
  objects: ResourceHistory<ObjectResource>;
  tombstones: Map<string, number[]>;
  deleted: string[];
  clients: FakeClientState[];
};

type VersionedResource = { metadata: { version: number } };
type ResourceHistory<T extends VersionedResource> = Map<string, T[]>;
type WatchableResource = EntityResource | TaskResource | ObjectResource;
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
    clients: []
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
      create: async (entity) => {
        assertCanCreateEntity(state, entity.entity_id, entity.alias);
        const created = entityFromCreate(entity, commitVersion(state, clientState));
        return saveValue(state.entities, created.entity_id, created);
      },
      update: async (id, patch) => {
        const current = requireActiveValue(state, state.entities, id, "entity");
        if ("alias" in patch) assertCanUseEntityAlias(state, patch.alias ?? null, id);
        const updated: EntityResource = {
          ...current,
          ...("entity_type" in patch && patch.entity_type !== undefined ? { entity_type: patch.entity_type } : {}),
          ...("subtype" in patch ? { subtype: patch.subtype ?? null } : {}),
          ...("alias" in patch ? { alias: normalizeAlias(patch.alias) } : {}),
          ...(patch.components ? { components: { ...current.components, ...patch.components } } : {}),
          ...("extra" in patch ? { extra: patch.extra } : {}),
          metadata: metadata(commitVersion(state, clientState), current.metadata.created_at)
        };
        return saveValue(state.entities, id, updated);
      },
      delete: async (id) => {
        deleteValue(state, clientState, state.entities, id, "entity");
      },
      checkIn: (async (id, options) => {
        const current = requireActiveValue(state, state.entities, id, "entity");
        const telemetry = options?.telemetry;
        const updated: EntityResource = {
          ...current,
          components: {
            ...current.components,
            ...options?.components,
            ...(options?.status ? { status: { value: options.status, last_update: new Date().toISOString() } } : {}),
            ...(telemetry ? { telemetry: { ...current.components.telemetry, ...telemetry, last_update: new Date().toISOString() } } : {})
          },
          metadata: metadata(commitVersion(state, clientState), current.metadata.created_at)
        };
        const entity = saveValue(state.entities, id, updated);
        const taskLimit = options?.limit ?? 10;
        const statusFilter = new Set<string>(options?.statusFilter ?? ["pending"]);
        const matchingTasks = visibleValues(state, { sync: false, running: false, visibleVersion: state.version, watchers: [] }, state.tasks, "task").filter(
          (task) => task.entity_id === id && statusFilter.has(task.status)
        );
        const tasks = matchingTasks.slice(0, taskLimit);
        return {
          entity,
          tasks: options?.fields === "minimal" ? tasks.map(minimalTask) : tasks,
          task_count: matchingTasks.length,
          task_limit: taskLimit,
          has_more_tasks: matchingTasks.length > taskLimit
        };
      }) as AtlasClientLike["entities"]["checkIn"]
    },
    tasks: {
      get: async (id) => visibleValue(state, clientState, state.tasks, id, "task"),
      create: async (task) => {
        const taskID = taskIDFromCreate(task);
        assertCanCreate(state, state.tasks, taskID, "task");
        const created = taskFromCreate(task, commitVersion(state, clientState), taskID);
        return saveValue(state.tasks, created.task_id, created);
      },
      delete: async (id) => {
        deleteValue(state, clientState, state.tasks, id, "task");
      },
      acknowledge: async (id) => updateTaskStatus(state, clientState, id, "acknowledged"),
      complete: async (id) => updateTaskStatus(state, clientState, id, "completed"),
      fail: async (id) => updateTaskStatus(state, clientState, id, "failed"),
      setStatus: async (id, status) => updateTaskStatus(state, clientState, id, status)
    },
    objects: {
      get: async (id) => visibleValue(state, clientState, state.objects, id, "object"),
      create: async (object) => {
        assertCanCreate(state, state.objects, object.object_id, "object");
        const created = objectFromCreate(object, commitVersion(state, clientState));
        return saveValue(state.objects, created.object_id, created);
      },
      delete: async (id) => {
        deleteValue(state, clientState, state.objects, id, "object");
      }
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
          subscriptions: clientState.sync === "all" ? [{ filter: "all" }] : []
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

function taskFromCreate(request: TaskCreateRequest, version: number, taskID = taskIDFromCreate(request)): TaskResource {
  return {
    task_id: taskID,
    entity_id: request.entity_id ?? null,
    status: request.status ?? "pending",
    components: request.components ?? {},
    ...("extra" in request ? { extra: request.extra } : {}),
    metadata: metadata(version)
  };
}

function taskIDFromCreate(request: TaskCreateRequest): string {
  return "task_id" in request ? request.task_id : `command-${randomUUID()}`;
}

function minimalTask(task: TaskResource): EntityCheckInMinimalTask {
  return {
    task_id: task.task_id,
    status: task.status,
    ...(task.entity_id ? { entity_id: task.entity_id } : {})
  };
}

function objectFromCreate(request: ObjectCreateRequest, version: number): ObjectResource {
  return {
    object_id: request.object_id,
    type: request.type ?? null,
    path: request.path ?? null,
    bucket: null,
    content_type: request.content_type ?? null,
    size_bytes: request.size_bytes ?? null,
    usage_hints: request.usage_hints ?? [],
    referenced_by: request.referenced_by ?? [],
    metadata: metadata(version)
  };
}

function updateTaskStatus(state: FakeCoreState, clientState: FakeClientState, id: string, status: string): TaskResource {
  const current = requireActiveValue(state, state.tasks, id, "task");
  const updated = { ...current, status, metadata: metadata(commitVersion(state, clientState), current.metadata.created_at) };
  return saveValue(state.tasks, id, updated);
}

function metadata(version: number, createdAt?: string) {
  const now = new Date().toISOString();
  return { created_at: createdAt ?? now, updated_at: now, version };
}

function requireHistory<T extends VersionedResource>(values: ResourceHistory<T>, id: string, type: string): T[] {
  const history = values.get(id);
  if (!history?.length) throw notFound(type, id);
  return history;
}

function requireValue<T extends VersionedResource>(values: ResourceHistory<T>, id: string, type: string): T {
  return requireHistory(values, id, type).at(-1)!;
}

function requireActiveValue<T extends VersionedResource>(state: FakeCoreState, values: ResourceHistory<T>, id: string, type: string): T {
  const value = requireValue(values, id, type);
  if (isDeletedAt(state, type, id, state.version, value.metadata.version)) throw notFound(type, id);
  return value;
}

function assertCanCreate<T extends VersionedResource>(state: FakeCoreState, values: ResourceHistory<T>, id: string, type: string): void {
  const current = values.get(id)?.at(-1);
  if (current && !isDeletedAt(state, type, id, state.version, current.metadata.version)) throw conflict(type, id);
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
    if (!current || isDeletedAt(state, "entity", id, state.version, current.metadata.version)) continue;
    if (normalizeAlias(current.alias) === normalized) {
      throw conflict("entity alias", normalized);
    }
  }
}

function normalizeAlias(alias: string | null | undefined): string | null {
  const normalized = alias?.trim();
  return normalized ? normalized : null;
}

function visibleValue<T extends { metadata: { version: number } }>(
  state: FakeCoreState,
  clientState: FakeClientState,
  values: ResourceHistory<T>,
  id: string,
  type: string
): T {
  const history = requireHistory(values, id, type);
  const version = visibleVersion(state, clientState);
  const value = visibleSnapshot(history, version);
  if (!value || isDeletedAt(state, type, id, version, value.metadata.version)) throw notFound(type, id);
  return cloneValue(value);
}

function visibleValues<T extends VersionedResource>(state: FakeCoreState, clientState: FakeClientState, values: ResourceHistory<T>, type: string): T[] {
  const version = visibleVersion(state, clientState);
  return [...values.values()]
    .map((history) => visibleSnapshot(history, version))
    .filter((value): value is T => value !== undefined)
    .filter(
      (value) =>
        !isDeletedAt(state, type, resourceId(value as { entity_id?: string; task_id?: string; object_id?: string }, type), version, value.metadata.version)
    )
    .map(cloneValue);
}

function visibleSnapshot<T extends VersionedResource>(history: T[], version: number): T | undefined {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const value = history[index]!;
    if (value.metadata.version <= version) return value;
  }
  return undefined;
}

function visibleVersion(state: FakeCoreState, clientState: FakeClientState): number {
  return clientState.sync ? clientState.visibleVersion : state.version;
}

function emitVisibleChanges(state: FakeCoreState, clientState: FakeClientState, fromVersion: number, toVersion: number): void {
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
  for (const history of values.values()) {
    for (const value of history) {
      if (value.metadata.version <= fromVersion || value.metadata.version > toVersion) continue;
      const id = resourceId(value, type);
      if (isDeletedAt(state, type, id, toVersion, value.metadata.version)) continue;
      const resource = cloneValue(value);
      const event = {
        event: "recovered",
        resource_type: type,
        id,
        version: value.metadata.version,
        resource
      } as AtlasWatchEvent;
      emitWatchEvent(clientState, resource, event);
    }
  }
}

function emitWatchEvent(clientState: FakeClientState, resource: WatchableResource, event: AtlasWatchEvent): void {
  for (const watcher of [...clientState.watchers]) {
    if (matchesSubscription(watcher.filter, event, resource)) watcher.callback(cloneValue(resource), cloneValue(event));
  }
}

function matchesSubscription(filter: AtlasSubscription, event: AtlasWatchEvent, resource: WatchableResource): boolean {
  if (filter.filter === "all") return true;
  if (filter.filter === "id") return event.resource_type === filter.resource_type && event.id === filter.id;
  if (filter.filter === "type") return event.resource_type === filter.resource_type;
  return event.resource_type === "task" && (resource as TaskResource).entity_id === filter.entity_id;
}

function deleteValue<T extends VersionedResource>(
  state: FakeCoreState,
  clientState: FakeClientState,
  values: ResourceHistory<T>,
  id: string,
  type: string
): void {
  const value = requireValue(values, id, type);
  if (isDeletedAt(state, type, id, state.version, value.metadata.version)) throw notFound(type, id);
  commitVersion(state, clientState);
  const key = resourceKey(type, id);
  state.tombstones.set(key, [...(state.tombstones.get(key) ?? []), state.version]);
  state.deleted.push(`${type}:${id}`);
}

function commitVersion(state: FakeCoreState, clientState: FakeClientState): number {
  state.version += 1;
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

function saveValue<T extends VersionedResource>(values: ResourceHistory<T>, id: string, value: T): T {
  const history = values.get(id) ?? [];
  history.push(cloneValue(value));
  values.set(id, history);
  return cloneValue(value);
}

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

function isDeletedAt(state: FakeCoreState, type: string, id: string, visibleVersionValue: number, resourceVersion: number): boolean {
  return (state.tombstones.get(resourceKey(type, id)) ?? []).some(
    (deletedVersion) => deletedVersion > resourceVersion && deletedVersion <= visibleVersionValue
  );
}

function resourceKey(type: string, id: string): string {
  return `${type}:${id}`;
}

function resourceId(value: { entity_id?: string | null; task_id?: string | null; object_id?: string | null }, type: string): string {
  if (type === "entity") return value.entity_id ?? "";
  if (type === "task") return value.task_id ?? "";
  if (type === "object") return value.object_id ?? "";
  return "";
}
