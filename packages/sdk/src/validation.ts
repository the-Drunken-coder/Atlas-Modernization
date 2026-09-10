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
  isRuntimeTaskDeliveryResponse as isGeneratedRuntimeTaskDeliveryResponse,
  isTaskResource as isGeneratedTaskResource,
  isMovementHistoryBatchResponse,
  isMovementHistoryPage,
  isMovementInspection,
  type MovementHistoryBatchResponse,
  type MovementHistoryPage,
  type MovementInspection,
  type ObjectDetailResource,
  type ObjectResource,
  type ProtocolRevisionResponse,
  type RuntimeTaskDeliveryResponse,
  type TaskResource
} from "./protocol.js";
import type { EntityCheckInFields, MovementHistoryQuery } from "./types.js";

export const isCommandCatalog: ResponseValidator<CommandCatalog> = isGeneratedCommandCatalog;

export const isProtocolRevisionResponse: ResponseValidator<ProtocolRevisionResponse> =
  isGeneratedProtocolRevisionResponse;

export const isEntityResource: ResponseValidator<EntityResource> = (value): value is EntityResource =>
  isGeneratedEntityResource(value) && isFeedVersion(value.metadata.version);

export const isTaskResource: ResponseValidator<TaskResource> = (value): value is TaskResource =>
  isGeneratedTaskResource(value);

export const isObjectResource: ResponseValidator<ObjectResource> = (value): value is ObjectResource =>
  isGeneratedObjectResource(value) && isFeedVersion(value.metadata.version);

export const isObjectDetailResource: ResponseValidator<ObjectDetailResource> = (value): value is ObjectDetailResource =>
  isGeneratedObjectDetailResource(value) && isFeedVersion(value.metadata.version);

export const isRuntimeTaskDeliveryResponse: ResponseValidator<RuntimeTaskDeliveryResponse> =
  isGeneratedRuntimeTaskDeliveryResponse;

export const isFullDatasetResponse: ResponseValidator<FullDatasetResponse> = (value): value is FullDatasetResponse =>
  isGeneratedFullDatasetResponse(value) &&
  value.entities.every(isEntityResource) &&
  value.tasks.every(isTaskResource) &&
  value.objects.every(isObjectDetailResource) &&
  isSafeNonNegativeInteger(value.version) &&
  hasValidPagination(value.has_more_entities, value.next_entity_cursor) &&
  hasValidPagination(value.has_more_tasks, value.next_task_cursor) &&
  hasValidPagination(value.has_more_objects, value.next_object_cursor);

export function changedSinceResponseValidator(sinceVersion: number): ResponseValidator<ChangedSinceResponse> {
  return (value): value is ChangedSinceResponse => {
    if (
      !isSafeNonNegativeInteger(sinceVersion) ||
      !isGeneratedChangedSinceResponse(value) ||
      !value.events.every(isInboundFeedEvent) ||
      !isSafeNonNegativeInteger(value.version) ||
      value.version < sinceVersion ||
      !hasValidPagination(value.has_more, value.next_cursor) ||
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
  _fields: EntityCheckInFields
): ResponseValidator<EntityCheckInResponse> {
  return (value): value is EntityCheckInResponse =>
    (isGeneratedEntityCheckInFullResponse(value) || isGeneratedEntityCheckInMinimalResponse(value)) &&
    hasValidEntityCheckInContext(value, expectedEntityID);
}

function hasValidEntityCheckInContext(
  value: EntityCheckInFullResponse | EntityCheckInMinimalResponse,
  expectedEntityID: string
): boolean {
  return isEntityResource(value.entity) && value.entity.entity_id === expectedEntityID;
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
      return value.id === value.resource.task_id;
    case "object":
      return value.id === value.resource.object_id && value.version === value.resource.metadata.version;
  }
}

function hasValidPagination(hasMore: boolean, nextCursor: string | undefined): boolean {
  return hasMore ? isNonEmptyString(nextCursor) : nextCursor === undefined;
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

// Go accepts longer RFC3339 fractions but normalizes them to nanoseconds.
function compareMovementInstants(left: string, right: string): number {
  const milliseconds = Date.parse(left) - Date.parse(right);
  if (milliseconds !== 0) return milliseconds;
  const fraction = (value: string) => (/\.(\d+)/.exec(value)?.[1] ?? "").slice(0, 9).padEnd(9, "0");
  const a = fraction(left);
  const b = fraction(right);
  return a === b ? 0 : a < b ? -1 : 1;
}

function sameMovementInstant(left: string, right: string): boolean {
  return compareMovementInstants(left, right) === 0;
}

export function movementHistoryResponseValidator(query: MovementHistoryQuery): ResponseValidator<MovementHistoryPage> {
  const validate = movementWindowResponseValidator(isMovementHistoryPage, query);
  return (value): value is MovementHistoryPage =>
    validate(value) &&
    value.samples.every(
      (sample, index, samples) =>
        compareMovementInstants(sample.time, query.from) >= 0 &&
        compareMovementInstants(sample.time, query.to) <= 0 &&
        (index === 0 || compareMovementInstants(samples[index - 1]!.time, sample.time) >= 0)
    );
}

export function movementImportResponseValidator(count: number): ResponseValidator<MovementHistoryBatchResponse> {
  return (value): value is MovementHistoryBatchResponse =>
    isMovementHistoryBatchResponse(value) && value.inserted + value.duplicates + value.expired === count;
}

export function movementWindowResponseValidator<T extends { entity_created_at: string; from: string; to: string }>(
  validate: ResponseValidator<T>,
  query: MovementHistoryQuery
): ResponseValidator<T> {
  return (value): value is T =>
    validate(value) &&
    sameMovementInstant(value.entity_created_at, query.entityCreatedAt) &&
    sameMovementInstant(value.from, query.from) &&
    sameMovementInstant(value.to, query.to);
}

export function movementInspectionResponseValidator(
  entityCreatedAt: string,
  at: string
): ResponseValidator<MovementInspection> {
  return (value): value is MovementInspection =>
    isMovementInspection(value) &&
    sameMovementInstant(value.entity_created_at, entityCreatedAt) &&
    sameMovementInstant(value.time, at);
}
