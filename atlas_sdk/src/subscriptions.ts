import type {
  EntityResource,
  FeedEvent,
  FeedSubscribeMessage,
  FeedUnsubscribeMessage,
  ObjectResource,
  ResourceType,
  TaskResource
} from "./protocol.js";
import type { AtlasLocalDeleteWatchEvent, AtlasSubscription, AtlasWatchEvent } from "./types.js";

export function subscriptionMessage(action: "subscribe" | "unsubscribe", filter: AtlasSubscription): FeedSubscribeMessage | FeedUnsubscribeMessage {
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
  const [kind, resourceType, id] = JSON.parse(key) as string[];
  if (kind === "all") return { filter: "all" };
  if (kind === "id") return { filter: "id", resource_type: resourceType as ResourceType, id };
  if (kind === "type") return { filter: "type", resource_type: resourceType as ResourceType };
  return { filter: "tasks_for_entity", entity_id: resourceType };
}

export function covers(covering: AtlasSubscription, wanted: AtlasSubscription): boolean {
  if (covering.filter === "all") return true;
  if (covering.filter === "type" && wanted.filter === "id") return covering.resource_type === wanted.resource_type;
  return subscriptionKey(covering) === subscriptionKey(wanted);
}

export function matchesSubscription(filter: AtlasSubscription, event: AtlasWatchEvent, previous?: EntityResource | TaskResource | ObjectResource): boolean {
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
      return (
        (event.event !== "delete" && event.event !== "local_delete" && (event.resource as TaskResource).entity_id === filter.entity_id) ||
        (event as FeedEvent & { entity_id?: string | null }).entity_id === filter.entity_id ||
        (event as FeedEvent & { previous_entity_id?: string | null }).previous_entity_id === filter.entity_id ||
        ((previous as TaskResource | undefined)?.entity_id ?? "") === filter.entity_id
      );
  }
}

export function resourceID(type: ResourceType, resource: EntityResource | TaskResource | ObjectResource): string {
  if (type === "entity") return (resource as EntityResource).entity_id;
  if (type === "task") return (resource as TaskResource).task_id;
  return (resource as ObjectResource).object_id;
}

export function resourceCacheKey(type: ResourceType, id: string): string {
  return JSON.stringify([type, id]);
}

export function localDeleteEvent(type: ResourceType, id: string, previousVersion: number): AtlasLocalDeleteWatchEvent {
  const event: AtlasLocalDeleteWatchEvent = { event: "local_delete", resource_type: type, id };
  if (previousVersion > 0) {
    event.previous_version = previousVersion;
  }
  return event;
}
