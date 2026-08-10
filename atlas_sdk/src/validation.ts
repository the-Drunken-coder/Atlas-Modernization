import type { ResponseValidator } from "./http.js";
import {
  type ChangedSinceResponse,
  type CommandCatalog,
  type EntityCheckInFullResponse,
  type EntityCheckInMinimalResponse,
  type EntityCheckInResponse,
  type EntityResource,
  type FeedEvent,
  type FeedHandshakeMessage,
  type FeedSubscriptionsReadyMessage,
  type FullDatasetResponse,
  isFeedHandshakeMessage,
  isFeedSubscriptionsReadyMessage,
  isChangedSinceResponse as isGeneratedChangedSinceResponse,
  isCommandCatalog as isGeneratedCommandCatalog,
  isEntityCheckInFullResponse as isGeneratedEntityCheckInFullResponse,
  isEntityCheckInMinimalResponse as isGeneratedEntityCheckInMinimalResponse,
  isEntityResource as isGeneratedEntityResource,
  isFeedEvent as isGeneratedFeedEvent,
  isFullDatasetResponse as isGeneratedFullDatasetResponse,
  isObjectDetailResource as isGeneratedObjectDetailResource,
  isObjectResource as isGeneratedObjectResource,
  isProtocolRevisionResponse as isGeneratedProtocolRevisionResponse,
  isTaskResource as isGeneratedTaskResource,
  type ObjectDetailResource,
  type ObjectResource,
  type ProtocolRevisionResponse,
  type TaskResource
} from "./protocol.js";
import type { EntityCheckInFields } from "./types.js";

const fullPaginationFields = [
  ["has_more_entities", "next_entity_cursor"],
  ["has_more_tasks", "next_task_cursor"],
  ["has_more_objects", "next_object_cursor"]
] as const;
const changedPaginationFields = [["has_more", "next_cursor"]] as const;

export const isCommandCatalog: ResponseValidator<CommandCatalog> = isGeneratedCommandCatalog;

export const isProtocolRevisionResponse: ResponseValidator<ProtocolRevisionResponse> =
  isGeneratedProtocolRevisionResponse;

export const isEntityResource: ResponseValidator<EntityResource> = (value): value is EntityResource =>
  isGeneratedEntityResource(value) && isFeedVersion(value.metadata.version);

export const isTaskResource: ResponseValidator<TaskResource> = (value): value is TaskResource =>
  isGeneratedTaskResource(value) && isFeedVersion(value.metadata.version);

export const isObjectResource: ResponseValidator<ObjectResource> = (value): value is ObjectResource =>
  isGeneratedObjectResource(value) && isFeedVersion(value.metadata.version);

export const isObjectDetailResource: ResponseValidator<ObjectDetailResource> = (value): value is ObjectDetailResource =>
  isGeneratedObjectDetailResource(value) && isFeedVersion(value.metadata.version);

export const isFullDatasetResponse: ResponseValidator<FullDatasetResponse> = (value): value is FullDatasetResponse =>
  isGeneratedFullDatasetResponse(value) &&
  value.entities.every(isEntityResource) &&
  value.tasks.every(isTaskResource) &&
  value.objects.every(isObjectDetailResource) &&
  isSafeNonNegativeInteger(value.version) &&
  hasValidPagination(value, fullPaginationFields);

export function changedSinceResponseValidator(sinceVersion: number): ResponseValidator<ChangedSinceResponse> {
  return (value): value is ChangedSinceResponse => {
    if (
      !isSafeNonNegativeInteger(sinceVersion) ||
      !isGeneratedChangedSinceResponse(value) ||
      !value.events.every(isInboundFeedEvent) ||
      !isSafeNonNegativeInteger(value.version) ||
      value.version < sinceVersion ||
      !hasValidPagination(value, changedPaginationFields) ||
      (value.has_more && value.events.length === 0)
    ) {
      return false;
    }

    const highWaterVersion = value.version;
    let previousVersion = sinceVersion;
    return value.events.every((event) => {
      const ordered = event.version > previousVersion && event.version <= highWaterVersion;
      previousVersion = event.version;
      return ordered;
    });
  };
}

export function entityCheckInResponseValidator(
  expectedEntityID: string,
  fields: EntityCheckInFields
): ResponseValidator<EntityCheckInResponse> {
  return (value): value is EntityCheckInResponse => {
    if (fields === "minimal") {
      return (
        isGeneratedEntityCheckInMinimalResponse(value) &&
        value.tasks.every((task) => task.entity_id === undefined || task.entity_id === expectedEntityID) &&
        hasValidEntityCheckInContext(value, expectedEntityID)
      );
    }
    return (
      isGeneratedEntityCheckInFullResponse(value) &&
      value.tasks.every((task) => isTaskResource(task) && task.entity_id === expectedEntityID) &&
      hasValidEntityCheckInContext(value, expectedEntityID)
    );
  };
}

function hasValidEntityCheckInContext(
  value: EntityCheckInFullResponse | EntityCheckInMinimalResponse,
  expectedEntityID: string
): boolean {
  return (
    isEntityResource(value.entity) &&
    value.entity.entity_id === expectedEntityID &&
    value.task_count === value.tasks.length &&
    value.tasks.length <= value.task_limit &&
    hasValidPagination(value, [["has_more_tasks", "next_task_cursor"]])
  );
}

export function isInboundFeedHandshake(value: unknown): value is FeedHandshakeMessage {
  return isFeedHandshakeMessage(value);
}

export function isInboundFeedSubscriptionsReady(value: unknown): value is FeedSubscriptionsReadyMessage {
  return isFeedSubscriptionsReadyMessage(value);
}

export function isInboundFeedEvent(value: unknown): value is FeedEvent {
  if (!isGeneratedFeedEvent(value) || !isFeedVersion(value.version)) return false;
  if (value.event === "delete") return true;
  switch (value.resource_type) {
    case "entity":
      return value.id === value.resource.entity_id && value.version === value.resource.metadata.version;
    case "task":
      return value.id === value.resource.task_id && value.version === value.resource.metadata.version;
    case "object":
      return value.id === value.resource.object_id && value.version === value.resource.metadata.version;
  }
}

function hasValidPagination(
  value: object,
  fields: ReadonlyArray<readonly [hasMore: string, nextCursor: string]>
): boolean {
  const record = value as Record<string, unknown>;
  return fields.every(([hasMore, nextCursor]) => {
    if (!hasOwn(record, hasMore) || typeof record[hasMore] !== "boolean") return false;
    if (record[hasMore]) return hasOwn(record, nextCursor) && isNonEmptyString(record[nextCursor]);
    return !hasOwn(record, nextCursor);
  });
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(value, key);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isFeedVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
