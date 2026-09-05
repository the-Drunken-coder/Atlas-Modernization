import { createHash } from "node:crypto";
import {
  isChangedSinceResponse,
  isCommandCatalog,
  isEntityCheckInRequest,
  isEntityCheckInResponse,
  isEntityCreateRequest,
  isEntityResource,
  isEntityUpdateRequest,
  isFullDatasetResponse,
  isJSONValue,
  isMapArea,
  isObjectCreateRequest,
  isObjectDetailResource,
  isObjectResource,
  isObjectUpdateRequest,
  isPluginDiscoveryResponse,
  isRuntimeReadyRequest,
  isRuntimeRegistrationRequest,
  isRuntimeStopRequest,
  isRuntimeTaskDeliveryResponse,
  isSpatialOperationResult,
  isTaskAcknowledgeRequest,
  isTaskCancelRequest,
  isTaskCompleteRequest,
  isTaskCreateRequest,
  isTaskFailRequest,
  isTaskProgressRequest,
  isTaskResource,
  isTaskStartRequest
} from "@the-drunken-coder/atlas-sdk";
import { decodeJSON, encodeCanonicalJSON } from "./canonical-json.js";
import {
  ATLAS_RADIO_OPERATIONS,
  type AtlasRadioOperationName,
  RADIO_CONTRACT_REVISION
} from "./generated/radio-contract.generated.js";
import type {
  ControlMessage,
  DataRequest,
  DataResponse,
  FeedSelector,
  LinkMessage,
  LinkMessageType,
  LinkNode,
  MessagePriority,
  ObjectContent,
  ResourceOperation,
  StatePublication,
  SubscriptionOperation,
  TaskDelivery,
  TaskReport
} from "./types.js";
import { MAX_LINK_FRAGMENTS } from "./types.js";

export type {
  AtlasProtocolDefinitionName,
  AtlasRadioInputByOperation,
  AtlasRadioMutationOperation,
  AtlasRadioOperationName,
  AtlasRadioOutputByOperation,
  AtlasRadioRequestOperation
} from "./generated/radio-contract.generated.js";
export {
  ATLAS_PROTOCOL_DEFINITIONS,
  ATLAS_PROTOCOL_REVISION,
  ATLAS_RADIO_OPERATIONS,
  RADIO_CONTRACT_REVISION
} from "./generated/radio-contract.generated.js";

export const LINK_PROTOCOL_REVISION = 1 as const;
export const MAX_OBJECT_CONTENT_BYTES = 32 * 1024;

export function serializeLinkMessage(message: LinkMessage): Uint8Array {
  if (!isLinkMessage(message)) throw new TypeError("Invalid Atlas Radio contract message");
  return encodeCanonicalJSON({ r: RADIO_CONTRACT_REVISION, message });
}

export function deserializeLinkMessage(bytes: Uint8Array): LinkMessage {
  const value = decodeJSON(bytes);
  if (!isRecord(value) || value.r !== RADIO_CONTRACT_REVISION || !isLinkMessage(value.message)) {
    throw new TypeError("Invalid or incompatible Atlas Radio contract message");
  }
  return value.message;
}

export function messagePriority(message: LinkMessage): MessagePriority {
  if (message.type === "control") return "safety";
  if (message.type === "task_delivery") return message.delivery === "cancellation" ? "safety" : "task";
  if (message.type === "task_report") return message.action === "cancel" ? "safety" : "task";
  if (message.type === "data_request" || message.type === "data_response" || message.type === "subscription") {
    return "request";
  }
  if (message.type === "object_content") return "object_content";
  if (message.type === "resource_operation") {
    if (message.operation === "task.cancel") return "safety";
    return message.operation.startsWith("task.") ? "task" : "resource";
  }
  if (
    message.deleted !== true &&
    message.resource_type === "entity" &&
    ["asset", "track"].includes(message.resource.entity_type)
  ) {
    return "live_state";
  }
  return message.resource_type === "task" ? "task" : "resource";
}

export function deliveryClass(message: LinkMessage): "best_effort" | "confirmed" {
  return message.type === "state" || message.type === "control" ? "best_effort" : "confirmed";
}

export function coalescingKey(message: LinkMessage): string | undefined {
  if (message.type !== "state") return undefined;
  return `${message.resource_type}:${resourceID(message)}`;
}

export function resourceID(message: StatePublication): string {
  if (message.deleted === true) return message.resource_id;
  if (message.resource_type === "entity") return message.resource.entity_id;
  if (message.resource_type === "task") return message.resource.task_id;
  return message.resource.object_id;
}

export function isLinkMessage(value: unknown): value is LinkMessage {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  const validators: Record<LinkMessageType, (candidate: Record<string, unknown>) => boolean> = {
    state: isStatePublication,
    task_delivery: isTaskDelivery,
    task_report: isTaskReport,
    data_request: isDataRequest,
    data_response: isDataResponse,
    resource_operation: isResourceOperation,
    subscription: isSubscriptionOperation,
    object_content: isObjectContent,
    control: isControlMessage
  };
  return Object.hasOwn(validators, value.type) && validators[value.type as LinkMessageType](value);
}

function isStatePublication(value: Record<string, unknown>): value is StatePublication {
  if (
    !isRFC3339(value.observation_time) ||
    !isOneOf(value.path, ["field", "gateway_feed"]) ||
    !isOneOf(value.confirmation, ["not_required", "awaiting_core", "core_confirmed", "core_rejected"]) ||
    !optionalString(value.operation_id) ||
    !optionalString(value.runtime_id) ||
    !optionalBoolean(value.deleted) ||
    !optionalNonNegativeInteger(value.atlas_version)
  ) {
    return false;
  }
  if (value.path === "field" && value.confirmation === "awaiting_core" && !isNonEmptyString(value.operation_id)) {
    return false;
  }
  if (value.deleted === true) {
    return (
      (value.resource_type === "entity" || value.resource_type === "object") &&
      isNonEmptyString(value.resource_id) &&
      value.resource === undefined &&
      isNonNegativeInteger(value.atlas_version)
    );
  }
  if (value.resource_id !== undefined || value.atlas_version !== undefined) return false;
  if (value.resource_type === "entity") return isEntityResource(value.resource);
  if (value.resource_type === "task") {
    return value.deleted !== true && value.atlas_version === undefined && isTaskResource(value.resource);
  }
  if (value.resource_type === "object") return isObjectResource(value.resource);
  return false;
}

function isTaskDelivery(value: Record<string, unknown>): value is TaskDelivery {
  return isOneOf(value.delivery, ["assignment", "cancellation"]) && isTaskResource(value.task);
}

function isTaskReport(value: Record<string, unknown>): value is TaskReport {
  if (
    !isNonEmptyString(value.task_id) ||
    !isNonEmptyString(value.runtime_id) ||
    !isRFC3339(value.observation_time) ||
    !isRecord(value.body)
  ) {
    return false;
  }
  switch (value.action) {
    case "acknowledge":
      return isTaskAcknowledgeRequest(value.body);
    case "start":
      return isTaskStartRequest(value.body);
    case "progress":
      return isTaskProgressRequest(value.body);
    case "complete":
      return isTaskCompleteRequest(value.body);
    case "fail":
      return isTaskFailRequest(value.body);
    case "cancel":
      return isTaskCancelRequest(value.body);
    default:
      return false;
  }
}

function isDataRequest(value: Record<string, unknown>): value is DataRequest {
  return (
    isNonEmptyString(value.request_id) &&
    typeof value.operation === "string" &&
    isRequestOperation(value.operation) &&
    optionalString(value.target_id) &&
    optionalString(value.runtime_id) &&
    optionalString(value.plugin_id) &&
    optionalString(value.plugin_operation_id) &&
    optionalNonNegativeInteger(value.since_version) &&
    optionalJSON(value.input) &&
    optionalString(value.cursor) &&
    (value.limit === undefined || (Number.isSafeInteger(value.limit) && Number(value.limit) > 0)) &&
    optionalString(value.entity_cursor) &&
    optionalString(value.task_cursor) &&
    optionalString(value.object_cursor) &&
    optionalPositiveInteger(value.entity_limit) &&
    optionalPositiveInteger(value.task_limit) &&
    optionalPositiveInteger(value.object_limit) &&
    validOperationContext(value.operation, value) &&
    validOperationInput(value.operation, value.input)
  );
}

function isDataResponse(value: Record<string, unknown>): value is DataResponse {
  return (
    isNonEmptyString(value.request_id) &&
    typeof value.operation === "string" &&
    isOperation(value.operation) &&
    optionalString(value.next_cursor) &&
    validOperationOutput(value.operation, value.output)
  );
}

function isResourceOperation(value: Record<string, unknown>): value is ResourceOperation {
  return (
    typeof value.operation === "string" &&
    isMutationOperation(value.operation) &&
    optionalJSON(value.input) &&
    optionalString(value.target_id) &&
    optionalString(value.runtime_id) &&
    optionalString(value.idempotency_key) &&
    optionalNonNegativeInteger(value.if_match_version) &&
    optionalString(value.plugin_id) &&
    optionalString(value.plugin_operation_id) &&
    (value.fields === undefined || value.fields === "full" || value.fields === "minimal") &&
    validOperationContext(value.operation, value) &&
    validOperationInput(value.operation, value.input)
  );
}

function isSubscriptionOperation(value: Record<string, unknown>): value is SubscriptionOperation {
  return isOneOf(value.action, ["add", "renew", "remove"]) && isFeedSelector(value.selector);
}

export function isFeedSelector(value: unknown): value is FeedSelector {
  if (!isRecord(value)) return false;
  if (value.kind === "record") {
    return isResourceType(value.resource_type) && isNonEmptyString(value.id);
  }
  if (value.kind === "resource_type") return isResourceType(value.resource_type);
  return value.kind === "tasks_for_asset" && isNonEmptyString(value.asset_id);
}

function isObjectContent(value: Record<string, unknown>): value is ObjectContent {
  if (
    !isNonEmptyString(value.object_id) ||
    !isNonEmptyString(value.request_id) ||
    typeof value.content_base64 !== "string" ||
    !isSha256(value.sha256)
  ) {
    return false;
  }
  try {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.content_base64)) {
      return false;
    }
    const content = Buffer.from(value.content_base64, "base64");
    return (
      content.byteLength <= MAX_OBJECT_CONTENT_BYTES &&
      `sha256:${createHash("sha256").update(content).digest("hex")}` === value.sha256
    );
  } catch {
    return false;
  }
}

function isRequestOperation(value: string): value is AtlasRadioOperationName {
  return isOperation(value) && ATLAS_RADIO_OPERATIONS[value].kind === "request";
}

function isMutationOperation(value: string): value is AtlasRadioOperationName {
  return isOperation(value) && ATLAS_RADIO_OPERATIONS[value].kind === "mutation";
}

function isOperation(value: string): value is AtlasRadioOperationName {
  return Object.hasOwn(ATLAS_RADIO_OPERATIONS, value);
}

function validOperationContext(operation: AtlasRadioOperationName, value: Record<string, unknown>): boolean {
  switch (operation) {
    case "task.acknowledge":
    case "task.start":
    case "task.progress":
    case "task.complete":
    case "task.fail":
    case "runtime.tasks":
      return isNonEmptyString(value.target_id) && isNonEmptyString(value.runtime_id);
    case "entity.get":
    case "entity.update":
    case "entity.delete":
    case "entity.check_in":
    case "task.get":
    case "task.cancel":
    case "runtime.begin":
    case "runtime.stop":
    case "runtime.ready":
    case "object.get":
    case "object.update":
    case "object.delete":
    case "object.content":
      return isNonEmptyString(value.target_id);
    case "task.create":
      return isNonEmptyString(value.idempotency_key);
    case "query.changed_since":
      return isNonNegativeInteger(value.since_version);
    case "plugin.invoke":
    case "plugin.invoke_spatial":
      return isNonEmptyString(value.plugin_id) && isNonEmptyString(value.plugin_operation_id);
    case "entity.create":
    case "object.create":
    case "query.full":
    case "command_catalog.get":
    case "plugin.list":
      return true;
  }
  return assertNever(operation);
}

function validOperationInput(operation: AtlasRadioOperationName, input: unknown): boolean {
  switch (operation) {
    case "entity.create":
      return isEntityCreateRequest(input);
    case "entity.update":
      return isEntityUpdateRequest(input);
    case "entity.check_in":
      return isEntityCheckInRequest(input);
    case "task.create":
      return isTaskCreateRequest(input);
    case "task.acknowledge":
      return isTaskAcknowledgeRequest(input);
    case "task.start":
      return isTaskStartRequest(input);
    case "task.progress":
      return isTaskProgressRequest(input);
    case "task.complete":
      return isTaskCompleteRequest(input);
    case "task.fail":
      return isTaskFailRequest(input);
    case "task.cancel":
      return isTaskCancelRequest(input);
    case "runtime.begin":
      return isRuntimeRegistrationRequest(input);
    case "runtime.stop":
      return isRuntimeStopRequest(input);
    case "runtime.ready":
      return isRuntimeReadyRequest(input);
    case "object.create":
      return isObjectCreateRequest(input);
    case "object.update":
      return isObjectUpdateRequest(input);
    case "plugin.invoke":
      return isJSONValue(input);
    case "plugin.invoke_spatial":
      return isMapArea(input);
    case "entity.get":
    case "entity.delete":
    case "task.get":
    case "runtime.tasks":
    case "object.get":
    case "object.delete":
    case "object.content":
    case "query.full":
    case "query.changed_since":
    case "command_catalog.get":
    case "plugin.list":
      return input === undefined;
  }
  return assertNever(operation);
}

function validOperationOutput(operation: AtlasRadioOperationName, output: unknown): boolean {
  switch (operation) {
    case "entity.get":
    case "entity.create":
    case "entity.update":
      return isEntityResource(output);
    case "entity.check_in":
      return isEntityCheckInResponse(output);
    case "task.get":
    case "task.create":
    case "task.acknowledge":
    case "task.start":
    case "task.progress":
    case "task.complete":
    case "task.fail":
    case "task.cancel":
      return isTaskResource(output);
    case "runtime.tasks":
      return isRuntimeTaskDeliveryResponse(output);
    case "object.get":
    case "object.create":
    case "object.update":
      return isObjectDetailResource(output);
    case "query.full":
      return isFullDatasetResponse(output);
    case "query.changed_since":
      return isChangedSinceResponse(output);
    case "command_catalog.get":
      return isCommandCatalog(output);
    case "plugin.list":
      return isPluginDiscoveryResponse(output);
    case "plugin.invoke":
      return isJSONValue(output);
    case "plugin.invoke_spatial":
      return isSpatialOperationResult(output);
    case "entity.delete":
    case "runtime.begin":
    case "runtime.stop":
    case "runtime.ready":
    case "object.delete":
    case "object.content":
      return output === undefined;
  }
  return assertNever(operation);
}

function isControlMessage(value: Record<string, unknown>): value is ControlMessage {
  if (value.control === "source_active") {
    return (
      isNonEmptyString(value.operation_id) &&
      isLinkNode(value.active_source) &&
      Number.isSafeInteger(value.active_generation) &&
      Number(value.active_generation) > 0 &&
      isNonEmptyString(value.active_session)
    );
  }
  return (
    isOneOf(value.control, ["confirmed", "rejected", "missing_chunks"]) &&
    isNonEmptyString(value.operation_id) &&
    isNonEmptyString(value.message_id) &&
    optionalString(value.reason) &&
    (value.control !== "missing_chunks"
      ? value.missing_chunks === undefined
      : Array.isArray(value.missing_chunks) &&
        value.missing_chunks.length <= MAX_LINK_FRAGMENTS &&
        new Set(value.missing_chunks).size === value.missing_chunks.length &&
        value.missing_chunks.every((item) => Number.isSafeInteger(item) && item >= 0 && item < MAX_LINK_FRAGMENTS))
  );
}

function isLinkNode(value: unknown): value is LinkNode {
  return (
    isRecord(value) &&
    (value.role === "asset" || value.role === "gateway") &&
    isNonEmptyString(value.id) &&
    !value.id.includes(":")
  );
}

function optionalJSON(value: unknown): boolean {
  return value === undefined || isJSONValue(value);
}

function optionalString(value: unknown): boolean {
  return value === undefined || isNonEmptyString(value);
}

function optionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === "boolean";
}

function optionalNonNegativeInteger(value: unknown): boolean {
  return value === undefined || isNonNegativeInteger(value);
}

function optionalPositiveInteger(value: unknown): boolean {
  return value === undefined || (Number.isSafeInteger(value) && Number(value) > 0);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isResourceType(value: unknown): boolean {
  return value === "entity" || value === "task" || value === "object";
}

function isRFC3339(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;
  const zone = match[7];
  if (zone !== "Z" && (Number(zone?.slice(1, 3)) > 23 || Number(zone?.slice(4, 6)) > 59)) return false;
  return true;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
}

function isOneOf<const Value extends string>(value: unknown, allowed: readonly Value[]): value is Value {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

function assertNever(value: never): never {
  throw new TypeError(`unhandled Atlas Radio operation: ${String(value)}`);
}

function isSha256(value: unknown): boolean {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
