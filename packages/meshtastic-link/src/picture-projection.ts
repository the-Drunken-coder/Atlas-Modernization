import {
  type ChangedSinceResponse,
  type EntityResource,
  isChangedSinceResponse,
  isEntityCheckInResponse,
  isEntityResource,
  isFullDatasetResponse,
  isObjectDetailResource,
  isRuntimeTaskDeliveryResponse,
  isTaskResource,
  type ObjectDetailResource,
  type ObjectResource,
  type TaskResource
} from "@the-drunken-coder/atlas-sdk";
import type { FrameIdentity } from "./frame.js";
import type { SharedPicture } from "./picture.js";
import type {
  ConfirmationState,
  DataResponse,
  LinkMessage,
  PublicationPath,
  StatePublication,
  TaskDelivery,
  TaskReport
} from "./types.js";

/** Converts delivered Atlas messages into picture publications, preserving their source authority. */
export function messagePublications(
  message: LinkMessage,
  identity: FrameIdentity,
  picture: SharedPicture,
  receivedAt: number
): StatePublication[] {
  if (message.type === "state") return [message];
  if (message.type === "task_delivery") return [taskDeliveryPublication(message)];
  if (message.type === "task_report") {
    const publication = taskReportPublication(message, picture, identity);
    return publication ? [publication] : [];
  }
  if (message.type !== "data_response") return [];
  const publications = responsePublications(
    message,
    new Date(receivedAt).toISOString(),
    identity.source.role === "gateway"
      ? { path: "gateway_feed", confirmation: "core_confirmed" }
      : { path: "field", confirmation: "not_required" }
  );
  return identity.source.role === "asset"
    ? publications.filter((publication) => publication.resource_type !== "task")
    : publications;
}

function taskDeliveryPublication(message: TaskDelivery): StatePublication {
  return {
    type: "state",
    resource_type: "task",
    resource: message.task,
    observation_time: message.task.updated_at,
    path: "gateway_feed",
    confirmation: "core_confirmed"
  };
}

type ResponseProvenance = {
  path: PublicationPath;
  confirmation: ConfirmationState;
};

function collapseChangedSinceEvents(events: ChangedSinceResponse["events"]): ChangedSinceResponse["events"] {
  const latest = new Map<string, ChangedSinceResponse["events"][number]>();
  for (const event of events) {
    const key = `${event.resource_type}:${event.id}`;
    const current = latest.get(key);
    if (current === undefined || event.version >= current.version) latest.set(key, event);
  }
  return [...latest.values()];
}

function responsePublications(
  response: DataResponse,
  observedAt: string,
  provenance: ResponseProvenance
): StatePublication[] {
  const { operation, output, request_id: operationID } = response;
  switch (operation) {
    case "entity.get":
    case "entity.create":
    case "entity.update":
      return isEntityResource(output) ? [entityPublication(output, operationID, provenance)] : [];
    case "entity.check_in":
      return isEntityCheckInResponse(output) ? [entityPublication(output.entity, operationID, provenance)] : [];
    case "task.get":
    case "task.create":
    case "task.acknowledge":
    case "task.start":
    case "task.progress":
    case "task.complete":
    case "task.fail":
    case "task.cancel":
      return isTaskResource(output) ? [taskPublication(output, operationID, provenance)] : [];
    case "runtime.tasks":
      return isRuntimeTaskDeliveryResponse(output)
        ? output.tasks.map((task) => taskPublication(task, operationID, provenance))
        : [];
    case "object.get":
    case "object.create":
    case "object.update":
      return isObjectDetailResource(output) ? [objectPublication(objectSummary(output), operationID, provenance)] : [];
    case "query.full":
      return isFullDatasetResponse(output)
        ? [
            ...output.entities.map((entity) => entityPublication(entity, operationID, provenance)),
            ...output.tasks.map((task) => taskPublication(task, operationID, provenance)),
            ...output.objects.map((object) => objectPublication(objectSummary(object), operationID, provenance))
          ]
        : [];
    case "query.changed_since":
      return isChangedSinceResponse(output)
        ? collapseChangedSinceEvents(output.events).flatMap((event) => {
            if (event.event !== "delete") {
              switch (event.resource_type) {
                case "entity":
                  return [entityPublication(event.resource, operationID, provenance)];
                case "task":
                  return [taskPublication(event.resource, operationID, provenance)];
                case "object":
                  return [objectPublication(event.resource, operationID, provenance)];
              }
            }
            return [
              deletedPublication(event.resource_type, event.id, event.version, operationID, observedAt, provenance)
            ];
          })
        : [];
    case "object.content":
    case "entity.delete":
    case "runtime.begin":
    case "runtime.stop":
    case "runtime.ready":
    case "object.delete":
    case "command_catalog.get":
    case "plugin.list":
    case "plugin.invoke":
    case "plugin.invoke_spatial":
      return [];
  }
}

function entityPublication(
  resource: EntityResource,
  operationID: string,
  provenance: ResponseProvenance
): StatePublication {
  return {
    type: "state",
    resource_type: "entity",
    resource,
    observation_time: resource.metadata.updated_at,
    ...provenance,
    operation_id: operationID
  };
}

function taskPublication(
  resource: TaskResource,
  operationID: string,
  provenance: ResponseProvenance
): StatePublication {
  return {
    type: "state",
    resource_type: "task",
    resource,
    observation_time: resource.updated_at,
    ...provenance,
    operation_id: operationID
  };
}

function objectPublication(
  resource: ObjectResource,
  operationID: string,
  provenance: ResponseProvenance
): StatePublication {
  return {
    type: "state",
    resource_type: "object",
    resource,
    observation_time: resource.metadata.updated_at,
    ...provenance,
    operation_id: operationID
  };
}

function deletedPublication(
  resourceType: "entity" | "object",
  resourceIDValue: string,
  atlasVersion: number,
  operationID: string,
  observedAt: string,
  provenance: ResponseProvenance
): StatePublication {
  return {
    type: "state",
    resource_type: resourceType,
    resource_id: resourceIDValue,
    deleted: true,
    atlas_version: atlasVersion,
    observation_time: observedAt,
    ...provenance,
    operation_id: operationID
  };
}

function objectSummary(resource: ObjectDetailResource): ObjectResource {
  return {
    object_id: resource.object_id,
    type: resource.type,
    content_type: resource.content_type,
    size_bytes: resource.size_bytes,
    bucket: resource.bucket,
    path: resource.path,
    usage_hints: resource.usage_hints,
    ...(resource.referenced_by === undefined ? {} : { referenced_by: resource.referenced_by }),
    metadata: resource.metadata
  };
}

function taskReportPublication(
  message: TaskReport,
  picture: SharedPicture,
  identity: FrameIdentity
): StatePublication | undefined {
  const current = picture
    .snapshot()
    .records.find((record) => record.resource_type === "task" && record.id === message.task_id)?.state as
    | TaskResource
    | undefined;
  if (
    !current ||
    identity.source.role !== "asset" ||
    current.asset_id !== identity.source.id ||
    current.status === "completed" ||
    current.status === "failed" ||
    current.status === "cancelled"
  ) {
    return undefined;
  }
  const observedAt = message.observation_time;
  const acknowledgedAt = current.acknowledged_at ?? observedAt;
  const startedAt = current.started_at ?? observedAt;
  const common = {
    asset_id: current.asset_id,
    command: current.command,
    created_at: current.created_at,
    input: current.input,
    task_id: current.task_id,
    updated_at: observedAt
  };
  let task: TaskResource;
  switch (message.action) {
    case "acknowledge":
      task = { ...common, acknowledged_at: acknowledgedAt, status: "acknowledged" };
      break;
    case "start":
      task = { ...common, acknowledged_at: acknowledgedAt, started_at: startedAt, status: "in_progress" };
      break;
    case "progress":
      task = {
        ...common,
        acknowledged_at: acknowledgedAt,
        started_at: startedAt,
        status: "in_progress",
        progress: message.body.progress
      };
      break;
    case "complete":
      task = {
        ...common,
        acknowledged_at: acknowledgedAt,
        started_at: startedAt,
        finished_at: observedAt,
        status: "completed",
        progress: 1,
        ...(message.body.output === undefined ? {} : { output: message.body.output })
      };
      break;
    case "fail":
      task = {
        ...common,
        ...(current.acknowledged_at === undefined ? {} : { acknowledged_at: current.acknowledged_at }),
        ...(current.started_at === undefined ? {} : { started_at: current.started_at }),
        finished_at: observedAt,
        status: "failed",
        failure: message.body.failure
      };
      break;
    case "cancel":
      task = {
        ...common,
        ...(current.acknowledged_at === undefined ? {} : { acknowledged_at: current.acknowledged_at }),
        ...(current.started_at === undefined ? {} : { started_at: current.started_at }),
        finished_at: observedAt,
        status: "cancelled",
        cancellation: message.body.cancellation
      };
      break;
  }
  return {
    type: "state",
    resource_type: "task",
    resource: task,
    observation_time: observedAt,
    path: "field",
    confirmation: "awaiting_core",
    operation_id: identity.operation_id,
    runtime_id: message.runtime_id
  };
}
