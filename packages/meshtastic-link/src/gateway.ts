import type { TaskResource } from "@the-drunken-coder/atlas-sdk";
import { GatewaySubscriptionDemand, type SubscriptionTransition } from "./subscriptions.js";
import type { TransportMessageEvent } from "./transport.js";
import { LinkTransport, type TransportEvent } from "./transport.js";
import type {
  DataRequest,
  ObjectContent,
  ResourceOperation,
  StatePublication,
  TaskDelivery,
  TaskReport
} from "./types.js";

export type IntentionalFieldMessage = StatePublication | TaskReport | ResourceOperation | DataRequest | ObjectContent;

export type GatewayFieldOperation = {
  operation_id: string;
  source_asset_id: string;
  source_generation: number;
  service_session: string;
  runtime_id?: string;
  message: IntentionalFieldMessage;
};

export class GatewayFieldOperationInbox {
  private readonly seen = new Set<string>();

  constructor(private readonly limit = 4096) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("field operation inbox limit must be positive");
  }

  accept(event: TransportMessageEvent): GatewayFieldOperation | undefined {
    const fieldBroadcast = event.message.type === "state" && event.destination === undefined;
    if (
      (!event.addressed_to_local && !fieldBroadcast) ||
      event.source.role !== "asset" ||
      !isIntentionalFieldMessage(event.message)
    ) {
      return undefined;
    }
    const deduplicationKey = `${event.source.id}:${event.source_generation}:${event.operation_id}`;
    if (this.seen.has(deduplicationKey)) return undefined;
    this.seen.add(deduplicationKey);
    while (this.seen.size > this.limit) {
      const first = this.seen.values().next().value as string | undefined;
      if (!first) break;
      this.seen.delete(first);
    }
    const operationRuntimeID = runtimeID(event.message);
    return {
      operation_id: event.operation_id,
      source_asset_id: event.source.id,
      source_generation: event.source_generation,
      service_session: event.service_session,
      ...(operationRuntimeID === undefined ? {} : { runtime_id: operationRuntimeID }),
      message: event.message
    };
  }
}

export type GatewayFeedTransition = {
  active: boolean;
  selector: SubscriptionTransition["selector"];
};

export class GatewayFeedDemand {
  private readonly demand = new GatewaySubscriptionDemand();

  apply(event: TransportMessageEvent, now: number): GatewayFeedTransition | undefined {
    if (!event.addressed_to_local || event.source.role !== "asset" || event.message.type !== "subscription") {
      return undefined;
    }
    const transition: SubscriptionTransition = {
      action: event.message.action,
      selector: event.message.selector
    };
    const changed = this.demand.apply(event.source.id, transition, now);
    if (!changed) return undefined;
    return { active: event.message.action !== "remove", selector: event.message.selector };
  }

  expire(now: number): GatewayFeedTransition[] {
    return this.demand.expire(now).map((selector) => ({ active: false, selector }));
  }

  active(now: number): readonly SubscriptionTransition["selector"][] {
    return [...this.demand.aggregate(now).values()];
  }
}

type QueuedTask = {
  task: TaskResource;
  delivery: TaskDelivery["delivery"];
};

type InFlightTask = QueuedTask & {
  operationID: string;
};

export class OrderedTaskDispatcher {
  private readonly queued = new Map<string, QueuedTask[]>();
  private readonly inFlight = new Map<string, InFlightTask>();
  private readonly unsubscribe: () => void;
  private dispatchSequence = 0;

  constructor(private readonly transport: LinkTransport) {
    if (transport.node.role !== "gateway") throw new Error("ordered Task dispatcher requires a Gateway transport");
    this.unsubscribe = transport.onEvent((event) => this.handleTransportEvent(event));
  }

  enqueue(assetID: string, task: TaskResource, delivery: TaskDelivery["delivery"] = "assignment"): void {
    if (!assetID) throw new TypeError("Task delivery requires an Asset ID");
    if (delivery === "cancellation") {
      this.send(assetID, { task, delivery });
      return;
    }
    if (this.inFlight.get(assetID)?.task.task_id === task.task_id) return;
    const queue = this.queued.get(assetID) ?? [];
    const existing = queue.findIndex((item) => item.task.task_id === task.task_id);
    if (existing >= 0) queue[existing] = { task, delivery };
    else queue.push({ task, delivery });
    queue.sort(compareTasks);
    this.queued.set(assetID, queue);
    this.pump(assetID);
  }

  enqueueAssignments(assetID: string, tasks: readonly TaskResource[]): void {
    if (!assetID) throw new TypeError("Task delivery requires an Asset ID");
    const queue = this.queued.get(assetID) ?? [];
    for (const task of tasks) {
      if (this.inFlight.get(assetID)?.task.task_id === task.task_id) continue;
      const existing = queue.findIndex((item) => item.task.task_id === task.task_id);
      if (existing >= 0) queue[existing] = { task, delivery: "assignment" };
      else queue.push({ task, delivery: "assignment" });
    }
    queue.sort(compareTasks);
    this.queued.set(assetID, queue);
    this.pump(assetID);
  }

  observeAuthoritativeTask(assetID: string, task: TaskResource): void {
    if (!isTerminalTask(task)) return;
    const active = this.inFlight.get(assetID);
    if (active?.task.task_id === task.task_id) {
      this.inFlight.delete(assetID);
      this.pump(assetID);
    }
  }

  state(assetID: string): { in_flight?: string; queued: string[] } {
    const inFlight = this.inFlight.get(assetID);
    return {
      ...(inFlight === undefined ? {} : { in_flight: inFlight.task.task_id }),
      queued: (this.queued.get(assetID) ?? []).map((item) => item.task.task_id)
    };
  }

  close(): void {
    this.unsubscribe();
    this.queued.clear();
    this.inFlight.clear();
  }

  private pump(assetID: string): void {
    if (this.inFlight.has(assetID)) return;
    const queue = this.queued.get(assetID);
    const next = queue?.shift();
    if (!next) {
      this.queued.delete(assetID);
      return;
    }
    if (queue?.length === 0) this.queued.delete(assetID);
    const operationID = this.send(assetID, next);
    this.inFlight.set(assetID, { ...next, operationID });
  }

  private send(assetID: string, queued: QueuedTask): string {
    const operationID = `task_${queued.task.task_id}_${queued.delivery}_${++this.dispatchSequence}`;
    const result = this.transport.submit(
      { type: "task_delivery", delivery: queued.delivery, task: queued.task },
      { destination: { role: "asset", id: assetID }, operationID }
    );
    if (result.status === "failed") throw new Error(result.reason ?? `Task ${queued.task.task_id} was not queued`);
    return operationID;
  }

  private handleTransportEvent(event: TransportEvent): void {
    if (
      event.type !== "operation" ||
      (event.result.status !== "confirmed" && event.result.status !== "rejected" && event.result.status !== "failed")
    ) {
      return;
    }
    for (const [assetID, task] of this.inFlight) {
      if (task.operationID !== event.result.operation_id) continue;
      this.inFlight.delete(assetID);
      this.pump(assetID);
      return;
    }
  }
}

function isIntentionalFieldMessage(message: TransportMessageEvent["message"]): message is IntentionalFieldMessage {
  if (
    message.type === "task_report" ||
    message.type === "resource_operation" ||
    message.type === "data_request" ||
    message.type === "object_content"
  ) {
    return true;
  }
  return message.type === "state" && message.path === "field" && message.confirmation === "awaiting_core";
}

function runtimeID(message: IntentionalFieldMessage): string | undefined {
  if (message.type === "task_report" || message.type === "resource_operation") return message.runtime_id;
  return message.type === "state" ? message.runtime_id : undefined;
}

function compareTasks(left: QueuedTask, right: QueuedTask): number {
  return (
    left.task.created_at.localeCompare(right.task.created_at) || left.task.task_id.localeCompare(right.task.task_id)
  );
}

function isTerminalTask(task: TaskResource): boolean {
  return task.status === "completed" || task.status === "failed" || task.status === "cancelled";
}
