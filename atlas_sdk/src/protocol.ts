import type { JSONValue, ObjectResource } from "../../atlas_protocol/generated/typescript/index.js";

export {
  ATLAS_PROTOCOL_REVISION,
  isEntityCreateRequest,
  isEntityUpdateRequest,
  isObjectCreateRequest,
  isObjectUpdateRequest,
  isTaskCreateRequest,
  isTaskUpdateRequest
} from "../../atlas_protocol/generated/typescript/index.js";

export type ObjectResponse = ObjectResource & {
  "payload"?: { [key: string]: JSONValue };
};

export type {
  EntityCreateRequest,
  EntityComponents,
  EntityResource,
  EntityUpdateRequest,
  ErrorCode,
  ErrorResponse,
  FeedEvent,
  FeedHandshakeMessage,
  FeedSubscribeMessage,
  FeedUnsubscribeMessage,
  JSONValue,
  ObjectCreateRequest,
  ObjectResource,
  ObjectUpdateRequest,
  ResourceType,
  TaskDeleteEvent,
  TaskCreateRequest,
  TaskUpdateRequest,
  TaskResource
} from "../../atlas_protocol/generated/typescript/index.js";
