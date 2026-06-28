import {
  AtlasAPIError,
  type EntityCreateRequest,
  type EntityResource,
  type EntityUpdateRequest,
  type ObjectCreateRequest,
  type ObjectResource,
  type TaskCreateRequest,
  type TaskResource
} from "../../../atlas_sdk/src/index.js";
import type {
  AtlasClientLike,
  AtlasClientFactory,
  ClientMode
} from "../../src/server/atlas.js";

type FakeCoreState = {
  version: number;
  entities: ResourceHistory<EntityResource>;
  tasks: ResourceHistory<TaskResource>;
  objects: ResourceHistory<ObjectResource>;
  tombstones: Map<string, number>;
  deleted: string[];
  clients: FakeClientState[];
};

type VersionedResource = { metadata: { version: number } };
type ResourceHistory<T extends VersionedResource> = Map<string, T[]>;

type FakeClientState = {
  sync: ClientMode;
  running: boolean;
  visibleVersion: number;
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
  const clientState: FakeClientState = { sync, running: false, visibleVersion: sync ? 0 : Number.POSITIVE_INFINITY };
  state.clients.push(clientState);
  return {
    entities: {
      get: async (id) => visibleValue(state, clientState, state.entities, id, "entity"),
      create: async (entity) => {
        const created = entityFromCreate(entity, ++state.version);
        state.tombstones.delete(resourceKey("entity", created.entity_id));
        return saveValue(state.entities, created.entity_id, created);
      },
      update: async (id, patch) => {
        const current = requireActiveValue(state, state.entities, id, "entity");
        const updated: EntityResource = {
          ...current,
          ...("entity_type" in patch && patch.entity_type !== undefined ? { entity_type: patch.entity_type } : {}),
          ...("subtype" in patch ? { subtype: patch.subtype ?? null } : {}),
          ...("alias" in patch ? { alias: patch.alias ?? null } : {}),
          ...(patch.components ? { components: { ...current.components, ...patch.components } } : {}),
          ...("extra" in patch ? { extra: patch.extra } : {}),
          metadata: metadata(++state.version, current.metadata.created_at)
        };
        return saveValue(state.entities, id, updated);
      },
      delete: async (id) => {
        deleteValue(state, state.entities, id, "entity");
      },
      checkIn: async (id, options) => {
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
          metadata: metadata(++state.version, current.metadata.created_at)
        };
        return { entity: saveValue(state.entities, id, updated), tasks: [], task_count: 0, task_limit: 10, has_more_tasks: false };
      }
    },
    tasks: {
      get: async (id) => visibleValue(state, clientState, state.tasks, id, "task"),
      create: async (task) => {
        const created = taskFromCreate(task, ++state.version);
        state.tombstones.delete(resourceKey("task", created.task_id));
        return saveValue(state.tasks, created.task_id, created);
      },
      delete: async (id) => {
        deleteValue(state, state.tasks, id, "task");
      },
      acknowledge: async (id) => updateTaskStatus(state, id, "acknowledged"),
      complete: async (id) => updateTaskStatus(state, id, "completed"),
      fail: async (id) => updateTaskStatus(state, id, "failed"),
      setStatus: async (id, status) => updateTaskStatus(state, id, status)
    },
    objects: {
      get: async (id) => visibleValue(state, clientState, state.objects, id, "object"),
      create: async (object) => {
        const created = objectFromCreate(object, ++state.version);
        state.tombstones.delete(resourceKey("object", created.object_id));
        return saveValue(state.objects, created.object_id, created);
      },
      delete: async (id) => {
        deleteValue(state, state.objects, id, "object");
      }
    },
    queries: {
      full: async () => ({
        entities: visibleValues(clientState, state.entities, state, "entity"),
        tasks: visibleValues(clientState, state.tasks, state, "task"),
        objects: visibleValues(clientState, state.objects, state, "object")
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
        if (clientState.running) clientState.visibleVersion = state.version;
        return { running: clientState.running, healthy: clientState.running, degraded: false, lastVersion: visibleVersion(state, clientState) };
      }
    },
    watch: () => () => undefined,
    handshake: async () => undefined
  };
}

function entityFromCreate(request: EntityCreateRequest, version: number): EntityResource {
  return {
    entity_id: request.entity_id,
    entity_type: request.entity_type,
    alias: request.alias ?? null,
    subtype: request.subtype ?? null,
    components: request.components ?? {},
    ...("extra" in request ? { extra: request.extra } : {}),
    metadata: metadata(version)
  };
}

function taskFromCreate(request: TaskCreateRequest, version: number): TaskResource {
  return {
    task_id: request.task_id,
    entity_id: request.entity_id ?? null,
    status: request.status ?? "pending",
    components: request.components ?? {},
    ...("extra" in request ? { extra: request.extra } : {}),
    metadata: metadata(version)
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

function updateTaskStatus(state: FakeCoreState, id: string, status: string): TaskResource {
  const current = requireActiveValue(state, state.tasks, id, "task");
  const updated = { ...current, status, metadata: metadata(++state.version, current.metadata.created_at) };
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
  if (isDeletedAt(state, type, id, state.version)) throw notFound(type, id);
  return value;
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
  if (!value || isDeletedAt(state, type, id, version)) throw notFound(type, id);
  return cloneValue(value);
}

function visibleValues<T extends VersionedResource>(clientState: FakeClientState, values: ResourceHistory<T>, state?: FakeCoreState, type?: string): T[] {
  const version = state ? visibleVersion(state, clientState) : clientState.visibleVersion;
  return [...values.values()]
    .map((history) => visibleSnapshot(history, version))
    .filter((value): value is T => value !== undefined)
    .filter((value) => !state || !type || !isDeletedAt(state, type, resourceId(value as { entity_id?: string; task_id?: string; object_id?: string }), version))
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

function deleteValue<T extends VersionedResource>(state: FakeCoreState, values: ResourceHistory<T>, id: string, type: string): void {
  requireValue(values, id, type);
  if (isDeletedAt(state, type, id, state.version)) throw notFound(type, id);
  state.version += 1;
  state.tombstones.set(resourceKey(type, id), state.version);
  state.deleted.push(`${type}:${id}`);
}

function notFound(type: string, id: string): AtlasAPIError {
  const message = `${type} ${id} not found`;
  return new AtlasAPIError(message, 404, { message });
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

function isDeletedAt(state: FakeCoreState, type: string, id: string, visibleVersionValue: number): boolean {
  const deletedVersion = state.tombstones.get(resourceKey(type, id));
  return deletedVersion !== undefined && deletedVersion <= visibleVersionValue;
}

function resourceKey(type: string, id: string): string {
  return `${type}:${id}`;
}

function resourceId(value: { entity_id?: string; task_id?: string; object_id?: string }): string {
  return value.entity_id ?? value.task_id ?? value.object_id ?? "";
}
