import type { FeedEvent, FeedSubscribeMessage, FeedUnsubscribeMessage, ResourceType } from "./protocol.js";
import type {
  AtlasLocalDeleteWatchEvent,
  AtlasSubscription,
  AtlasWatchEvent,
  ResourceForSubscription,
  ResourceOf,
  ResourceValue
} from "./types.js";

const RESOURCE_TYPES = new Set<string>(["entity", "task", "object"]);

export function subscriptionMessage(
  action: "subscribe" | "unsubscribe",
  filter: AtlasSubscription
): FeedSubscribeMessage | FeedUnsubscribeMessage {
  return { action, ...filter } as FeedSubscribeMessage | FeedUnsubscribeMessage;
}

export function subscriptionKey(filter: AtlasSubscription): string {
  switch (filter.filter) {
    case "all":
      return JSON.stringify(["all"]);
    case "id":
      return JSON.stringify(["id", filter.resource_type, filter.id]);
    case "type":
      return JSON.stringify(["type", filter.resource_type]);
    case "tasks_for_entity":
      return JSON.stringify(["tasks_for_entity", filter.entity_id]);
  }
}

export function parseSubscriptionKey(key: string): AtlasSubscription {
  let parsed: unknown;
  try {
    parsed = JSON.parse(key);
  } catch {
    throw new Error("invalid subscription key");
  }
  if (!Array.isArray(parsed) || !parsed.every((part) => typeof part === "string")) {
    throw new Error("invalid subscription key");
  }
  const [kind, resourceType, id] = parsed;
  if (kind === "all" && parsed.length === 1) return { filter: "all" };
  if (kind === "id" && parsed.length === 3 && isResourceType(resourceType) && isNonEmptyString(id)) {
    return { filter: "id", resource_type: resourceType, id };
  }
  if (kind === "type" && parsed.length === 2 && isResourceType(resourceType)) {
    return { filter: "type", resource_type: resourceType };
  }
  if (kind === "tasks_for_entity" && parsed.length === 2 && isNonEmptyString(resourceType)) {
    return { filter: "tasks_for_entity", entity_id: resourceType };
  }
  throw new Error("invalid subscription key");
}

export function covers(covering: AtlasSubscription, wanted: AtlasSubscription): boolean {
  if (covering.filter === "all") return true;
  if (covering.filter === "type" && wanted.filter === "id") return covering.resource_type === wanted.resource_type;
  return subscriptionKey(covering) === subscriptionKey(wanted);
}

export function matchesSubscription(
  filter: AtlasSubscription,
  event: AtlasWatchEvent,
  previous?: ResourceValue
): boolean {
  switch (filter.filter) {
    case "all":
      return true;
    case "id":
      return event.resource_type === filter.resource_type && event.id === filter.id;
    case "type":
      return event.resource_type === filter.resource_type;
    case "tasks_for_entity":
      if (event.resource_type !== "task") {
        return false;
      }
      return taskEventEntityIDs(event, previous).some((entityID) => entityID === filter.entity_id);
  }
}

export function resourceID<TType extends ResourceType>(type: TType, resource: ResourceOf<TType>): string;
export function resourceID(type: ResourceType, resource: ResourceValue): string {
  switch (type) {
    case "entity":
      assertResourceMatchesType("entity", resource);
      return resource.entity_id;
    case "task":
      assertResourceMatchesType("task", resource);
      return resource.task_id;
    case "object":
      assertResourceMatchesType("object", resource);
      return resource.object_id;
  }
}

export function resourceCacheKey(type: ResourceType, id: string): string {
  return JSON.stringify([type, id]);
}

export function localDeleteEvent(type: ResourceType, id: string, previousVersion: number): AtlasLocalDeleteWatchEvent {
  switch (type) {
    case "entity":
      return previousVersion > 0
        ? { event: "local_delete", resource_type: "entity", id, previous_version: previousVersion }
        : { event: "local_delete", resource_type: "entity", id };
    case "task":
      return previousVersion > 0
        ? { event: "local_delete", resource_type: "task", id, previous_version: previousVersion }
        : { event: "local_delete", resource_type: "task", id };
    case "object":
      return previousVersion > 0
        ? { event: "local_delete", resource_type: "object", id, previous_version: previousVersion }
        : { event: "local_delete", resource_type: "object", id };
  }
}

export function resourceUpsertEvent<TType extends ResourceType>(
  type: TType,
  event: "create" | "update",
  id: string,
  version: number,
  resource: ResourceOf<TType>
): FeedEvent {
  const actualID = resourceID(type, resource);
  if (actualID !== id) {
    throw new TypeError(`Atlas ${type} resource id ${actualID} does not match event id ${id}`);
  }
  switch (type) {
    case "entity":
      assertResourceMatchesType("entity", resource);
      return event === "create"
        ? { event: "create", resource_type: "entity", id, version, resource }
        : { event: "update", resource_type: "entity", id, version, resource };
    case "task":
      assertResourceMatchesType("task", resource);
      return event === "create"
        ? { event: "create", resource_type: "task", id, version, resource }
        : { event: "update", resource_type: "task", id, version, resource };
    case "object":
      assertResourceMatchesType("object", resource);
      return event === "create"
        ? { event: "create", resource_type: "object", id, version, resource }
        : { event: "update", resource_type: "object", id, version, resource };
  }
}

export function assertResourceMatchesType<TType extends ResourceType>(
  type: TType,
  resource: ResourceValue
): asserts resource is ResourceOf<TType> {
  if (!resourceMatchesType(type, resource)) {
    throw new TypeError(`Atlas ${resourceTypeName(resource)} resource cannot be used as ${type}`);
  }
}

export function resourceMatchesType<TType extends ResourceType>(
  type: TType,
  resource: ResourceValue
): resource is ResourceOf<TType> {
  switch (type) {
    case "entity":
      return "entity_id" in resource && "entity_type" in resource;
    case "task":
      return "task_id" in resource;
    case "object":
      return "object_id" in resource;
  }
}

export function assertResourceMatchesSubscription<TFilter extends AtlasSubscription>(
  filter: TFilter,
  resource: ResourceValue
): asserts resource is ResourceForSubscription<TFilter> {
  switch (filter.filter) {
    case "all":
      return;
    case "tasks_for_entity":
      assertResourceMatchesType("task", resource);
      return;
    case "id":
    case "type":
      assertResourceMatchesType(filter.resource_type, resource);
  }
}

function isResourceType(value: string): value is ResourceType {
  return RESOURCE_TYPES.has(value);
}

function isNonEmptyString(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

function taskEventEntityIDs(
  event: Extract<AtlasWatchEvent, { resource_type: "task" }>,
  previous?: ResourceValue
): Array<string | null | undefined> {
  const ids: Array<string | null | undefined> = [];
  if (event.event === "delete") {
    ids.push(event.entity_id);
  } else if (event.event === "update") {
    ids.push(event.resource.entity_id, event.previous_entity_id);
  } else if (event.event === "create" || event.event === "recovered") {
    ids.push(event.resource.entity_id);
  }
  if (previous && resourceMatchesType("task", previous)) {
    ids.push(previous.entity_id);
  }
  return ids;
}

function resourceTypeName(resource: ResourceValue): ResourceType {
  if ("task_id" in resource) return "task";
  if ("object_id" in resource) return "object";
  return "entity";
}
