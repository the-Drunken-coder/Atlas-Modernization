import { describe, expect, it } from "vitest";
import { GatewayFeedDemand, GatewayFieldOperationInbox } from "./gateway.js";
import { positionPublication } from "./test-fixtures.js";
import type { TransportMessageEvent } from "./transport.js";
import type { FeedSelector } from "./types.js";

describe("Gateway application seams", () => {
  it("deduplicates intentional Field reports and rejects Gateway feed loops", () => {
    const inbox = new GatewayFieldOperationInbox();
    const field = messageEvent(positionPublication(1));
    expect(inbox.accept(field)).toMatchObject({
      operation_id: "position-1",
      source_asset_id: "asset-alpha",
      runtime_id: "runtime-alpha"
    });
    expect(inbox.accept(field)).toBeUndefined();
    expect(inbox.accept({ ...field, service_session: "asset-restarted" })).toMatchObject({
      operation_id: "position-1",
      service_session: "asset-restarted"
    });
    expect(
      inbox.accept(
        messageEvent({
          ...positionPublication(2),
          path: "gateway_feed",
          confirmation: "core_confirmed"
        })
      )
    ).toBeUndefined();
  });

  it("exposes only aggregate Gateway feed transitions", () => {
    const demand = new GatewayFeedDemand();
    const selector = { kind: "resource_type", resource_type: "entity" } as const;
    expect(demand.apply(subscriptionEvent("asset-alpha", "add", selector), 0)).toEqual({
      active: true,
      selector
    });
    expect(demand.apply(subscriptionEvent("asset-bravo", "add", selector), 1)).toBeUndefined();
    expect(demand.apply(subscriptionEvent("asset-alpha", "remove", selector), 2)).toBeUndefined();
    expect(demand.expire(90_002)).toEqual([{ active: false, selector }]);
  });

  it("does not let a delayed subscription transition reverse a newer removal", () => {
    const demand = new GatewayFeedDemand();
    const selector = { kind: "resource_type", resource_type: "entity" } as const;
    expect(demand.apply({ ...subscriptionEvent("asset-alpha", "add", selector), source_sequence: 1 }, 0)).toEqual({
      active: true,
      selector
    });
    expect(demand.apply({ ...subscriptionEvent("asset-alpha", "remove", selector), source_sequence: 2 }, 1)).toEqual({
      active: false,
      selector
    });
    expect(
      demand.apply({ ...subscriptionEvent("asset-alpha", "add", selector), source_sequence: 1 }, 2)
    ).toBeUndefined();
    expect(demand.active(2)).toEqual([]);
  });

  it("does not evict a transition fence while its lease is active", () => {
    const demand = new GatewayFeedDemand();
    const active = { kind: "resource_type", resource_type: "entity" } as const;
    demand.apply({ ...subscriptionEvent("asset-alpha", "add", active), source_sequence: 2 }, 0);
    for (let index = 0; index < 4_096; index++) {
      const selector = { kind: "record", resource_type: "entity", id: `entity-${index}` } as const;
      demand.apply({ ...subscriptionEvent(`asset-${index}`, "add", selector), source_sequence: 1 }, 1);
      demand.apply({ ...subscriptionEvent(`asset-${index}`, "remove", selector), source_sequence: 2 }, 2);
    }

    expect(
      demand.apply({ ...subscriptionEvent("asset-alpha", "remove", active), source_sequence: 1 }, 3)
    ).toBeUndefined();
    expect(demand.active(3)).toEqual([active]);
  });

  it("replaces obsolete session fences for the same source and selector", () => {
    const demand = new GatewayFeedDemand();
    const selector = { kind: "resource_type", resource_type: "entity" } as const;
    for (let generation = 1; generation <= 4_096; generation++) {
      demand.apply(
        {
          ...subscriptionEvent("asset-alpha", "add", selector),
          source_generation: generation,
          service_session: `asset-session-${generation}`
        },
        generation
      );
    }
    const another = { kind: "resource_type", resource_type: "task" } as const;

    expect(demand.apply(subscriptionEvent("asset-bravo", "add", another), 4_097)).toEqual({
      active: true,
      selector: another
    });
  });
});

function messageEvent(message: ReturnType<typeof positionPublication>): TransportMessageEvent {
  return {
    type: "message",
    message,
    operation_id: message.operation_id ?? "position",
    settlement_id: "position-settlement",
    source: { role: "asset", id: "asset-alpha" },
    source_generation: 1,
    service_session: "asset-session",
    source_sequence: 1,
    received_at: 0,
    addressed_to_local: false,
    requires_settlement: false
  };
}

function subscriptionEvent(assetID: string, action: "add" | "remove", selector: FeedSelector): TransportMessageEvent {
  return {
    type: "message",
    message: { type: "subscription", action, selector },
    operation_id: `subscription-${assetID}-${action}`,
    settlement_id: `subscription-${assetID}-${action}-settlement`,
    source: { role: "asset", id: assetID },
    destination: { role: "gateway", id: "gateway" },
    source_generation: 1,
    service_session: `${assetID}-session`,
    source_sequence: 1,
    received_at: 0,
    addressed_to_local: true,
    requires_settlement: true
  };
}
