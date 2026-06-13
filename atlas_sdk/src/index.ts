export {
  AtlasClient,
  ConflictError,
  ProtocolMismatchError,
  type AtlasLocalDeleteWatchEvent,
  type AtlasRecoveredWatchEvent,
  type AtlasWatchEvent,
  type AtlasClientOptions,
  type AtlasSubscription,
  type ReadOptions,
  type SyncStatus,
  type TaskCreateRequest
} from "./client.js";
export { ATLAS_PROTOCOL_REVISION } from "./protocol.js";
export type {
  EntityResource,
  FeedEvent,
  ObjectResource,
  ResourceType,
  TaskResource
} from "./protocol.js";
