import type { AtlasSubscription, FeedEvent, TaskResource } from "../../src";
import type { WebSocketEvent, WebSocketEventType, WebSocketListener } from "../../src/types.js";

export type FakeWebSocketOwner = {
  revision: string;
  version: number;
  rejectFeedAuth: boolean;
  expectedFeedApiKey?: string;
  onFeedSubscriptionBarrier?: (activateAndAcknowledge: () => void) => void;
  feedAuthFrames: Array<{ apiKey?: string }>;
  feedConnections: number;
  sockets: Set<FakeWebSocket>;
};

export class FakeWebSocket {
  readyState = 0;
  sentMessages: unknown[] = [];
  private listeners = new Map<WebSocketEventType, Set<WebSocketListener>>();
  private subscriptions: AtlasSubscription[] = [];
  private pendingSubscriptions: AtlasSubscription[] = [];
  private postBarrierChanges: Array<{ action: "subscribe" | "unsubscribe"; subscription: AtlasSubscription }> = [];
  private barrierReceived = false;
  private subscriptionsReady = false;

  constructor(
    readonly url: string,
    private readonly core: FakeWebSocketOwner
  ) {
    this.core.feedConnections++;
    this.core.sockets.add(this);
    queueMicrotask(() => {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      this.dispatch("open", {});
      setTimeout(() => {
        if (this.readyState !== 1) return;
        this.receive({ type: "hello", protocol_revision: this.core.revision });
      }, 0);
    });
  }

  send(data: string): void {
    const parsed = JSON.parse(data);
    this.sentMessages.push(parsed);
    if (parsed.action === "auth") {
      this.core.feedAuthFrames.push({ apiKey: parsed.api_key });
    }
    if (
      parsed.action === "auth" &&
      (this.core.rejectFeedAuth ||
        (this.core.expectedFeedApiKey !== undefined && parsed.api_key !== this.core.expectedFeedApiKey))
    ) {
      this.close();
      return;
    }
    if (parsed.action === "subscribe") {
      if (this.barrierReceived && !this.subscriptionsReady) {
        this.postBarrierChanges.push({ action: "subscribe", subscription: parsed });
      } else if (this.core.onFeedSubscriptionBarrier && !this.subscriptionsReady) {
        this.pendingSubscriptions.push(parsed);
      } else {
        this.applySubscriptionChange("subscribe", parsed);
      }
    }
    if (parsed.action === "unsubscribe") {
      if (this.barrierReceived && !this.subscriptionsReady) {
        this.postBarrierChanges.push({ action: "unsubscribe", subscription: parsed });
      } else {
        const key = subscriptionKey(parsed);
        this.pendingSubscriptions = this.pendingSubscriptions.filter(
          (subscription) => subscriptionKey(subscription) !== key
        );
        this.applySubscriptionChange("unsubscribe", parsed);
      }
    }
    if (parsed.action === "subscription_barrier") {
      const initialSubscriptions = this.pendingSubscriptions;
      this.pendingSubscriptions = [];
      this.barrierReceived = true;
      for (const subscription of initialSubscriptions) this.applySubscriptionChange("subscribe", subscription);
      const activateAndAcknowledge = () => {
        this.subscriptionsReady = true;
        this.receive({ type: "subscriptions_ready", version: this.core.version });
        for (const change of this.postBarrierChanges) {
          this.applySubscriptionChange(change.action, change.subscription);
        }
        this.postBarrierChanges = [];
      };
      const barrier = this.core.onFeedSubscriptionBarrier;
      if (barrier) barrier(activateAndAcknowledge);
      else activateAndAcknowledge();
    }
  }

  private applySubscriptionChange(action: "subscribe" | "unsubscribe", subscription: AtlasSubscription): void {
    const key = subscriptionKey(subscription);
    this.subscriptions = this.subscriptions.filter((existing) => subscriptionKey(existing) !== key);
    if (action === "subscribe") this.subscriptions.push(subscription);
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.core.sockets.delete(this);
    this.dispatch("close", {});
  }

  addEventListener(type: WebSocketEventType, listener: WebSocketListener): void {
    let listeners = this.listeners.get(type);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(type, listeners);
    }
    listeners.add(listener);
  }

  removeEventListener(type: WebSocketEventType, listener: WebSocketListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  receive(value: unknown): void {
    if (this.readyState !== 1) {
      return;
    }
    this.dispatch("message", { data: JSON.stringify(value) });
  }

  subscribedTo(event: FeedEvent, beforeTaskEntityId?: string | null): boolean {
    return this.subscriptions.some((subscription) => subscriptionMatches(subscription, event, beforeTaskEntityId));
  }

  private dispatch(type: WebSocketEventType, event: WebSocketEvent): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function subscriptionKey(filter: AtlasSubscription): string {
  switch (filter.filter) {
    case "all":
      return "all";
    case "id":
      return `id:${filter.resource_type}:${filter.id}`;
    case "type":
      return `type:${filter.resource_type}`;
    case "tasks_for_entity":
      return `tasks_for_entity:${filter.entity_id}`;
  }
}

function subscriptionMatches(filter: AtlasSubscription, event: FeedEvent, beforeTaskEntityId?: string | null): boolean {
  switch (filter.filter) {
    case "all":
      return true;
    case "id":
      return event.resource_type === filter.resource_type && event.id === filter.id;
    case "type":
      return event.resource_type === filter.resource_type;
    case "tasks_for_entity":
      return (
        event.resource_type === "task" &&
        (beforeTaskEntityId === filter.entity_id ||
          (event as FeedEvent & { entity_id?: string | null }).entity_id === filter.entity_id ||
          (event as FeedEvent & { previous_entity_id?: string | null }).previous_entity_id === filter.entity_id ||
          (event.event !== "delete" && (event.resource as TaskResource).entity_id === filter.entity_id))
      );
  }
}
