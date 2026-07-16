import type { ResponseValidator } from "./http.js";
import {
  type EntityResource,
  type FeedEvent,
  type FeedHandshakeMessage,
  isFeedHandshakeMessage,
  isEntityResource as isGeneratedEntityResource,
  isFeedEvent as isGeneratedFeedEvent,
  isObjectDetailResource as isGeneratedObjectDetailResource,
  isObjectResource as isGeneratedObjectResource,
  isTaskResource as isGeneratedTaskResource,
  isJSONValue,
  isProtocolRevision,
  isResourceType,
  isRFC3339Timestamp,
  type ObjectDetailResource,
  type ObjectResource,
  type ResourceType,
  type TaskResource
} from "./protocol.js";
import type {
  ChangedSinceResponse,
  DeletedResource,
  EntityCheckInFields,
  EntityCheckInMinimalTask,
  EntityCheckInResponse,
  FullDatasetResponse
} from "./types.js";

const fullPaginationFields = [
  ["has_more_entities", "next_entity_cursor"],
  ["has_more_tasks", "next_task_cursor"],
  ["has_more_objects", "next_object_cursor"]
] as const;

const changedSincePaginationFields = [
  ...fullPaginationFields,
  ["has_more_deleted_entities", "next_deleted_entity_cursor"],
  ["has_more_deleted_tasks", "next_deleted_task_cursor"],
  ["has_more_deleted_objects", "next_deleted_object_cursor"]
] as const;

export const isProtocolRevisionResponse: ResponseValidator<{ protocol_revision: string }> = (value): value is { protocol_revision: string } =>
  isRecord(value) && Object.keys(value).length === 1 && hasOwn(value, "protocol_revision") && isProtocolRevision(value.protocol_revision);

export const isEntityResource: ResponseValidator<EntityResource> = (value): value is EntityResource =>
  isGeneratedEntityResource(value) && isFeedVersion(value.metadata.version);

export const isTaskResource: ResponseValidator<TaskResource> = (value): value is TaskResource =>
  isGeneratedTaskResource(value) && isFeedVersion(value.metadata.version);

export const isObjectResource: ResponseValidator<ObjectResource> = (value): value is ObjectResource =>
  isGeneratedObjectResource(value) && isFeedVersion(value.metadata.version);

export const isObjectDetailResource: ResponseValidator<ObjectDetailResource> = (value): value is ObjectDetailResource =>
  isGeneratedObjectDetailResource(value) && isFeedVersion(value.metadata.version);

export const isFullDatasetResponse: ResponseValidator<FullDatasetResponse> = (value): value is FullDatasetResponse =>
  isRecord(value) &&
  isArrayOf(value.entities, isEntityResource) &&
  isArrayOf(value.tasks, isTaskResource) &&
  isArrayOf(value.objects, isObjectDetailResource) &&
  isSafeNonNegativeInteger(value.version) &&
  hasValidPagination(value, fullPaginationFields);

export function changedSinceResponseValidator(sinceVersion: number): ResponseValidator<ChangedSinceResponse> {
  return (value): value is ChangedSinceResponse => {
    if (
      !isSafeNonNegativeInteger(sinceVersion) ||
      !isRecord(value) ||
      !isArrayOf(value.entities, isEntityResource) ||
      !isArrayOf(value.tasks, isTaskResource) ||
      !isArrayOf(value.objects, isObjectDetailResource) ||
      !isOptionalArrayOf(value.deleted_entities, (item) => isDeletedResource(item, "entity")) ||
      !isOptionalArrayOf(value.deleted_tasks, (item) => isDeletedResource(item, "task")) ||
      !isOptionalArrayOf(value.deleted_objects, (item) => isDeletedResource(item, "object")) ||
      !isSafeNonNegativeInteger(value.version) ||
      value.version < sinceVersion ||
      (hasOwn(value, "timestamp") && !isRFC3339Timestamp(value.timestamp)) ||
      !hasValidPagination(value, changedSincePaginationFields)
    ) {
      return false;
    }

    const versions = [
      ...value.entities.map((resource) => resource.metadata.version),
      ...value.tasks.map((resource) => resource.metadata.version),
      ...value.objects.map((resource) => resource.metadata.version),
      ...(value.deleted_entities ?? []).map((resource) => resource.version),
      ...(value.deleted_tasks ?? []).map((resource) => resource.version),
      ...(value.deleted_objects ?? []).map((resource) => resource.version)
    ];
    const highWaterVersion = value.version;
    return versions.every((version) => version > sinceVersion && version <= highWaterVersion);
  };
}

export function entityCheckInResponseValidator(expectedEntityID: string, fields: EntityCheckInFields): ResponseValidator<EntityCheckInResponse> {
  return (value): value is EntityCheckInResponse => {
    if (
      !isRecord(value) ||
      !isEntityResource(value.entity) ||
      value.entity.entity_id !== expectedEntityID ||
      !Array.isArray(value.tasks) ||
      !value.tasks.every((task) =>
        fields === "minimal"
          ? isEntityCheckInMinimalTask(task) && (!hasOwn(task, "entity_id") || task.entity_id === expectedEntityID)
          : isTaskResource(task) && task.entity_id === expectedEntityID
      ) ||
      !isSafeNonNegativeInteger(value.task_count) ||
      value.task_count !== value.tasks.length ||
      !isFeedVersion(value.task_limit) ||
      value.tasks.length > value.task_limit ||
      typeof value.has_more_tasks !== "boolean"
    ) {
      return false;
    }
    return value.has_more_tasks ? hasOwn(value, "next_task_cursor") && isNonEmptyString(value.next_task_cursor) : !hasOwn(value, "next_task_cursor");
  };
}

export function isInboundFeedHandshake(value: unknown): value is FeedHandshakeMessage {
  return isFeedHandshakeMessage(value);
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

function isDeletedResource(value: unknown, type: ResourceType): value is DeletedResource {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.id) ||
    !isResourceType(value.type) ||
    value.type !== type ||
    !isFeedVersion(value.version) ||
    (hasOwn(value, "deleted_at") && !isRFC3339Timestamp(value.deleted_at))
  ) {
    return false;
  }
  if (type === "task") {
    return !hasOwn(value, "entity_id") || value.entity_id === null || isNonEmptyString(value.entity_id);
  }
  return !hasOwn(value, "entity_id");
}

function isEntityCheckInMinimalTask(value: unknown): value is EntityCheckInMinimalTask {
  if (!isRecord(value)) return false;
  const knownKeys = new Set(["task_id", "status", "entity_id", "command_id", "parameters"]);
  return (
    Object.keys(value).every((key) => knownKeys.has(key)) &&
    isNonEmptyString(value.task_id) &&
    isNonEmptyString(value.status) &&
    (!hasOwn(value, "entity_id") || isNonEmptyString(value.entity_id)) &&
    (!hasOwn(value, "command_id") || isNonEmptyString(value.command_id)) &&
    (!hasOwn(value, "parameters") || (isRecord(value.parameters) && isJSONValue(value.parameters)))
  );
}

function hasValidPagination(value: Record<string, unknown>, fields: ReadonlyArray<readonly [hasMore: string, nextCursor: string]>): boolean {
  return fields.every(([hasMore, nextCursor]) => {
    if (!hasOwn(value, hasMore) || typeof value[hasMore] !== "boolean") return false;
    if (value[hasMore]) return hasOwn(value, nextCursor) && isNonEmptyString(value[nextCursor]);
    return !hasOwn(value, nextCursor);
  });
}

function isArrayOf<T>(value: unknown, validate: ResponseValidator<T>): value is T[] {
  return Array.isArray(value) && value.every(validate);
}

function isOptionalArrayOf<T>(value: unknown, validate: ResponseValidator<T>): value is T[] | undefined {
  return value === undefined || isArrayOf(value, validate);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
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
