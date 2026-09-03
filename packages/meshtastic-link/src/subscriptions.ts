import { canonicalJSON } from "./canonical-json.js";
import type { FeedSelector } from "./types.js";

export const SUBSCRIPTION_RENEWAL_MS = 30_000;
export const SUBSCRIPTION_LEASE_MS = 90_000;

export type SubscriptionTransition = {
  action: "add" | "renew" | "remove";
  selector: FeedSelector;
};

export class LocalSubscriptionDemand {
  private readonly byClient = new Map<string, Map<string, FeedSelector>>();

  add(clientID: string, selector: FeedSelector): SubscriptionTransition | undefined {
    const key = selectorKey(selector);
    const existed = this.hasKey(key);
    const client = this.byClient.get(clientID) ?? new Map<string, FeedSelector>();
    client.set(key, selector);
    this.byClient.set(clientID, client);
    return existed ? undefined : { action: "add", selector };
  }

  remove(clientID: string, selector: FeedSelector): SubscriptionTransition | undefined {
    const key = selectorKey(selector);
    const client = this.byClient.get(clientID);
    if (!client?.delete(key)) return undefined;
    if (client.size === 0) this.byClient.delete(clientID);
    return this.hasKey(key) ? undefined : { action: "remove", selector };
  }

  disconnect(clientID: string): SubscriptionTransition[] {
    const client = this.byClient.get(clientID);
    if (!client) return [];
    this.byClient.delete(clientID);
    return [...client.entries()]
      .filter(([key]) => !this.hasKey(key))
      .map(([, selector]) => ({ action: "remove" as const, selector }));
  }

  renewals(): SubscriptionTransition[] {
    return [...this.aggregate().values()].map((selector) => ({ action: "renew", selector }));
  }

  aggregate(): ReadonlyMap<string, FeedSelector> {
    const result = new Map<string, FeedSelector>();
    for (const subscriptions of this.byClient.values()) {
      for (const [key, selector] of subscriptions) result.set(key, selector);
    }
    return result;
  }

  private hasKey(key: string): boolean {
    return [...this.byClient.values()].some((subscriptions) => subscriptions.has(key));
  }
}

type Lease = {
  selector: FeedSelector;
  expiresAt: number;
};

export class GatewaySubscriptionDemand {
  private readonly bySource = new Map<string, Map<string, Lease>>();

  apply(sourceNodeID: string, transition: SubscriptionTransition, now: number): boolean {
    const key = selectorKey(transition.selector);
    const existed = this.isDemanded(key, now);
    const source = this.bySource.get(sourceNodeID) ?? new Map<string, Lease>();
    if (transition.action === "remove") {
      source.delete(key);
    } else {
      source.set(key, { selector: transition.selector, expiresAt: now + SUBSCRIPTION_LEASE_MS });
    }
    if (source.size === 0) this.bySource.delete(sourceNodeID);
    else this.bySource.set(sourceNodeID, source);
    return existed !== this.isDemanded(key, now);
  }

  expire(now: number): FeedSelector[] {
    const before = new Map<string, FeedSelector>();
    for (const source of this.bySource.values()) {
      for (const [key, lease] of source) before.set(key, lease.selector);
    }
    for (const [sourceID, source] of this.bySource) {
      for (const [key, lease] of source) if (lease.expiresAt <= now) source.delete(key);
      if (source.size === 0) this.bySource.delete(sourceID);
    }
    const after = this.aggregate(now);
    return [...before].filter(([key]) => !after.has(key)).map(([, selector]) => selector);
  }

  aggregate(now: number): ReadonlyMap<string, FeedSelector> {
    const result = new Map<string, FeedSelector>();
    for (const source of this.bySource.values()) {
      for (const [key, lease] of source) if (lease.expiresAt > now) result.set(key, lease.selector);
    }
    return result;
  }

  private isDemanded(key: string, now: number): boolean {
    return [...this.bySource.values()].some((source) => (source.get(key)?.expiresAt ?? 0) > now);
  }
}

export function selectorKey(selector: FeedSelector): string {
  return canonicalJSON(selector);
}
