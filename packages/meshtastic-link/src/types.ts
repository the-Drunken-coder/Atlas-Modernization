import type {
  ChangedSinceResponse,
  CommandCatalog,
  EntityCheckInResponse,
  EntityResource,
  FullDatasetResponse,
  JSONValue,
  ObjectDetailResource,
  ObjectResource,
  PluginDiscoveryResponse,
  ResourceType,
  RuntimeTaskDeliveryResponse,
  SpatialOperationResult,
  TaskAcknowledgeRequest,
  TaskCancelRequest,
  TaskCompleteRequest,
  TaskFailRequest,
  TaskProgressRequest,
  TaskResource,
  TaskStartRequest
} from "@the-drunken-coder/atlas-sdk";
import type {
  AtlasRadioMutationOperation,
  AtlasRadioOperationName,
  AtlasRadioRequestOperation
} from "./generated/radio-contract.generated.js";

export type LinkRole = "asset" | "gateway";

export type LinkNode = {
  role: LinkRole;
  id: string;
};

export type DeliveryClass = "best_effort" | "confirmed";

export type MessagePriority = "safety" | "task" | "request" | "live_state" | "resource" | "object_content";

export type PublicationPath = "field" | "gateway_feed";
export type ConfirmationState = "not_required" | "awaiting_core" | "core_confirmed" | "core_rejected";

export type PublishedResource =
  | { resource_type: "entity"; resource: EntityResource }
  | { resource_type: "task"; resource: TaskResource }
  | { resource_type: "object"; resource: ObjectResource };

type PublicationContext = {
  type: "state";
  observation_time: string;
  path: PublicationPath;
  confirmation: ConfirmationState;
  operation_id?: string;
  runtime_id?: string;
};

export type ResourceStatePublication = PublicationContext &
  PublishedResource & { deleted?: false; atlas_version?: never; resource_id?: never };

export type DeletedStatePublication = PublicationContext & {
  resource_type: "entity" | "object";
  resource_id: string;
  resource?: never;
  deleted: true;
  atlas_version: number;
};

export type StatePublication = ResourceStatePublication | DeletedStatePublication;

export type TaskDelivery = {
  type: "task_delivery";
  delivery: "assignment" | "cancellation";
  task: TaskResource;
};

export type TaskReportBody =
  | { action: "acknowledge"; body: TaskAcknowledgeRequest }
  | { action: "start"; body: TaskStartRequest }
  | { action: "progress"; body: TaskProgressRequest }
  | { action: "complete"; body: TaskCompleteRequest }
  | { action: "fail"; body: TaskFailRequest }
  | { action: "cancel"; body: TaskCancelRequest };

export type TaskReport = TaskReportBody & {
  type: "task_report";
  task_id: string;
  runtime_id: string;
  observation_time: string;
};

export type FeedSelector =
  | { kind: "record"; resource_type: ResourceType; id: string }
  | { kind: "resource_type"; resource_type: ResourceType }
  | { kind: "tasks_for_asset"; asset_id: string };

export type DataRequest = {
  type: "data_request";
  request_id: string;
  operation: AtlasRadioRequestOperation;
  target_id?: string;
  runtime_id?: string;
  plugin_id?: string;
  plugin_operation_id?: string;
  since_version?: number;
  input?: JSONValue;
  cursor?: string;
  limit?: number;
  entity_cursor?: string;
  task_cursor?: string;
  object_cursor?: string;
  entity_limit?: number;
  task_limit?: number;
  object_limit?: number;
};

export type DataResponse = {
  type: "data_response";
  request_id: string;
  operation: AtlasRadioOperationName;
  output?: AtlasRadioOutput;
  next_cursor?: string;
};

export type ResourceOperation = {
  type: "resource_operation";
  operation: AtlasRadioMutationOperation;
  input?: JSONValue;
  target_id?: string;
  runtime_id?: string;
  idempotency_key?: string;
  if_match_version?: number;
  plugin_id?: string;
  plugin_operation_id?: string;
  fields?: "full" | "minimal";
};

export type SubscriptionOperation = {
  type: "subscription";
  action: "add" | "renew" | "remove";
  selector: FeedSelector;
};

export type ObjectContent = {
  type: "object_content";
  request_id: string;
  object_id: string;
  content_base64: string;
  sha256: string;
};

export type ControlMessage =
  | {
      type: "control";
      control: "confirmed" | "rejected" | "missing_chunks";
      operation_id: string;
      message_id?: string;
      missing_chunks?: number[];
      reason?: string;
    }
  | {
      type: "control";
      control: "source_active";
      operation_id: string;
      active_source: LinkNode;
      active_generation: number;
      active_session: string;
    };

export type LinkMessage =
  | StatePublication
  | TaskDelivery
  | TaskReport
  | DataRequest
  | DataResponse
  | ResourceOperation
  | SubscriptionOperation
  | ObjectContent
  | ControlMessage;

export type LinkMessageType = LinkMessage["type"];

export type LinkOperationStatus = "queued" | "sent" | "confirmed" | "responded" | "rejected" | "failed";

export type LinkOperationResult = {
  operation_id: string;
  status: LinkOperationStatus;
  reason?: string;
  output?: AtlasRadioOutput;
  next_cursor?: string;
  completed_at?: number;
};

export type LinkTimingMetric = {
  samples: number;
  total_ms: number;
  maximum_ms: number;
};

export type AtlasRadioOutput =
  | JSONValue
  | EntityCheckInResponse
  | EntityResource
  | TaskResource
  | ObjectDetailResource
  | ChangedSinceResponse
  | FullDatasetResponse
  | CommandCatalog
  | PluginDiscoveryResponse
  | RuntimeTaskDeliveryResponse
  | SpatialOperationResult;

export type LinkMetrics = {
  application_bytes: number;
  packets_sent: number;
  transmitted_bytes: number;
  packets_received: number;
  duplicate_packets_suppressed: number;
  stale_messages_rejected: number;
  picture_rejected_capacity: number;
  incomplete_reassemblies: number;
  best_effort_replaced: number;
  confirmed_rejected_overload: number;
  retry_exhausted: number;
  retransmitted_packets: number;
  fragment_repair_requests_sent: number;
  fragment_repair_requests_received: number;
  radio_send_failures: number;
  inbound_settlement_expired: number;
  peak_queue_depth: number;
  packets_sent_by_message_type: Record<LinkMessageType, number>;
  transmitted_bytes_by_priority: Record<MessagePriority, number>;
  queue_wait_ms_by_priority: Record<MessagePriority, LinkTimingMetric>;
  operation_latency_ms_by_priority: Record<MessagePriority, LinkTimingMetric>;
  operation_outcomes: Record<"sent" | "confirmed" | "responded" | "rejected" | "failed", number>;
};
