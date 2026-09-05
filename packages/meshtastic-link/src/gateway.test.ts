import type { TaskResource } from "@the-drunken-coder/atlas-sdk";
import { describe, expect, it } from "vitest";
import { VirtualClock } from "./clock.js";
import { GatewayFeedDemand, GatewayFieldOperationInbox, OrderedTaskDispatcher } from "./gateway.js";
import { SimulatedPacketNetwork } from "./simulation.js";
import { positionPublication } from "./test-fixtures.js";
import { LinkTransport, type TransportMessageEvent } from "./transport.js";
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

  it("reports when active leases exhaust transition-fence capacity", () => {
    const demand = new GatewayFeedDemand();
    for (let index = 0; index < 4_096; index++) {
      const selector = { kind: "record", resource_type: "entity", id: `entity-${index}` } as const;
      demand.apply(subscriptionEvent(`asset-${index}`, "add", selector), 0);
    }
    const overflow = { kind: "record", resource_type: "entity", id: "entity-overflow" } as const;

    expect(demand.apply(subscriptionEvent("asset-overflow", "add", overflow), 1)).toEqual({
      rejected: true,
      reason: "subscription transition capacity is exhausted"
    });
    expect(demand.active(1)).toHaveLength(4_096);
  });

  it("wakes another Asset queue when a confirmed Task completes", async () => {
    const clock = new VirtualClock();
    const network = new SimulatedPacketNetwork({ seed: 42, clock });
    const gateway = new LinkTransport({
      node: { role: "gateway", id: "gateway" },
      sourceGeneration: 1,
      radio: network.addRadio("gateway", 1),
      clock,
      confirmedLimit: 1
    });
    const delivered: string[] = [];
    const assets = ["asset-alpha", "asset-bravo"].map((assetID, index) => {
      const asset = new LinkTransport({
        node: { role: "asset", id: assetID },
        sourceGeneration: 1,
        radio: network.addRadio(assetID, index + 2),
        clock
      });
      network.connect("gateway", assetID);
      asset.onEvent((event) => {
        if (event.type !== "message" || !event.addressed_to_local || event.message.type !== "task_delivery") return;
        delivered.push(event.message.task.task_id);
        asset.settleInbound(event.settlement_id, true);
      });
      return asset;
    });
    const dispatcher = new OrderedTaskDispatcher(gateway);

    try {
      dispatcher.enqueue("asset-alpha", pendingTask("asset-alpha", "task-a"));
      dispatcher.enqueue("asset-bravo", pendingTask("asset-bravo", "task-b"));
      await clock.runUntilIdle();

      expect(delivered).toEqual(["task-a", "task-b"]);
      expect(dispatcher.state("asset-bravo")).toEqual({ queued: [] });
      expect(gateway.diagnostics()).toMatchObject({ queue_depth: 0, confirmed_pending: 0 });
    } finally {
      dispatcher.close();
      gateway.stop();
      for (const asset of assets) asset.stop();
    }
  });

  it("wakes another Asset queue when a confirmed Task fails and preserves the failed barrier", async () => {
    const clock = new VirtualClock();
    const network = new SimulatedPacketNetwork({ seed: 43, clock });
    const gateway = new LinkTransport({
      node: { role: "gateway", id: "gateway" },
      sourceGeneration: 1,
      radio: network.addRadio("gateway", 1),
      clock,
      confirmedLimit: 1
    });
    const asset = new LinkTransport({
      node: { role: "asset", id: "asset-bravo" },
      sourceGeneration: 1,
      radio: network.addRadio("asset-bravo", 2),
      clock
    });
    network.connect("gateway", "asset-bravo");
    const delivered: string[] = [];
    asset.onEvent((event) => {
      if (event.type !== "message" || !event.addressed_to_local || event.message.type !== "task_delivery") return;
      delivered.push(event.message.task.task_id);
      asset.settleInbound(event.settlement_id, true);
    });
    const dispatcher = new OrderedTaskDispatcher(gateway);

    try {
      dispatcher.enqueue("asset-alpha", pendingTask("asset-alpha", "task-a"));
      dispatcher.enqueue("asset-bravo", pendingTask("asset-bravo", "task-b"));
      await clock.runUntilIdle();

      expect(delivered).toEqual(["task-b"]);
      expect(dispatcher.state("asset-alpha")).toEqual({ in_flight: "task-a", queued: [] });
      expect(dispatcher.state("asset-bravo")).toEqual({ queued: [] });
      expect(gateway.diagnostics()).toMatchObject({ queue_depth: 0, confirmed_pending: 0 });
      expect(gateway.status("task_task-a_assignment_1")).toMatchObject({
        status: "failed",
        reason: "confirmation deadline expired"
      });
    } finally {
      dispatcher.close();
      gateway.stop();
      asset.stop();
    }
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

function pendingTask(assetID: string, taskID: string): TaskResource {
  return {
    asset_id: assetID,
    task_id: taskID,
    command: "atlas.survey",
    input: {},
    status: "pending",
    created_at: "2026-09-02T12:00:00Z",
    updated_at: "2026-09-02T12:00:00Z"
  };
}
