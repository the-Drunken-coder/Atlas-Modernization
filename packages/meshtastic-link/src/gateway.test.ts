import { describe, expect, it } from "vitest";
import { GatewayFeedDemand, GatewayFieldOperationInbox } from "./gateway.js";
import { positionPublication } from "./test-fixtures.js";
import type { TransportMessageEvent } from "./transport.js";

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
});

function messageEvent(message: ReturnType<typeof positionPublication>): TransportMessageEvent {
  return {
    type: "message",
    message,
    operation_id: message.operation_id ?? "position",
    source: { role: "asset", id: "asset-alpha" },
    source_generation: 1,
    service_session: "asset-session",
    source_sequence: 1,
    received_at: 0,
    addressed_to_local: false,
    requires_settlement: false
  };
}

function subscriptionEvent(
  assetID: string,
  action: "add" | "remove",
  selector: { kind: "resource_type"; resource_type: "entity" }
): TransportMessageEvent {
  return {
    type: "message",
    message: { type: "subscription", action, selector },
    operation_id: `subscription-${assetID}-${action}`,
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
