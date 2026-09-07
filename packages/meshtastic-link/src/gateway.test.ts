import type { TaskResource } from "@the-drunken-coder/atlas-sdk";
import { describe, expect, it } from "vitest";
import { VirtualClock } from "./clock.js";
import {
  GatewayFeedDemand,
  GatewayFieldOperationInbox,
  OrderedTaskDispatcher,
  TaskQueueCapacityError
} from "./gateway.js";
import { SimulatedPacketNetwork } from "./simulation.js";
import { positionPublication } from "./test-fixtures.js";
import type { TransportEvent, TransportMessageEvent } from "./transport.js";
import { LinkTransport } from "./transport.js";
import type { FeedSelector } from "./types.js";

describe("Gateway application seams", () => {
  it("delivers UUID-addressed Tasks with canonical frames at the native payload limit", async () => {
    const clock = new VirtualClock();
    const network = new SimulatedPacketNetwork({ seed: 42, clock });
    const gatewayID = "11111111-1111-4111-8111-111111111111";
    const assetID = "22222222-2222-4222-8222-222222222222";
    const task = pendingTaskForAsset(assetID, "33333333-3333-4333-8333-333333333333");
    const gateway = new LinkTransport({
      node: { role: "gateway", id: gatewayID },
      sourceGeneration: 1,
      serviceSession: "1234567890123456",
      radio: network.addRadio(gatewayID, 1),
      clock
    });
    const asset = new LinkTransport({
      node: { role: "asset", id: assetID },
      sourceGeneration: 1,
      serviceSession: "abcdefghijklmnop",
      radio: network.addRadio(assetID, 2),
      clock
    });
    network.connect(gatewayID, assetID);
    const delivered: string[] = [];
    asset.onEvent((event) => {
      if (event.type !== "message" || event.message.type !== "task_delivery") return;
      delivered.push(event.message.task.task_id);
      asset.settleInbound(event.settlement_id, true);
    });
    const dispatcher = new OrderedTaskDispatcher(gateway);
    try {
      dispatcher.enqueue(assetID, task);
      expect(gateway.status(dispatcher.state(assetID).in_flight_operation_id!)).toMatchObject({ status: "queued" });
      await clock.runUntilIdle();
      expect(delivered).toEqual([task.task_id]);
    } finally {
      dispatcher.close();
      gateway.stop();
      asset.stop();
    }
  });

  it.each(["single", "batch"])("keeps waiting cancellations first after %s assignment enqueue", async (mode) => {
    const { dispatcher, gateway, asset, network, clock } = disconnectedTaskPair();
    const delivered: string[] = [];
    asset.onEvent((event) => {
      if (event.type !== "message" || event.message.type !== "task_delivery") return;
      delivered.push(event.message.task.task_id);
      if (event.message.delivery === "cancellation") asset.settleInbound(event.settlement_id, true);
    });
    try {
      dispatcher.enqueue("asset-alpha", pendingTask("unresolved", "2026-09-05T10:00:00Z"));
      dispatcher.enqueue("asset-alpha", cancelledTask("cancel-1", "2026-09-05T12:00:00Z"), "cancellation");
      dispatcher.enqueue("asset-alpha", cancelledTask("cancel-2", "2026-09-05T12:01:00Z"), "cancellation");
      const older = pendingTask("older", "2026-09-05T11:00:00Z");
      if (mode === "single") dispatcher.enqueue("asset-alpha", older);
      else dispatcher.enqueueAssignments("asset-alpha", [older]);
      network.connect("gateway", "asset-alpha");
      await clock.runUntilIdle();
      expect(delivered).toContain("cancel-2");
      expect(delivered).not.toContain("older");
    } finally {
      dispatcher.close();
      gateway.stop();
      asset.stop();
    }
  });

  it("emits the final removal when a lease expires before the expiry sweep", () => {
    const demand = new GatewayFeedDemand();
    const selector = { kind: "resource_type", resource_type: "entity" } as const;
    expect(demand.apply(subscriptionEvent("asset-alpha", "add", selector), 0)).toEqual({ active: true, selector });
    expect(
      demand.apply({ ...subscriptionEvent("asset-alpha", "remove", selector), source_sequence: 2 }, 90_001)
    ).toEqual({ active: false, selector });
    expect(demand.expire(90_002)).toEqual([]);
  });

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

  it("retains inactive transition fences and keeps existing keys usable at capacity", () => {
    const demand = new GatewayFeedDemand();
    const retired = { kind: "record", resource_type: "entity", id: "retired" } as const;
    expect(demand.apply({ ...subscriptionEvent("asset-retired", "add", retired), source_sequence: 1 }, 0)).toEqual({
      active: true,
      selector: retired
    });
    expect(demand.apply({ ...subscriptionEvent("asset-retired", "remove", retired), source_sequence: 2 }, 1)).toEqual({
      active: false,
      selector: retired
    });

    const existing = { kind: "record", resource_type: "entity", id: "entity-0" } as const;
    for (let index = 0; index < 4_095; index++) {
      const selector =
        index === 0
          ? existing
          : ({
              kind: "record",
              resource_type: "entity",
              id: `entity-${index}`
            } as const);
      demand.apply({ ...subscriptionEvent(`asset-${index}`, "add", selector), source_sequence: 1 }, 1);
    }

    const overflow = { kind: "record", resource_type: "entity", id: "overflow" } as const;
    expect(demand.apply(subscriptionEvent("asset-overflow", "add", overflow), 3)).toEqual({
      rejected: true,
      reason: "subscription transition capacity is exhausted"
    });
    expect(
      demand.apply({ ...subscriptionEvent("asset-retired", "add", retired), source_sequence: 1 }, 3)
    ).toBeUndefined();
    expect(demand.active(3)).not.toContain(retired);
    expect(demand.active(3)).toHaveLength(4_095);

    expect(demand.apply({ ...subscriptionEvent("asset-0", "remove", existing), source_sequence: 2 }, 4)).toEqual({
      active: false,
      selector: existing
    });
    expect(demand.apply({ ...subscriptionEvent("asset-0", "renew", existing), source_sequence: 3 }, 5)).toEqual({
      active: true,
      selector: existing
    });
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
      dispatcher.enqueue("asset-alpha", pendingTaskForAsset("asset-alpha", "task-a"));
      dispatcher.enqueue("asset-bravo", pendingTaskForAsset("asset-bravo", "task-b"));
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
      dispatcher.enqueue("asset-alpha", pendingTaskForAsset("asset-alpha", "task-a"));
      dispatcher.enqueue("asset-bravo", pendingTaskForAsset("asset-bravo", "task-b"));
      await clock.runUntilIdle();

      expect(delivered).toEqual(["task-b"]);
      expect(dispatcher.state("asset-alpha")).toEqual({
        in_flight: "task-a",
        in_flight_operation_id: "task_1",
        queued: []
      });
      expect(dispatcher.state("asset-bravo")).toEqual({ queued: [] });
      expect(gateway.diagnostics()).toMatchObject({ queue_depth: 0, confirmed_pending: 0 });
      expect(gateway.status("task_1")).toMatchObject({
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

describe("Ordered Task dispatcher recovery", () => {
  it("dispatches assignments by RFC3339 instant with sub-millisecond precision", async () => {
    const { clock, dispatcher, gateway, asset, network } = disconnectedTaskPair();
    const delivered: string[] = [];
    asset.onEvent((event) => {
      if (event.type !== "message" || !event.addressed_to_local || event.message.type !== "task_delivery") return;
      delivered.push(event.message.task.task_id);
      asset.settleInbound(event.settlement_id, true);
    });

    try {
      network.connect("gateway", "asset-alpha");
      dispatcher.enqueueAssignments("asset-alpha", [
        pendingTask("task-sub-ms-later", "2026-09-05T12:00:00.100001Z"),
        pendingTask("task-c", "2026-09-05T08:00:00.100000-04:00"),
        pendingTask("task-offset-earlier", "2026-09-05T13:00:00.099999+01:00"),
        pendingTask("task-b", "2026-09-05T12:00:00.10Z"),
        pendingTask("task-earliest", "2026-09-05T11:59:59.999999999Z"),
        pendingTask("task-a", "2026-09-05T12:00:00.1Z")
      ]);
      await clock.runUntilIdle();

      expect(delivered).toEqual([
        "task-earliest",
        "task-offset-earlier",
        "task-a",
        "task-b",
        "task-c",
        "task-sub-ms-later"
      ]);
      expect(dispatcher.state("asset-alpha")).toEqual({ queued: [] });
    } finally {
      dispatcher.close();
      gateway.stop();
      asset.stop();
    }
  });

  it("replays a timed-out first assignment from authoritative bulk state before the next Task", async () => {
    const { clock, dispatcher, gateway, asset, network } = disconnectedTaskPair();
    const first = pendingTask("first", "2026-09-05T12:00:00Z");
    const second = pendingTask("second", "2026-09-05T12:01:00Z");
    const delivered: string[] = [];
    asset.onEvent((event) => {
      if (event.type !== "message" || !event.addressed_to_local || event.message.type !== "task_delivery") return;
      delivered.push(event.message.task.task_id);
      asset.settleInbound(event.settlement_id, true);
    });

    try {
      dispatcher.enqueueAssignments("asset-alpha", [first, second]);
      await clock.runUntilIdle();
      expect(dispatcher.state("asset-alpha")).toEqual({
        in_flight: "first",
        in_flight_operation_id: "task_1",
        queued: ["second"]
      });

      network.connect("gateway", "asset-alpha");
      dispatcher.enqueueAssignments("asset-alpha", [first, second]);
      await clock.runUntilIdle();

      expect(delivered).toEqual(["first", "second"]);
      expect(dispatcher.state("asset-alpha")).toEqual({ queued: [] });
      expect(gateway.status("task_1")).toMatchObject({ status: "failed" });
      expect(gateway.status("task_4")).toMatchObject({ status: "confirmed" });
      expect(gateway.status("task_3")).toMatchObject({ status: "confirmed" });
    } finally {
      dispatcher.close();
      gateway.stop();
      asset.stop();
    }
  });

  it("replays a failed assignment through the single enqueue path without exceeding queueLimit", async () => {
    const { clock, dispatcher, gateway, asset, network } = disconnectedTaskPair(1);
    const first = pendingTask("first", "2026-09-05T12:00:00Z");
    const second = pendingTask("second", "2026-09-05T12:01:00Z");
    const delivered: string[] = [];
    asset.onEvent((event) => {
      if (event.type !== "message" || !event.addressed_to_local || event.message.type !== "task_delivery") return;
      delivered.push(event.message.task.task_id);
      asset.settleInbound(event.settlement_id, true);
    });

    try {
      dispatcher.enqueue("asset-alpha", first);
      dispatcher.enqueue("asset-alpha", second);
      await clock.runUntilIdle();
      network.connect("gateway", "asset-alpha");

      expect(() => dispatcher.enqueue("asset-alpha", first)).not.toThrow();
      await clock.runUntilIdle();

      expect(delivered).toEqual(["first", "second"]);
      expect(dispatcher.state("asset-alpha")).toEqual({ queued: [] });
      expect(gateway.status("task_2")).toMatchObject({ status: "confirmed" });
      expect(gateway.status("task_3")).toMatchObject({ status: "confirmed" });
    } finally {
      dispatcher.close();
      gateway.stop();
      asset.stop();
    }
  });

  it("validates bulk replay capacity before attempting the failed assignment", async () => {
    const { clock, dispatcher, gateway, asset, network } = disconnectedTaskPair(1);
    const first = pendingTask("first", "2026-09-05T12:00:00Z");
    const second = pendingTask("second", "2026-09-05T12:01:00Z");
    const third = pendingTask("third", "2026-09-05T12:02:00Z");

    try {
      dispatcher.enqueue("asset-alpha", first);
      dispatcher.enqueue("asset-alpha", second);
      await clock.runUntilIdle();
      network.connect("gateway", "asset-alpha");

      expect(() => dispatcher.enqueueAssignments("asset-alpha", [first, third])).toThrowError(TaskQueueCapacityError);
      expect(gateway.status("task_2")).toBeUndefined();
      expect(dispatcher.state("asset-alpha")).toEqual({
        in_flight: "first",
        in_flight_operation_id: "task_1",
        queued: ["second"]
      });
    } finally {
      dispatcher.close();
      gateway.stop();
      asset.stop();
    }
  });

  it("wakes an explicitly requested replay after temporary transport capacity clears", async () => {
    const { clock, dispatcher, gateway, asset, network } = disconnectedTaskPair(64, 1);
    const first = pendingTask("first", "2026-09-05T12:00:00Z");
    const occupied = pendingTask("occupied", "2026-09-05T12:01:00Z");
    const operationEvents: TransportEvent[] = [];
    const delivered: Array<{ taskID: string; operationID: string }> = [];
    gateway.onEvent((event) => {
      if (event.type === "operation") operationEvents.push(event);
    });
    asset.onEvent((event) => {
      if (event.type !== "message" || !event.addressed_to_local || event.message.type !== "task_delivery") return;
      delivered.push({ taskID: event.message.task.task_id, operationID: event.operation_id });
      asset.settleInbound(event.settlement_id, true);
    });

    try {
      dispatcher.enqueue("asset-alpha", first);
      await clock.runUntilIdle();
      expect(
        gateway.submit(
          { type: "task_delivery", delivery: "assignment", task: occupied },
          { destination: { role: "asset", id: "asset-alpha" }, operationID: "occupied" }
        )
      ).toMatchObject({ status: "queued" });
      dispatcher.enqueue("asset-alpha", first);
      expect(
        operationEvents.filter(
          (event) => event.type === "operation" && event.result.reason === "outbound queue capacity is exhausted"
        )
      ).toHaveLength(1);

      network.connect("gateway", "asset-alpha");
      await clock.runUntilIdle();

      const firstDeliveries = delivered.filter((event) => event.taskID === "first");
      expect(delivered.map((event) => event.taskID)).toEqual(["occupied", "first"]);
      expect(firstDeliveries).toHaveLength(1);
      const firstDelivery = firstDeliveries[0];
      expect(firstDelivery).toBeDefined();
      expect(gateway.status(firstDelivery?.operationID ?? "")).toMatchObject({ status: "confirmed" });
      const firstOperations = operationEvents.filter(
        (event) => event.type === "operation" && event.result.operation_id.startsWith("task_")
      );
      expect(
        firstOperations.filter((event) => event.type === "operation" && event.result.status === "confirmed")
      ).toHaveLength(1);
      expect(
        firstOperations.filter(
          (event) => event.type === "operation" && event.result.reason === "outbound queue capacity is exhausted"
        )
      ).toHaveLength(1);
      expect(dispatcher.state("asset-alpha")).toEqual({ queued: [] });
    } finally {
      dispatcher.close();
      gateway.stop();
      asset.stop();
    }
  });

  it("wakes a replay when confirmed operation capacity is released", async () => {
    const { clock, dispatcher, gateway, asset, network } = disconnectedTaskPair(64, 64, 1);
    const first = pendingTask("first", "2026-09-05T12:00:00Z");
    const occupied = pendingTask("occupied", "2026-09-05T12:01:00Z");
    const operationEvents: TransportEvent[] = [];
    const delivered: Array<{ taskID: string; operationID: string }> = [];
    gateway.onEvent((event) => {
      if (event.type === "operation") operationEvents.push(event);
    });
    asset.onEvent((event) => {
      if (event.type !== "message" || !event.addressed_to_local || event.message.type !== "task_delivery") return;
      delivered.push({ taskID: event.message.task.task_id, operationID: event.operation_id });
      asset.settleInbound(event.settlement_id, true);
    });

    try {
      dispatcher.enqueue("asset-alpha", first);
      await clock.runUntilIdle();
      expect(
        gateway.submit(
          { type: "task_delivery", delivery: "assignment", task: occupied },
          { destination: { role: "asset", id: "asset-alpha" }, operationID: "occupied" }
        )
      ).toMatchObject({ status: "queued" });
      dispatcher.enqueue("asset-alpha", first);

      const attemptsWhileFull = operationEvents.filter(
        (event) => event.type === "operation" && event.result.operation_id.startsWith("task_")
      );
      expect(attemptsWhileFull).toHaveLength(2);
      expect(
        attemptsWhileFull.some(
          (event) => event.type === "operation" && event.result.reason === "confirmed operation capacity is exhausted"
        )
      ).toBe(true);

      network.connect("gateway", "asset-alpha");
      await clock.runUntilIdle();

      const firstDeliveries = delivered.filter((event) => event.taskID === "first");
      expect(delivered.map((event) => event.taskID)).toEqual(["occupied", "first"]);
      expect(firstDeliveries).toHaveLength(1);
      const firstDelivery = firstDeliveries[0];
      expect(firstDelivery).toBeDefined();
      expect(gateway.status(firstDelivery?.operationID ?? "")).toMatchObject({ status: "confirmed" });
      const firstOperations = operationEvents.filter(
        (event) => event.type === "operation" && event.result.operation_id.startsWith("task_")
      );
      expect(
        firstOperations.filter((event) => event.type === "operation" && event.result.status === "confirmed")
      ).toHaveLength(1);
      expect(dispatcher.state("asset-alpha")).toEqual({ queued: [] });
    } finally {
      dispatcher.close();
      gateway.stop();
      asset.stop();
    }
  });

  it("does not nest retry sweeps across Assets while confirmed capacity remains full", async () => {
    const { clock, dispatcher, gateway, asset } = disconnectedTaskPair(64, 64, 2);
    const first = pendingTask("first", "2026-09-05T12:00:00Z");
    const other = { ...pendingTask("other", "2026-09-05T12:00:00Z"), asset_id: "asset-bravo" };
    let capacityFailures = 0;
    gateway.onEvent((event) => {
      if (event.type === "operation" && event.result.reason === "confirmed operation capacity is exhausted") {
        capacityFailures++;
      }
    });

    try {
      dispatcher.enqueue("asset-alpha", first);
      dispatcher.enqueue("asset-bravo", other);
      await clock.runUntilIdle();
      for (const operationID of ["occupied-1", "occupied-2"]) {
        expect(
          gateway.submit(
            { type: "task_delivery", delivery: "assignment", task: pendingTask(operationID, first.created_at) },
            { destination: { role: "asset", id: "asset-alpha" }, operationID }
          ).status
        ).toBe("queued");
      }
      dispatcher.enqueue("asset-alpha", first);
      dispatcher.enqueue("asset-bravo", other);
      const before = capacityFailures;
      gateway.submit(
        { type: "task_delivery", delivery: "assignment", task: first },
        { destination: { role: "asset", id: "asset-alpha" }, operationID: "capacity-probe" }
      );

      // One rejected submission wakes one bounded sweep, with one attempt per Asset.
      expect(capacityFailures - before).toBe(3);
      expect(dispatcher.state("asset-alpha").in_flight).toBe("first");
      expect(dispatcher.state("asset-bravo").in_flight).toBe("other");
    } finally {
      dispatcher.close();
      gateway.stop();
      asset.stop();
    }
  });

  it("defers failed assignment replay until an in-flight cancellation is confirmed", async () => {
    const { clock, dispatcher, gateway, asset, network } = disconnectedTaskPair();
    const first = pendingTask("first", "2026-09-05T12:00:00Z");
    const cancellation = cancelledTask("safety", "2026-09-05T12:01:00Z");
    const delivered: string[] = [];
    let cancellationSettlement: string | undefined;
    asset.onEvent((event) => {
      if (event.type !== "message" || !event.addressed_to_local || event.message.type !== "task_delivery") return;
      delivered.push(event.message.task.task_id);
      if (event.message.delivery === "cancellation") cancellationSettlement = event.settlement_id;
      else asset.settleInbound(event.settlement_id, true);
    });

    try {
      dispatcher.enqueue("asset-alpha", first);
      await clock.runUntilIdle();
      network.connect("gateway", "asset-alpha");
      dispatcher.enqueue("asset-alpha", cancellation, "cancellation");
      for (let attempt = 0; attempt < 28 && cancellationSettlement === undefined; attempt++) {
        await clock.advanceBy(500);
      }
      expect(cancellationSettlement).toBeDefined();

      dispatcher.enqueue("asset-alpha", first);
      await clock.advanceBy(0);
      expect(delivered).toEqual(["safety"]);
      expect(dispatcher.state("asset-alpha")).toEqual({
        in_flight: "first",
        in_flight_operation_id: "task_1",
        cancellation: { task_id: "safety", operation_id: "task_2" },
        queued: []
      });

      expect(asset.settleInbound(cancellationSettlement ?? "", true)).toBe(true);
      await clock.runUntilIdle();
      expect(delivered).toEqual(["safety", "first"]);
      expect(dispatcher.state("asset-alpha")).toEqual({ queued: [] });
      expect(gateway.status("task_3")).toMatchObject({ status: "confirmed" });
    } finally {
      dispatcher.close();
      gateway.stop();
      asset.stop();
    }
  });

  it.each(["single", "batch"])("ignores an oversized %s replay behind an active cancellation", (mode) => {
    const { dispatcher, gateway, asset } = disconnectedTaskPair(64, 4);
    try {
      dispatcher.enqueue("asset-alpha", cancelledTask("same", "2026-09-05T12:00:00Z"), "cancellation");
      expect(dispatcher.state("asset-alpha").cancellation?.task_id).toBe("same");
      const stale = { ...pendingTask("same", "2026-09-05T12:00:00Z"), input: { text: "x".repeat(128 * 1024) } };
      if (mode === "single") dispatcher.enqueue("asset-alpha", stale);
      else {
        dispatcher.enqueueAssignments("asset-alpha", [stale, pendingTask("next", "2026-09-05T12:01:00Z")]);
        expect(dispatcher.state("asset-alpha").queued).toEqual(["next"]);
      }
      expect(dispatcher.state("asset-alpha").cancellation?.task_id).toBe("same");
    } finally {
      dispatcher.close();
      gateway.stop();
      asset.stop();
    }
  });

  it.each(["single", "batch"])(
    "preserves a queued cancellation when an oversized same-Task %s assignment is ignored",
    async (mode) => {
      const { clock, dispatcher, gateway, asset, network } = disconnectedTaskPair(64, 1);
      const cancellation = cancelledTask("same", "2026-09-05T12:00:00Z");
      const assignment = { ...pendingTask("same", "2026-09-05T12:00:00Z"), input: { text: "x".repeat(128 * 1024) } };
      const delivered: Array<{ taskID: string; delivery: string }> = [];
      asset.onEvent((event) => {
        if (event.type !== "message" || !event.addressed_to_local || event.message.type !== "task_delivery") return;
        delivered.push({ taskID: event.message.task.task_id, delivery: event.message.delivery });
        asset.settleInbound(event.settlement_id, true);
      });

      try {
        expect(
          gateway.submit(
            { type: "task_delivery", delivery: "assignment", task: pendingTask("occupied", "2026-09-05T11:00:00Z") },
            { destination: { role: "asset", id: "asset-alpha" }, operationID: "occupied" }
          )
        ).toMatchObject({ status: "queued" });
        dispatcher.enqueue("asset-alpha", cancellation, "cancellation");
        expect(dispatcher.state("asset-alpha")).toEqual({ queued: ["same"] });

        if (mode === "single") dispatcher.enqueue("asset-alpha", assignment);
        else dispatcher.enqueueAssignments("asset-alpha", [assignment]);
        expect(dispatcher.state("asset-alpha")).toEqual({ queued: ["same"] });

        network.connect("gateway", "asset-alpha");
        await clock.runUntilIdle();

        expect(delivered).toContainEqual({ taskID: "same", delivery: "cancellation" });
        expect(delivered).not.toContainEqual({ taskID: "same", delivery: "assignment" });
      } finally {
        dispatcher.close();
        gateway.stop();
        asset.stop();
      }
    }
  );

  it("preserves a queued cancellation when a bulk assignment contains the same Task", async () => {
    const { clock, dispatcher, gateway, asset, network } = disconnectedTaskPair(64, 1);
    const cancellation = cancelledTask("same", "2026-09-05T12:00:00Z");
    const assignment = pendingTask("same", "2026-09-05T12:00:00Z");
    const delivered: Array<{ taskID: string; delivery: string }> = [];
    asset.onEvent((event) => {
      if (event.type !== "message" || !event.addressed_to_local || event.message.type !== "task_delivery") return;
      delivered.push({ taskID: event.message.task.task_id, delivery: event.message.delivery });
      asset.settleInbound(event.settlement_id, true);
    });

    try {
      expect(
        gateway.submit(
          { type: "task_delivery", delivery: "assignment", task: pendingTask("occupied", "2026-09-05T11:00:00Z") },
          { destination: { role: "asset", id: "asset-alpha" }, operationID: "occupied" }
        )
      ).toMatchObject({ status: "queued" });
      dispatcher.enqueue("asset-alpha", cancellation, "cancellation");
      expect(dispatcher.state("asset-alpha")).toEqual({ queued: ["same"] });

      dispatcher.enqueueAssignments("asset-alpha", [assignment]);
      expect(dispatcher.state("asset-alpha")).toEqual({ queued: ["same"] });

      network.connect("gateway", "asset-alpha");
      await clock.runUntilIdle();

      expect(delivered).toContainEqual({ taskID: "same", delivery: "cancellation" });
      expect(delivered).not.toContainEqual({ taskID: "same", delivery: "assignment" });
    } finally {
      dispatcher.close();
      gateway.stop();
      asset.stop();
    }
  });

  it("retains a queued Task when confirmed operation identity capacity is exhausted", async () => {
    const clock = new VirtualClock();
    const network = new SimulatedPacketNetwork({ seed: 82, clock });
    const gateway = new LinkTransport({
      node: { role: "gateway", id: "gateway" },
      sourceGeneration: 1,
      radio: network.addRadio("gateway", 1),
      clock,
      queueLimit: 4_096,
      confirmedLimit: 4_096
    });
    for (let index = 0; index < 4_096; index++) {
      const result = gateway.submit(
        {
          type: "task_delivery",
          delivery: "assignment",
          task: pendingTask(`occupied-${index}`, "2026-09-05T12:00:00Z")
        },
        {
          destination: { role: "asset", id: "asset-alpha" },
          operationID: `occupied-${index}`
        }
      );
      if (result.status !== "queued") throw new Error(`failed to occupy confirmed operation slot ${index}`);
    }
    const dispatcher = new OrderedTaskDispatcher(gateway);

    try {
      dispatcher.enqueue("asset-alpha", pendingTask("retained", "2026-09-05T13:00:00Z"));
      await Promise.resolve();
      expect(dispatcher.state("asset-alpha")).toEqual({ queued: ["retained"] });
    } finally {
      dispatcher.close();
      gateway.stop();
    }
  });
});

function disconnectedTaskPair(
  dispatcherQueueLimit = 64,
  transportQueueLimit = 64,
  confirmedLimit = 64
): {
  clock: VirtualClock;
  dispatcher: OrderedTaskDispatcher;
  gateway: LinkTransport;
  asset: LinkTransport;
  network: SimulatedPacketNetwork;
} {
  const clock = new VirtualClock();
  const radioNetwork = new SimulatedPacketNetwork({ seed: 82, clock });
  const gateway = new LinkTransport({
    node: { role: "gateway", id: "gateway" },
    sourceGeneration: 1,
    radio: radioNetwork.addRadio("gateway", 1),
    clock,
    queueLimit: transportQueueLimit,
    retryIntervalMs: 1_000,
    confirmedLimit
  });
  const asset = new LinkTransport({
    node: { role: "asset", id: "asset-alpha" },
    sourceGeneration: 1,
    radio: radioNetwork.addRadio("asset-alpha", 2),
    clock
  });
  return {
    clock,
    dispatcher: new OrderedTaskDispatcher(gateway, dispatcherQueueLimit),
    gateway,
    asset,
    network: radioNetwork
  };
}

function pendingTask(taskID: string, createdAt: string): TaskResource {
  return {
    asset_id: "asset-alpha",
    command: "atlas.survey",
    created_at: createdAt,
    input: {},
    status: "pending",
    task_id: taskID,
    updated_at: createdAt
  };
}

function cancelledTask(taskID: string, createdAt: string): TaskResource {
  return {
    ...pendingTask(taskID, createdAt),
    cancellation: { code: "requested", message: "Return immediately" },
    finished_at: "2026-09-05T12:05:00Z",
    status: "cancelled",
    updated_at: "2026-09-05T12:05:00Z"
  };
}

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

function subscriptionEvent(
  assetID: string,
  action: "add" | "renew" | "remove",
  selector: FeedSelector
): TransportMessageEvent {
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

function pendingTaskForAsset(assetID: string, taskID: string): TaskResource {
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
