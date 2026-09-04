import {
  type FeedEvent,
  type FeedSubscribeMessage,
  type FeedUnsubscribeMessage,
  isResourceType,
  type ResourceType
} from "./protocol.js";
import { normalizeResourceID } from "./resource-id.js";
import type {
  AtlasLocalDeleteWatchEvent,
  AtlasSubscription,
  AtlasWatchEvent,
  DeletableResourceType,
  ResourceForSubscription,
  ResourceOf,
  ResourceValue
} from "./types.js";

export function normalizeSubscription(filter: AtlasSubscription): AtlasSubscription {
  switch (filter.filter) {
    case "all":
    case "type":
      return filter;
    case "id":
      return {
        ...filter,
        id: normalizeResourceID(`${filter.resource_type}_id`, filter.id)
      };
    case "tasks_for_asset":
      return { ...filter, asset_id: normalizeResourceID("asset_id", filter.asset_id) };
  }
}

export function subscriptionMessage(
  action: "subscribe" | "unsubscribe",
  filter: AtlasSubscription
): FeedSubscribeMessage | FeedUnsubscribeMessage {
  return { action, ...normalizeSubscription(filter) } as FeedSubscribeMessage | FeedUnsubscribeMessage;
}

export function subscriptionKey(filter: AtlasSubscription): string {
  const normalized = normalizeSubscription(filter);
  switch (normalized.filter) {
    case "all":
      return JSON.stringify(["all"]);
    case "id":
      return JSON.stringify(["id", normalized.resource_type, normalized.id]);
    case "type":
      return JSON.stringify(["type", normalized.resource_type]);
    case "tasks_for_asset":
      return JSON.stringify(["tasks_for_asset", normalized.asset_id]);
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
  if (kind === "id" && parsed.length === 3 && isResourceType(resourceType) && typeof id === "string") {
    try {
      return normalizeSubscription({ filter: "id", resource_type: resourceType, id });
    } catch {
      throw new Error("invalid subscription key");
    }
  }
  if (kind === "type" && parsed.length === 2 && isResourceType(resourceType)) {
    return { filter: "type", resource_type: resourceType };
  }
  if (kind === "tasks_for_asset" && parsed.length === 2 && typeof resourceType === "string") {
    try {
      return normalizeSubscription({ filter: "tasks_for_asset", asset_id: resourceType });
    } catch {
      throw new Error("invalid subscription key");
    }
  }
  throw new Error("invalid subscription key");
}

export function covers(covering: AtlasSubscription, wanted: AtlasSubscription): boolean {
  if (covering.filter === "all") return true;
  if (covering.filter === "type" && wanted.filter === "id") return covering.resource_type === wanted.resource_type;
  return subscriptionKey(covering) === subscriptionKey(wanted);
}

export function matchesSubscription(filter: AtlasSubscription, event: AtlasWatchEvent): boolean {
  const normalized = normalizeSubscription(filter);
  switch (normalized.filter) {
    case "all":
      return true;
    case "id":
      return (
        event.resource_type === normalized.resource_type &&
        normalizeResourceID(`${normalized.resource_type}_id`, event.id) === normalized.id
      );
    case "type":
      return event.resource_type === normalized.resource_type;
    case "tasks_for_asset":
      if (event.resource_type !== "task") {
        return false;
      }
      return normalizeResourceID("asset_id", event.resource.asset_id) === normalized.asset_id;
  }
}

export function resourceID<TType extends ResourceType>(type: TType, resource: ResourceOf<TType>): string;
export function resourceID(type: ResourceType, resource: ResourceValue): string {
  switch (type) {
    case "entity":
      assertResourceMatchesType("entity", resource);
      return normalizeResourceID("entity_id", resource.entity_id);
    case "task":
      assertResourceMatchesType("task", resource);
      return normalizeResourceID("task_id", resource.task_id);
    case "object":
      assertResourceMatchesType("object", resource);
      return normalizeResourceID("object_id", resource.object_id);
  }
}

export function resourceCacheKey(type: ResourceType, id: string): string {
  return JSON.stringify([type, normalizeResourceID(`${type}_id`, id)]);
}

export function localDeleteEvent(
  type: DeletableResourceType,
  id: string,
  previousVersion: number
): AtlasLocalDeleteWatchEvent {
  const normalizedID = normalizeResourceID(`${type}_id`, id);
  switch (type) {
    case "entity":
      return previousVersion > 0
        ? { event: "local_delete", resource_type: "entity", id: normalizedID, previous_version: previousVersion }
        : { event: "local_delete", resource_type: "entity", id: normalizedID };
    case "object":
      return previousVersion > 0
        ? { event: "local_delete", resource_type: "object", id: normalizedID, previous_version: previousVersion }
        : { event: "local_delete", resource_type: "object", id: normalizedID };
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
  const normalizedID = normalizeResourceID(`${type}_id`, id);
  if (actualID !== normalizedID) {
    throw new TypeError(`Atlas ${type} resource id ${actualID} does not match event id ${normalizedID}`);
  }
  switch (type) {
    case "entity":
      assertResourceMatchesType("entity", resource);
      return event === "create"
        ? { event: "create", resource_type: "entity", id: normalizedID, version, resource }
        : { event: "update", resource_type: "entity", id: normalizedID, version, resource };
    case "task":
      assertResourceMatchesType("task", resource);
      return event === "create"
        ? { event: "create", resource_type: "task", id: normalizedID, version, resource }
        : { event: "update", resource_type: "task", id: normalizedID, version, resource };
    case "object":
      assertResourceMatchesType("object", resource);
      return event === "create"
        ? { event: "create", resource_type: "object", id: normalizedID, version, resource }
        : { event: "update", resource_type: "object", id: normalizedID, version, resource };
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
    case "tasks_for_asset":
      assertResourceMatchesType("task", resource);
      return;
    case "id":
    case "type":
      assertResourceMatchesType(filter.resource_type, resource);
  }
}

function resourceTypeName(resource: ResourceValue): ResourceType {
  if ("task_id" in resource) return "task";
  if ("object_id" in resource) return "object";
  return "entity";
}
