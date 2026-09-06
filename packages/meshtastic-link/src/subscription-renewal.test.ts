import { describe, expect, it } from "vitest";
import { VirtualClock } from "./clock.js";
import { GatewayFeedDemand } from "./gateway.js";
import { LinkService } from "./service.js";
import { SimulatedPacketNetwork } from "./simulation.js";
import { SUBSCRIPTION_LEASE_MS, SUBSCRIPTION_RENEWAL_MS } from "./subscriptions.js";
import { LinkTransport, type TransportEvent, type TransportMessageEvent } from "./transport.js";
import type { SubscriptionOperation } from "./types.js";

const selector = { kind: "resource_type", resource_type: "entity" } as const;

describe("subscription renewal delivery", () => {
  it("confirms add and remove while sending renewal without a settlement", async () => {
    const harness = createHarness();
    try {
      expect(harness.service.updateLocalSubscription("client-a", "add", selector)).toMatchObject({
        changed: true,
        active: 1
      });
      await harness.clock.advanceBy(1_000);

      expect(harness.messages.map((event) => event.message.action)).toEqual(["add"]);
      expect(harness.messages[0]?.requires_settlement).toBe(true);
      expect(harness.asset.metrics().operation_outcomes).toMatchObject({ confirmed: 1, sent: 0 });
      expect(harness.gateway.metrics().packets_sent_by_message_type.control).toBe(1);

      await harness.clock.advanceTo(SUBSCRIPTION_RENEWAL_MS + 1_000);
      expect(harness.messages.map((event) => event.message.action)).toEqual(["add", "renew"]);
      expect(harness.messages[1]?.requires_settlement).toBe(false);
      expect(harness.asset.metrics().operation_outcomes).toMatchObject({ confirmed: 1, sent: 1 });
      expect(harness.gateway.metrics().packets_sent_by_message_type.control).toBe(1);

      expect(harness.service.updateLocalSubscription("client-a", "remove", selector)).toMatchObject({
        changed: true,
        active: 0
      });
      await harness.clock.advanceBy(1_000);

      expect(harness.messages.map((event) => event.message.action)).toEqual(["add", "renew", "remove"]);
      expect(harness.messages[2]?.requires_settlement).toBe(true);
      expect(harness.asset.metrics().operation_outcomes).toMatchObject({ confirmed: 2, sent: 1 });
      expect(harness.gateway.metrics().packets_sent_by_message_type.control).toBe(2);
      expect(harness.demand.active(harness.clock.now())).toEqual([]);
    } finally {
      harness.close();
    }
  });

  it("tolerates a lost renewal, then expires after the lease has no refresh", async () => {
    const harness = createHarness();
    try {
      harness.service.updateLocalSubscription("client-a", "add", selector);
      await harness.clock.advanceBy(1_000);
      harness.network.disconnect("gateway", "asset-alpha");

      await harness.clock.advanceTo(SUBSCRIPTION_RENEWAL_MS + 1);
      expect(harness.messages.map((event) => event.message.action)).toEqual(["add"]);
      expect(harness.asset.metrics().operation_outcomes).toMatchObject({ confirmed: 1, sent: 1 });
      expect(harness.demand.active(harness.clock.now())).toHaveLength(1);

      harness.network.connect("gateway", "asset-alpha");
      await harness.clock.advanceTo(SUBSCRIPTION_RENEWAL_MS * 2 + 1_000);
      expect(harness.messages.map((event) => event.message.action)).toEqual(["add", "renew"]);
      expect(harness.messages[1]?.requires_settlement).toBe(false);
      expect(harness.demand.active(harness.clock.now())).toHaveLength(1);
      const renewalReceivedAt = harness.messages[1]?.received_at;
      if (renewalReceivedAt === undefined) throw new Error("renewal was not received by the Gateway");

      harness.network.disconnect("gateway", "asset-alpha");
      harness.service.stop();
      expect(harness.demand.active(renewalReceivedAt + SUBSCRIPTION_LEASE_MS - 1)).toHaveLength(1);
      expect(harness.demand.expire(renewalReceivedAt + SUBSCRIPTION_LEASE_MS + 1)).toEqual([
        { active: false, selector }
      ]);
    } finally {
      harness.close();
    }
  });

  it("keeps one renewal for duplicate subscribers and removes only after the last one leaves", async () => {
    const harness = createHarness();
    try {
      harness.service.updateLocalSubscription("client-a", "add", selector);
      harness.service.updateLocalSubscription("client-b", "add", selector);
      await harness.clock.advanceBy(1_000);
      expect(harness.messages.map((event) => event.message.action)).toEqual(["add"]);
      expect(harness.demand.active(harness.clock.now())).toHaveLength(1);

      await harness.clock.advanceTo(SUBSCRIPTION_RENEWAL_MS + 1_000);
      expect(harness.messages.map((event) => event.message.action)).toEqual(["add", "renew"]);
      expect(harness.messages.filter((event) => event.message.action === "renew")).toHaveLength(1);

      harness.service.updateLocalSubscription("client-a", "remove", selector);
      await harness.clock.advanceBy(1_000);
      expect(harness.messages.map((event) => event.message.action)).toEqual(["add", "renew"]);
      expect(harness.demand.active(harness.clock.now())).toHaveLength(1);

      harness.service.updateLocalSubscription("client-b", "remove", selector);
      await harness.clock.advanceBy(1_000);
      expect(harness.messages.map((event) => event.message.action)).toEqual(["add", "renew", "remove"]);
      expect(harness.demand.active(harness.clock.now())).toEqual([]);
    } finally {
      harness.close();
    }
  });

  it("fences a stale renewal after an explicit remove", () => {
    const demand = new GatewayFeedDemand();
    expect(demand.apply(subscriptionEvent("add", 1), 0)).toEqual({ active: true, selector });
    expect(demand.apply(subscriptionEvent("remove", 2), 1)).toEqual({ active: false, selector });
    expect(demand.apply(subscriptionEvent("renew", 1), 2)).toBeUndefined();
    expect(demand.active(2)).toEqual([]);
  });
});

type SubscriptionHarness = {
  clock: VirtualClock;
  network: SimulatedPacketNetwork;
  service: LinkService;
  asset: LinkTransport;
  gateway: LinkTransport;
  demand: GatewayFeedDemand;
  messages: SubscriptionMessageEvent[];
  close: () => void;
};

function createHarness(): SubscriptionHarness {
  const clock = new VirtualClock();
  const network = new SimulatedPacketNetwork({
    seed: 19,
    clock,
    contentionWindowAirtimes: 0,
    carrierSense: false
  });
  const gatewayRadio = network.addRadio("gateway", 1);
  const assetRadio = network.addRadio("asset-alpha", 2);
  network.connect("gateway", "asset-alpha");

  const gateway = new LinkTransport({
    node: { role: "gateway", id: "gateway" },
    sourceGeneration: 1,
    serviceSession: "gateway-session",
    radio: gatewayRadio,
    clock,
    frameEncoding: "deflate-v2"
  });
  const service = new LinkService({ mode: "asset", nodeID: "asset-alpha", clock });
  const asset = new LinkTransport({
    node: service.node,
    sourceGeneration: 1,
    serviceSession: service.serviceSession,
    radio: assetRadio,
    clock,
    picture: service.picture,
    frameEncoding: "deflate-v2"
  });
  const demand = new GatewayFeedDemand();
  const messages: SubscriptionMessageEvent[] = [];

  gateway.onEvent((event) => {
    if (!isSubscriptionEvent(event) || !event.addressed_to_local) return;
    messages.push(event);
    demand.apply(event, clock.now());
    if (event.requires_settlement) gateway.settleInbound(event.settlement_id, true);
  });
  service.attachTransport(asset, { role: "gateway", id: "gateway" });

  return {
    clock,
    network,
    service,
    asset,
    gateway,
    demand,
    messages,
    close: () => {
      service.stop();
      gateway.stop();
      asset.stop();
    }
  };
}

type SubscriptionMessageEvent = Omit<TransportMessageEvent, "message"> & { message: SubscriptionOperation };

function isSubscriptionEvent(event: TransportEvent): event is SubscriptionMessageEvent {
  return event.type === "message" && event.message.type === "subscription";
}

function subscriptionEvent(action: "add" | "renew" | "remove", sourceSequence: number): TransportMessageEvent {
  return {
    type: "message",
    message: { type: "subscription", action, selector },
    operation_id: `subscription-${action}-${sourceSequence}`,
    settlement_id: `settlement-${action}-${sourceSequence}`,
    source: { role: "asset", id: "asset-alpha" },
    destination: { role: "gateway", id: "gateway" },
    source_generation: 1,
    service_session: "asset-session",
    source_sequence: sourceSequence,
    received_at: sourceSequence,
    addressed_to_local: true,
    requires_settlement: action !== "renew"
  };
}
