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
  isMovementTrail,
  type MovementHistoryBatchResponse,
  type MovementHistoryPage,
  type MovementInspection,
  type MovementSample,
  type MovementTrail,
  type ObjectDetailResource,
  type ObjectResource,
  type ProtocolRevisionResponse,
  type RuntimeTaskDeliveryResponse,
  type TaskResource
} from "./protocol.js";
import type { EntityCheckInFields, MovementHistoryQuery, MovementTrailQuery } from "./types.js";

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
export function compareMovementInstants(left: string, right: string, rightOffsetMilliseconds = 0): number {
  const milliseconds = movementMilliseconds(left) - movementMilliseconds(right) - rightOffsetMilliseconds;
  if (milliseconds !== 0) return milliseconds;
  const fraction = (value: string) => (/\.(\d+)/.exec(value)?.[1] ?? "").slice(0, 9).padEnd(9, "0");
  const a = fraction(left);
  const b = fraction(right);
  return a === b ? 0 : a < b ? -1 : 1;
}

// Match Core's normalization for the Protocol's accepted leap-second notation.
function movementMilliseconds(value: string): number {
  const leap = value.slice(17, 19) === "60";
  return Date.parse(leap ? `${value.slice(0, 17)}59${value.slice(19)}` : value) + (leap ? 1000 : 0);
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
        coherentMovementSample(sample) &&
        compareMovementInstants(sample.time, query.from) >= 0 &&
        compareMovementInstants(sample.time, query.to) <= 0 &&
        (index === 0 || compareMovementInstants(samples[index - 1]!.time, sample.time) >= 0)
    );
}

function coherentMovementSample(sample: MovementSample): boolean {
  return (
    sample.time_is_arrival === (sample.observed_at === undefined) &&
    sameMovementInstant(sample.time, sample.observed_at ?? sample.received_at)
  );
}

export function movementTrailResponseValidator(query: MovementTrailQuery): ResponseValidator<MovementTrail> {
  const validate = movementWindowResponseValidator(isMovementTrail, query);
  return (value): value is MovementTrail =>
    validate(value) &&
    isSafeNonNegativeInteger(value.position_count) &&
    value.position_count >= value.points.length &&
    (value.position_count === 0) === (value.points.length === 0) &&
    value.points.length <= (query.maxPoints ?? 1000) &&
    value.simplified === value.points.length < value.position_count &&
    value.points.every(
      ({ sample, gap_before }, index, points) =>
        coherentMovementSample(sample) &&
        sample.latitude !== undefined &&
        sample.longitude !== undefined &&
        compareMovementInstants(sample.time, query.from) >= 0 &&
        compareMovementInstants(sample.time, query.to) <= 0 &&
        (index === 0 || compareMovementInstants(points[index - 1]!.sample.time, sample.time) <= 0) &&
        (!gap_before || (index > 0 && compareMovementInstants(sample.time, points[index - 1]!.sample.time, 60_000) > 0))
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
    sameMovementInstant(value.time, at) &&
    (value.position === undefined ||
      (value.position.latitude !== undefined && value.position.longitude !== undefined)) &&
    (value.speed === undefined || value.speed.speed_m_s !== undefined) &&
    (value.altitude === undefined || value.altitude.altitude_m !== undefined) &&
    [value.position, value.speed, value.altitude].every(
      (sample) =>
        sample === undefined || (coherentMovementSample(sample) && compareMovementInstants(sample.time, at) <= 0)
    );
}
