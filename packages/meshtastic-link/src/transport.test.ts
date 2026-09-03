import { createHash } from "node:crypto";
import type { TaskResource } from "@the-drunken-coder/atlas-sdk";
import { describe, expect, it } from "vitest";
import { encodeCanonicalJSON } from "./canonical-json.js";
import { type Clock, type TimerHandle, VirtualClock } from "./clock.js";
import { serializeLinkMessage } from "./contract.js";
import { decodeFrame, type FrameIdentity, fragmentPayload, MAX_LINK_MESSAGE_BYTES } from "./frame.js";
import { OrderedTaskDispatcher } from "./gateway.js";
import { SharedPicture } from "./picture.js";
import type { LinkRadio, RadioPacket, RadioSendOptions } from "./radio.js";
import { SimulatedPacketNetwork } from "./simulation.js";
import { positionPublication } from "./test-fixtures.js";
import { LinkTransport } from "./transport.js";

describe("Link transport", () => {
  it("requires application settlement before confirming addressed work", async () => {
    const { clock, gateway, asset } = directPair();
    const received: string[] = [];
    asset.onEvent((event) => {
      if (event.type === "message" && event.addressed_to_local && event.message.type === "task_delivery") {
        received.push(event.message.task.task_id);
        expect(event.requires_settlement).toBe(true);
        asset.settleInbound(event.settlement_id, true);
      }
    });
    const result = gateway.submit(
      { type: "task_delivery", delivery: "assignment", task: pendingTask("task-1", "2026-09-02T12:00:00Z") },
      { destination: { role: "asset", id: "asset-alpha" }, operationID: "deliver-task-1" }
    );
    expect(result.status).toBe("queued");
    await clock.runUntilIdle();
    expect(received).toEqual(["task-1"]);
    expect(gateway.status("deliver-task-1")?.status).toBe("confirmed");
  });

  it("rejects Task delivery from an Asset source", async () => {
    const clock = new VirtualClock();
    const network = new SimulatedPacketNetwork({ seed: 51, clock });
    const senderRadio = network.addRadio("asset-sender", 1);
    const receiverRadio = network.addRadio("asset-receiver", 2);
    network.connect("asset-sender", "asset-receiver");
    const sender = new LinkTransport({
      node: { role: "asset", id: "asset-sender" },
      sourceGeneration: 1,
      radio: senderRadio,
      clock
    });
    const receiver = new LinkTransport({
      node: { role: "asset", id: "asset-receiver" },
      sourceGeneration: 1,
      radio: receiverRadio,
      clock
    });
    let delivered = false;
    receiver.onEvent((event) => {
      if (event.type === "message" && event.message.type === "task_delivery") delivered = true;
    });
    sender.submit(
      { type: "task_delivery", delivery: "assignment", task: pendingTask("task-forged", "2026-09-02T12:00:00Z") },
      { destination: { role: "asset", id: "asset-receiver" }, operationID: "forged-task" }
    );
    await clock.runUntilIdle();
    expect(delivered).toBe(false);
    expect(sender.status("forged-task")).toMatchObject({
      status: "rejected",
      reason: "Task delivery source is not the Gateway"
    });
  });

  it("surfaces application rejection and bounded retry exhaustion", async () => {
    const rejectedPair = directPair();
    rejectedPair.asset.onEvent((event) => {
      if (event.type === "message" && event.requires_settlement) {
        rejectedPair.asset.settleInbound(event.settlement_id, false, "Asset cannot accept Task");
      }
    });
    rejectedPair.gateway.submit(
      { type: "task_delivery", delivery: "assignment", task: pendingTask("task-rejected", "2026-09-02T12:00:00Z") },
      { destination: { role: "asset", id: "asset-alpha" }, operationID: "reject-task" }
    );
    await rejectedPair.clock.runUntilIdle();
    expect(rejectedPair.gateway.status("reject-task")).toMatchObject({
      status: "rejected",
      reason: "Asset cannot accept Task"
    });

    const clock = new VirtualClock();
    const network = new SimulatedPacketNetwork({ seed: 18, clock });
    const isolated = new LinkTransport({
      node: { role: "gateway", id: "gateway" },
      sourceGeneration: 1,
      radio: network.addRadio("isolated", 30),
      clock,
      retryIntervalMs: 1_000
    });
    isolated.submit(
      { type: "task_delivery", delivery: "assignment", task: pendingTask("task-timeout", "2026-09-02T12:00:00Z") },
      { destination: { role: "asset", id: "missing" }, operationID: "timeout-task" }
    );
    await clock.runUntilIdle();
    expect(isolated.status("timeout-task")).toMatchObject({
      status: "failed",
      reason: "confirmation deadline expired"
    });
    expect(isolated.metrics().retry_exhausted).toBe(1);
  });

  it("keeps a confirmed data request pending until its response deadline", async () => {
    const { clock, gateway, asset } = directPair();
    gateway.onEvent((event) => {
      if (event.type === "message" && event.message.type === "data_request" && event.addressed_to_local) {
        gateway.settleInbound(event.settlement_id, true);
      }
    });
    asset.submit(
      {
        type: "data_request",
        request_id: "request-without-response",
        operation: "entity.get",
        target_id: "asset-alpha"
      },
      { destination: { role: "gateway", id: "gateway" }, operationID: "request-without-response" }
    );

    for (
      let attempt = 0;
      attempt < 100 && asset.status("request-without-response")?.status !== "confirmed";
      attempt++
    ) {
      await clock.advanceBy(100);
    }
    expect(asset.status("request-without-response")?.status).toBe("confirmed");

    await clock.advanceTo(30_000);
    expect(asset.status("request-without-response")).toMatchObject({
      status: "failed",
      reason: "response deadline expired"
    });
  });

  it("reserves outbound capacity for an admitted inbound settlement", async () => {
    const clock = new VirtualClock();
    const network = new SimulatedPacketNetwork({ seed: 33, clock });
    const gatewayRadio = network.addRadio("gateway", 1);
    const assetRadio = network.addRadio("asset-alpha", 2);
    network.connect("gateway", "asset-alpha");
    const gateway = new LinkTransport({
      node: { role: "gateway", id: "gateway" },
      sourceGeneration: 1,
      radio: gatewayRadio,
      clock
    });
    const asset = new LinkTransport({
      node: { role: "asset", id: "asset-alpha" },
      sourceGeneration: 1,
      radio: assetRadio,
      clock,
      queueLimit: 1
    });
    let settlementID: string | undefined;
    asset.onEvent((event) => {
      if (event.type === "message" && event.requires_settlement) settlementID = event.settlement_id;
    });
    gateway.submit(
      { type: "task_delivery", delivery: "assignment", task: pendingTask("task-1", "2026-09-02T12:00:00Z") },
      { destination: { role: "asset", id: "asset-alpha" }, operationID: "deliver-task-1" }
    );
    for (let attempt = 0; attempt < 30 && settlementID === undefined; attempt++) await clock.advanceBy(500);
    expect(settlementID).toBeDefined();
    expect(asset.submit(positionPublication(2), { operationID: "would-use-reserved-slot" })).toMatchObject({
      status: "failed",
      reason: "outbound queue capacity is exhausted"
    });
    expect(asset.settleInbound(settlementID ?? "", true)).toBe(true);
    await clock.runUntilIdle();
    expect(gateway.status("deliver-task-1")?.status).toBe("confirmed");
  });

  it("counts an active fragment before admitting inbound confirmed work", async () => {
    const clock = new ControlledClock();
    const radio = new DeferredFirstSendRadio();
    const receiver = new LinkTransport({
      node: { role: "asset", id: "asset-alpha" },
      sourceGeneration: 1,
      radio,
      clock,
      queueLimit: 1
    });
    let delivered = false;
    receiver.onEvent((event) => {
      if (event.type === "message" && event.message.type === "task_delivery") delivered = true;
    });
    receiver.submit(positionPublication(1), { operationID: "active-state" });
    const activeSend = clock.fireAt(0);
    const task = {
      type: "task_delivery",
      delivery: "assignment",
      task: pendingTask("task-overload", "2026-09-02T12:00:00Z")
    } as const;
    const identity: FrameIdentity = {
      revision: 1,
      message_type: "task_delivery",
      source: { role: "gateway", id: "gateway" },
      destination: { role: "asset", id: "asset-alpha" },
      source_generation: 1,
      service_session: "gateway-session",
      source_sequence: 1,
      operation_id: "inbound-task",
      message_id: "inbound-message",
      priority: "task"
    };
    for (const frame of fragmentPayload(serializeLinkMessage(task), identity)) {
      radio.receive({ payload: frame, received_at: 0, radio_source: 2, channel: 1, public_key_encrypted: false });
    }
    expect(delivered).toBe(false);
    expect(receiver.diagnostics().inbound_awaiting_settlement).toBe(0);
    expect(receiver.metrics().confirmed_rejected_overload).toBe(1);
    radio.resolveFirstSend();
    await Promise.all(activeSend);
    await Promise.all(clock.fireAt(0));
    expect(radio.sendCount).toBeGreaterThan(1);
    receiver.stop();
  });

  it("does not continue a fragmented transmission after its deadline", async () => {
    const clock = new ControlledClock();
    const radio = new DeferredFirstSendRadio();
    const transport = new LinkTransport({
      node: { role: "gateway", id: "gateway" },
      sourceGeneration: 1,
      radio,
      clock
    });
    const content = Buffer.alloc(1_024, 3);
    transport.submit(
      {
        type: "object_content",
        object_id: "object-deadline",
        content_base64: content.toString("base64"),
        sha256: `sha256:${createHash("sha256").update(content).digest("hex")}`
      },
      { destination: { role: "asset", id: "asset-alpha" }, operationID: "deadline-object" }
    );
    const pumping = clock.fireAt(0);
    expect(radio.sendCount).toBe(1);
    await Promise.all(clock.fireAt(5 * 60_000));
    expect(transport.status("deadline-object")?.status).toBe("failed");
    radio.resolveFirstSend();
    await Promise.all(pumping);
    await Promise.all(clock.fireAt(5 * 60_000));
    expect(radio.sendCount).toBe(1);
  });

  it("drops a fragmented message before reassembly exceeds its byte bound", () => {
    const clock = new VirtualClock();
    const network = new SimulatedPacketNetwork({ seed: 21, clock });
    const radio = network.addRadio("gateway", 1);
    const receiver = new LinkTransport({
      node: { role: "gateway", id: "g" },
      sourceGeneration: 1,
      radio,
      clock
    });
    const chunk = Buffer.alloc(64, 1).toString("base64url");
    const chunkCount = MAX_LINK_MESSAGE_BYTES / 64 + 1;
    for (let index = 0; index < chunkCount; index++) {
      const frame = encodeCanonicalJSON({
        v: 1,
        k: "b",
        s: "a:a",
        d: "g:g",
        g: 1,
        x: "s",
        q: 1,
        o: "o",
        m: "m",
        y: "o",
        i: index,
        n: chunkCount,
        p: chunk
      });
      expect(frame.byteLength).toBeLessThanOrEqual(233);
      radio.receive({ payload: frame, received_at: index, radio_source: 2, channel: 1, public_key_encrypted: false });
    }
    expect(receiver.metrics().incomplete_reassemblies).toBe(1);
    expect(receiver.diagnostics().incomplete_reassemblies).toBe(0);
  });

  it("accepts settlement only from the addressed application", async () => {
    const clock = new VirtualClock();
    const network = new SimulatedPacketNetwork({ seed: 19, clock });
    const gatewayRadio = network.addRadio("gateway", 1);
    const assetRadio = network.addRadio("asset-alpha", 2);
    const peerRadio = network.addRadio("asset-bravo", 3);
    network.connect("gateway", "asset-alpha");
    network.connect("gateway", "asset-bravo");
    const gateway = new LinkTransport({
      node: { role: "gateway", id: "gateway" },
      sourceGeneration: 1,
      radio: gatewayRadio,
      clock
    });
    const asset = new LinkTransport({
      node: { role: "asset", id: "asset-alpha" },
      sourceGeneration: 1,
      radio: assetRadio,
      clock
    });
    const peer = new LinkTransport({
      node: { role: "asset", id: "asset-bravo" },
      sourceGeneration: 1,
      radio: peerRadio,
      clock
    });
    let messageID: string | undefined;
    let receivedOperation: string | undefined;
    let receivedSettlement: string | undefined;
    gateway.onEvent((event) => {
      if (event.type === "packet_sent" && event.operation_id === "addressed-task") messageID = event.message_id;
    });
    asset.onEvent((event) => {
      if (event.type === "message" && event.message.type === "task_delivery" && event.addressed_to_local) {
        receivedOperation = event.operation_id;
        receivedSettlement = event.settlement_id;
      }
    });
    gateway.submit(
      { type: "task_delivery", delivery: "assignment", task: pendingTask("task-addressed", "2026-09-02T12:00:00Z") },
      { destination: { role: "asset", id: "asset-alpha" }, operationID: "addressed-task" }
    );
    await clock.advanceBy(0);
    expect(messageID).toBeDefined();
    if (!messageID) throw new Error("task did not emit a transport message identity");
    peer.submit(
      { type: "control", control: "confirmed", operation_id: "addressed-task", message_id: messageID },
      { destination: { role: "gateway", id: "gateway" }, operationID: "forged-confirmation" }
    );
    await clock.advanceBy(10_000);
    expect(receivedOperation).toBe("addressed-task");
    expect(gateway.status("addressed-task")?.status).toBe("queued");
    if (!receivedOperation || !receivedSettlement) throw new Error("addressed Asset did not receive the Task");
    asset.settleInbound(receivedSettlement, true);
    await clock.runUntilIdle();
    expect(gateway.status("addressed-task")?.status).toBe("confirmed");
  });

  it("expires unhandled inbound work instead of retaining it indefinitely", async () => {
    const { clock, gateway, asset } = directPair();
    gateway.submit(
      { type: "task_delivery", delivery: "assignment", task: pendingTask("task-unhandled", "2026-09-02T12:00:00Z") },
      { destination: { role: "asset", id: "asset-alpha" }, operationID: "unhandled-task" }
    );
    await clock.runUntilIdle();
    expect(asset.diagnostics().inbound_awaiting_settlement).toBe(0);
    expect(asset.metrics().inbound_settlement_expired).toBe(1);
    expect(gateway.status("unhandled-task")?.status).toBe("failed");
  });

  it("scopes duplicate settlement state to the sending Link session", async () => {
    const clock = new VirtualClock();
    const network = new SimulatedPacketNetwork({ seed: 20, clock });
    const gatewayRadio = network.addRadio("gateway", 1);
    const alphaRadio = network.addRadio("asset-alpha", 2);
    const bravoRadio = network.addRadio("asset-bravo", 3);
    network.connect("gateway", "asset-alpha");
    network.connect("gateway", "asset-bravo");
    const gateway = new LinkTransport({
      node: { role: "gateway", id: "gateway" },
      sourceGeneration: 1,
      radio: gatewayRadio,
      clock
    });
    const alpha = new LinkTransport({
      node: { role: "asset", id: "asset-alpha" },
      sourceGeneration: 1,
      serviceSession: "alpha-session",
      radio: alphaRadio,
      clock
    });
    const bravo = new LinkTransport({
      node: { role: "asset", id: "asset-bravo" },
      sourceGeneration: 1,
      serviceSession: "bravo-session",
      radio: bravoRadio,
      clock
    });
    const received: Array<{ source: string; settlement: string }> = [];
    gateway.onEvent((event) => {
      if (event.type !== "message" || event.message.type !== "resource_operation" || !event.addressed_to_local) return;
      received.push({ source: event.source.id, settlement: event.settlement_id });
      gateway.settleInbound(event.settlement_id, true);
    });
    const request = {
      type: "resource_operation",
      operation: "entity.delete",
      target_id: "x"
    } as const;
    alpha.submit(request, { destination: { role: "gateway", id: "gateway" }, operationID: "shared-operation" });
    await clock.runUntilIdle();
    bravo.submit(request, { destination: { role: "gateway", id: "gateway" }, operationID: "shared-operation" });
    await clock.runUntilIdle();
    expect(received.map(({ source }) => source)).toEqual(["asset-alpha", "asset-bravo"]);
    expect(new Set(received.map(({ settlement }) => settlement)).size).toBe(2);
    expect(alpha.status("shared-operation")?.status).toBe("confirmed");
    expect(bravo.status("shared-operation")?.status).toBe("confirmed");
  });

  it("coalesces only unsent best-effort state", async () => {
    const { clock, gateway, assetPicture } = directPair();
    gateway.submit(positionPublication(1), { operationID: "position-1" });
    gateway.submit(positionPublication(2), { operationID: "position-2" });
    expect(gateway.status("position-1")).toMatchObject({ status: "failed", reason: "replaced by newer unsent state" });
    await clock.runUntilIdle();
    expect(gateway.status("position-2")?.status).toBe("sent");
    expect(assetPicture.snapshot().records[0]?.atlas_version).toBe(2);
    expect(gateway.metrics().best_effort_replaced).toBe(1);
  });

  it("does not let a failed low-priority send delay queued safety traffic", async () => {
    const clock = new ControlledClock();
    const radio = new FailingFirstSendRadio();
    const transport = new LinkTransport({
      node: { role: "gateway", id: "gateway" },
      sourceGeneration: 1,
      radio,
      clock,
      retryIntervalMs: 1_000
    });
    transport.submit(
      {
        type: "object_content",
        object_id: "object-low-priority",
        content_base64: Buffer.from("content").toString("base64"),
        sha256: `sha256:${createHash("sha256").update("content").digest("hex")}`
      },
      { destination: { role: "asset", id: "asset-alpha" }, operationID: "low-priority" }
    );
    await Promise.all(clock.fireAt(0));
    transport.submit(
      {
        type: "task_delivery",
        delivery: "cancellation",
        task: cancelledTask("task-urgent", "2026-09-02T12:00:00Z")
      },
      { destination: { role: "asset", id: "asset-alpha" }, operationID: "urgent" }
    );

    await Promise.all(clock.fireAt(0));

    expect(radio.attemptedOperations.slice(0, 2)).toEqual(["low-priority", "urgent"]);
    transport.stop();
  });

  it("rejects Asset state that claims Gateway-feed Core authority", () => {
    const clock = new VirtualClock();
    const network = new SimulatedPacketNetwork({ seed: 52, clock });
    const receiverRadio = network.addRadio("receiver", 2);
    const picture = new SharedPicture("receiver-picture");
    new LinkTransport({
      node: { role: "gateway", id: "gateway" },
      sourceGeneration: 1,
      radio: receiverRadio,
      clock,
      picture
    });
    const publication = {
      ...positionPublication(1),
      path: "gateway_feed",
      confirmation: "core_confirmed"
    } as const;
    const identity: FrameIdentity = {
      revision: 1,
      message_type: "state",
      source: { role: "asset", id: "asset-alpha" },
      source_generation: 1,
      service_session: "asset-session",
      source_sequence: 1,
      operation_id: "forged-authority",
      message_id: "forged-authority-message",
      priority: "live_state"
    };
    for (const frame of fragmentPayload(serializeLinkMessage(publication), identity)) {
      receiverRadio.receive({
        payload: frame,
        received_at: 0,
        radio_source: 1,
        channel: 1,
        public_key_encrypted: false
      });
    }

    expect(picture.snapshot().records).toEqual([]);
  });

  it("returns a visible failure when Link metadata leaves no packet room", () => {
    const { gateway } = directPair();
    expect(gateway.submit(positionPublication(1), { operationID: "x".repeat(512) })).toMatchObject({
      status: "failed",
      reason: expect.stringContaining("Link framing failed")
    });
  });

  it("recovers current state after a temporary partition", async () => {
    const clock = new VirtualClock();
    const network = new SimulatedPacketNetwork({ seed: 5, clock });
    const sourceRadio = network.addRadio("source", 1);
    const receiverRadio = network.addRadio("receiver", 2);
    const picture = new SharedPicture("receiver-picture");
    const source = new LinkTransport({
      node: { role: "asset", id: "asset-alpha" },
      sourceGeneration: 1,
      radio: sourceRadio,
      clock
    });
    new LinkTransport({
      node: { role: "gateway", id: "gateway" },
      sourceGeneration: 1,
      radio: receiverRadio,
      clock,
      picture
    });
    source.submit(positionPublication(1), { operationID: "partitioned-state" });
    await clock.runUntilIdle();
    expect(picture.snapshot().records).toHaveLength(0);
    network.connect("source", "receiver");
    source.submit(positionPublication(2), { operationID: "reconnected-state" });
    await clock.runUntilIdle();
    expect(picture.snapshot().records[0]?.atlas_version).toBe(2);
  });

  it("lets a higher source generation retire delayed old state", async () => {
    const clock = new VirtualClock();
    const network = new SimulatedPacketNetwork({ seed: 7, clock });
    const sourceRadio = network.addRadio("source", 10);
    const receiverRadio = network.addRadio("receiver", 20);
    network.connect("source", "receiver");
    const picture = new SharedPicture("receiver-picture");
    const oldSource = new LinkTransport({
      node: { role: "asset", id: "asset-alpha" },
      sourceGeneration: 1,
      serviceSession: "old-session",
      radio: sourceRadio,
      clock
    });
    const newSource = new LinkTransport({
      node: { role: "asset", id: "asset-alpha" },
      sourceGeneration: 2,
      serviceSession: "new-session",
      radio: sourceRadio,
      clock
    });
    const receiver = new LinkTransport({
      node: { role: "gateway", id: "gateway" },
      sourceGeneration: 1,
      radio: receiverRadio,
      clock,
      picture
    });
    newSource.submit(positionPublication(2), { operationID: "new-state" });
    await clock.runUntilIdle();
    oldSource.submit(positionPublication(1), { operationID: "old-state" });
    await clock.runUntilIdle();
    expect(picture.snapshot().records[0]?.atlas_version).toBe(2);
    expect(receiver.metrics().stale_messages_rejected).toBeGreaterThan(0);
  });

  it("uses a Gateway activation announcement to fence delayed Asset traffic", async () => {
    const clock = new VirtualClock();
    const network = new SimulatedPacketNetwork({ seed: 9, clock });
    const gatewayRadio = network.addRadio("gateway", 10);
    const oldAssetRadio = network.addRadio("old-asset", 20);
    const receiverRadio = network.addRadio("receiver", 30);
    network.connect("gateway", "receiver");
    network.connect("old-asset", "receiver");
    const gateway = new LinkTransport({
      node: { role: "gateway", id: "gateway" },
      sourceGeneration: 1,
      serviceSession: "gateway-session",
      radio: gatewayRadio,
      clock
    });
    const oldAsset = new LinkTransport({
      node: { role: "asset", id: "asset-alpha" },
      sourceGeneration: 1,
      serviceSession: "old-session",
      radio: oldAssetRadio,
      clock
    });
    const picture = new SharedPicture("receiver-picture");
    const receiver = new LinkTransport({
      node: { role: "asset", id: "asset-bravo" },
      sourceGeneration: 1,
      radio: receiverRadio,
      clock,
      picture
    });
    gateway.announceSourceActivation({ role: "asset", id: "asset-alpha" }, 2, "new-session");
    await clock.runUntilIdle();
    oldAsset.submit(positionPublication(1), { operationID: "delayed-old-state" });
    await clock.runUntilIdle();
    expect(picture.snapshot().records).toHaveLength(0);
    expect(receiver.metrics().stale_messages_rejected).toBeGreaterThan(0);
  });

  it("schedules Task traffic ahead of queued Object chunks", async () => {
    const { clock, gateway, asset } = directPair();
    const sent: string[] = [];
    const content = Buffer.alloc(512, 1);
    gateway.onEvent((event) => {
      if (event.type === "packet_sent") sent.push(event.operation_id);
    });
    gateway.submit(
      {
        type: "object_content",
        object_id: "object-1",
        content_base64: content.toString("base64"),
        sha256: `sha256:${createHash("sha256").update(content).digest("hex")}`
      },
      { destination: { role: "asset", id: "asset-alpha" }, operationID: "object" }
    );
    await clock.advanceBy(0);
    gateway.submit(
      { type: "task_delivery", delivery: "assignment", task: pendingTask("task-urgent", "2026-09-02T12:00:00Z") },
      { destination: { role: "asset", id: "asset-alpha" }, operationID: "task" }
    );
    asset.onEvent((event) => {
      if (event.type === "message" && event.requires_settlement) asset.settleInbound(event.settlement_id, true);
    });
    await clock.runUntilIdle();
    const taskIndex = sent.indexOf("task");
    expect(sent[0]).toBe("object");
    expect(taskIndex).toBeGreaterThan(0);
    expect(taskIndex).toBeLessThan(sent.lastIndexOf("object"));
    expect(gateway.status("task")?.status).toBe("confirmed");
    expect(gateway.status("object")?.status).toBe("confirmed");
  });

  it("dispatches confirmed assignments in Atlas Task order", async () => {
    const { clock, gateway, asset } = directPair();
    const delivered: string[] = [];
    asset.onEvent((event) => {
      if (event.type === "message" && event.addressed_to_local && event.message.type === "task_delivery") {
        delivered.push(event.message.task.task_id);
        asset.settleInbound(event.settlement_id, true);
      }
    });
    const dispatcher = new OrderedTaskDispatcher(gateway);
    dispatcher.enqueueAssignments("asset-alpha", [
      pendingTask("task-z", "2026-09-02T12:01:00Z"),
      pendingTask("task-b", "2026-09-02T12:00:00Z"),
      pendingTask("task-a", "2026-09-02T12:00:00Z")
    ]);
    await clock.runUntilIdle();
    expect(delivered).toEqual(["task-a", "task-b", "task-z"]);
    expect(dispatcher.state("asset-alpha")).toEqual({ queued: [] });
    dispatcher.close();
  });

  it("keeps an assignment queued when Link admission fails", () => {
    const clock = new VirtualClock();
    const network = new SimulatedPacketNetwork({ seed: 23, clock });
    const gateway = new LinkTransport({
      node: { role: "gateway", id: "gateway" },
      sourceGeneration: 1,
      radio: network.addRadio("gateway", 1),
      clock,
      queueLimit: 1
    });
    gateway.submit(positionPublication(1), { operationID: "occupy-queue" });
    const dispatcher = new OrderedTaskDispatcher(gateway);
    dispatcher.enqueueAssignments("asset-alpha", [pendingTask("task-retained", "2026-09-02T12:00:00Z")]);
    expect(dispatcher.state("asset-alpha")).toEqual({ queued: ["task-retained"] });
    dispatcher.close();
  });

  it("retries retained Task admission when transport capacity becomes available", async () => {
    const clock = new VirtualClock();
    const network = new SimulatedPacketNetwork({ seed: 53, clock });
    const gatewayRadio = network.addRadio("gateway", 1);
    const assetRadio = network.addRadio("asset-alpha", 2);
    network.connect("gateway", "asset-alpha");
    const gateway = new LinkTransport({
      node: { role: "gateway", id: "gateway" },
      sourceGeneration: 1,
      radio: gatewayRadio,
      clock,
      queueLimit: 1
    });
    const asset = new LinkTransport({
      node: { role: "asset", id: "asset-alpha" },
      sourceGeneration: 1,
      radio: assetRadio,
      clock
    });
    const delivered: string[] = [];
    asset.onEvent((event) => {
      if (event.type !== "message" || event.message.type !== "task_delivery") return;
      delivered.push(event.message.task.task_id);
      asset.settleInbound(event.settlement_id, true);
    });
    gateway.submit(positionPublication(1), { operationID: "occupy-capacity" });
    const dispatcher = new OrderedTaskDispatcher(gateway);
    dispatcher.enqueueAssignments("asset-alpha", [pendingTask("task-retained", "2026-09-02T12:00:00Z")]);
    await clock.runUntilIdle();
    expect(delivered).toEqual(["task-retained"]);
    expect(dispatcher.state("asset-alpha")).toEqual({ queued: [] });
    dispatcher.close();
  });

  it("retries a stable operation ID after a transient local admission failure", async () => {
    const clock = new VirtualClock();
    const network = new SimulatedPacketNetwork({ seed: 52, clock });
    const transport = new LinkTransport({
      node: { role: "gateway", id: "gateway" },
      sourceGeneration: 1,
      radio: network.addRadio("gateway", 1),
      clock,
      queueLimit: 1
    });
    transport.submit(positionPublication(1), { operationID: "occupy" });
    const task = {
      type: "task_delivery",
      delivery: "assignment",
      task: pendingTask("task-retry", "2026-09-02T12:00:00Z")
    } as const;
    expect(
      transport.submit(task, { destination: { role: "asset", id: "asset-alpha" }, operationID: "stable-retry" })
    ).toMatchObject({ status: "failed", reason: "outbound queue capacity is exhausted" });
    await clock.advanceBy(10_000);
    expect(
      transport.submit(task, { destination: { role: "asset", id: "asset-alpha" }, operationID: "stable-retry" })
    ).toMatchObject({ status: "queued" });
    transport.stop();
  });

  it("retires an in-flight assignment before sending its cancellation", async () => {
    const { clock, gateway, asset } = directPair();
    const delivered: string[] = [];
    asset.onEvent((event) => {
      if (event.type !== "message" || event.message.type !== "task_delivery" || !event.addressed_to_local) return;
      delivered.push(event.message.delivery);
      asset.settleInbound(event.settlement_id, true);
    });
    const dispatcher = new OrderedTaskDispatcher(gateway);
    const assignment = pendingTask("task-cancel-in-flight", "2026-09-02T12:00:00Z");
    dispatcher.enqueue("asset-alpha", assignment);
    await clock.advanceBy(0);
    dispatcher.enqueue("asset-alpha", cancelledTask(assignment.task_id, assignment.created_at), "cancellation");
    await clock.runUntilIdle();
    expect(delivered).toEqual(["cancellation"]);
    dispatcher.close();
  });

  it("removes cancelled and terminal Tasks from the assignment queue", async () => {
    const { clock, gateway, asset } = directPair();
    const deliveries: Array<{ delivery: string; taskID: string }> = [];
    asset.onEvent((event) => {
      if (event.type !== "message" || event.message.type !== "task_delivery" || !event.addressed_to_local) return;
      deliveries.push({ delivery: event.message.delivery, taskID: event.message.task.task_id });
      asset.settleInbound(event.settlement_id, true);
    });
    const dispatcher = new OrderedTaskDispatcher(gateway);
    const first = pendingTask("task-first", "2026-09-02T12:00:00Z");
    const cancelled = cancelledTask("task-cancelled", "2026-09-02T12:01:00Z");
    const terminal = cancelledTask("task-terminal", "2026-09-02T12:03:00Z");
    dispatcher.enqueueAssignments("asset-alpha", [first, cancelled, terminal]);
    dispatcher.enqueue("asset-alpha", cancelled, "cancellation");
    dispatcher.observeAuthoritativeTask("asset-alpha", terminal);
    expect(dispatcher.state("asset-alpha")).toEqual({ in_flight: "task-first", queued: [] });

    await clock.runUntilIdle();

    expect(deliveries).toContainEqual({ delivery: "assignment", taskID: "task-first" });
    expect(deliveries).toContainEqual({ delivery: "cancellation", taskID: "task-cancelled" });
    expect(deliveries).not.toContainEqual({ delivery: "assignment", taskID: "task-cancelled" });
    expect(deliveries).not.toContainEqual({ delivery: "assignment", taskID: "task-terminal" });
    dispatcher.close();
  });

  it("does not assemble Object content at an unaddressed listener", async () => {
    const clock = new VirtualClock();
    const network = new SimulatedPacketNetwork({ seed: 24, clock });
    const gatewayRadio = network.addRadio("gateway", 1);
    const destinationRadio = network.addRadio("asset-alpha", 2);
    const listenerRadio = network.addRadio("asset-bravo", 3);
    network.connect("gateway", "asset-alpha");
    network.connect("gateway", "asset-bravo");
    const gateway = new LinkTransport({
      node: { role: "gateway", id: "gateway" },
      sourceGeneration: 1,
      radio: gatewayRadio,
      clock
    });
    const destination = new LinkTransport({
      node: { role: "asset", id: "asset-alpha" },
      sourceGeneration: 1,
      radio: destinationRadio,
      clock
    });
    const listener = new LinkTransport({
      node: { role: "asset", id: "asset-bravo" },
      sourceGeneration: 1,
      radio: listenerRadio,
      clock
    });
    let receivedAtDestination = false;
    let receivedAtListener = false;
    destination.onEvent((event) => {
      if (event.type === "message" && event.message.type === "object_content") {
        receivedAtDestination = true;
        destination.settleInbound(event.settlement_id, true);
      }
    });
    listener.onEvent((event) => {
      if (event.type === "message" && event.message.type === "object_content") receivedAtListener = true;
    });
    const content = Buffer.alloc(1_024, 2);
    gateway.submit(
      {
        type: "object_content",
        object_id: "object-private",
        content_base64: content.toString("base64"),
        sha256: `sha256:${createHash("sha256").update(content).digest("hex")}`
      },
      { destination: { role: "asset", id: "asset-alpha" }, operationID: "object-private" }
    );
    await clock.runUntilIdle();
    expect(receivedAtDestination).toBe(true);
    expect(receivedAtListener).toBe(false);
    expect(listener.diagnostics().incomplete_reassemblies).toBe(0);
    expect(gateway.status("object-private")?.status).toBe("confirmed");
  });

  it("puts a state-bearing response into every listening Shared Picture", async () => {
    const clock = new VirtualClock();
    const network = new SimulatedPacketNetwork({ seed: 27, clock });
    const gatewayRadio = network.addRadio("gateway", 1);
    const requesterRadio = network.addRadio("asset-alpha", 2);
    const peerRadio = network.addRadio("asset-bravo", 3);
    network.connect("gateway", "asset-alpha");
    network.connect("gateway", "asset-bravo");
    const requesterPicture = new SharedPicture("requester-picture");
    const peerPicture = new SharedPicture("peer-picture");
    const gateway = new LinkTransport({
      node: { role: "gateway", id: "gateway" },
      sourceGeneration: 1,
      radio: gatewayRadio,
      clock
    });
    const requester = new LinkTransport({
      node: { role: "asset", id: "asset-alpha" },
      sourceGeneration: 1,
      radio: requesterRadio,
      clock,
      picture: requesterPicture
    });
    const peer = new LinkTransport({
      node: { role: "asset", id: "asset-bravo" },
      sourceGeneration: 1,
      radio: peerRadio,
      clock,
      picture: peerPicture
    });
    requester.onEvent((event) => {
      if (event.type === "message" && event.message.type === "data_response" && event.addressed_to_local) {
        requester.settleInbound(event.settlement_id, true);
      }
    });
    const state = positionPublication(7);
    if (state.resource_type !== "entity") throw new Error("position fixture must be an Entity");
    gateway.submit(
      { type: "data_response", request_id: "entity-request", operation: "entity.get", output: state.resource },
      { destination: { role: "asset", id: "asset-alpha" }, operationID: "entity-response" }
    );
    await clock.runUntilIdle();
    expect(requesterPicture.snapshot().records[0]).toMatchObject({ id: "asset-alpha", atlas_version: 7 });
    expect(peerPicture.snapshot().records[0]).toMatchObject({ id: "asset-alpha", atlas_version: 7 });
    expect(peer.diagnostics().inbound_awaiting_settlement).toBe(0);
    expect(gateway.status("entity-response")?.status).toBe("confirmed");
  });

  it("retains a changed-since deletion fence even when the record was absent", async () => {
    const { clock, gateway, asset, assetPicture } = directPair();
    asset.onEvent((event) => {
      if (event.type === "message" && event.requires_settlement) asset.settleInbound(event.settlement_id, true);
    });
    gateway.submit(
      {
        type: "data_response",
        request_id: "changes",
        operation: "query.changed_since",
        output: {
          events: [{ event: "delete", id: "asset-alpha", resource_type: "entity", version: 2 }],
          version: 2,
          has_more: false
        }
      },
      { destination: { role: "asset", id: "asset-alpha" }, operationID: "changes-response" }
    );
    await clock.runUntilIdle();
    gateway.submit(positionPublication(1), { operationID: "stale-after-delete" });
    await clock.runUntilIdle();
    expect(assetPicture.snapshot().records).toEqual([]);
    expect(gateway.status("changes-response")?.status).toBe("confirmed");
  });

  it("projects visible Task lifecycle reports into a peer Shared Picture", async () => {
    const clock = new VirtualClock(Date.parse("2026-09-02T12:00:00Z"));
    const network = new SimulatedPacketNetwork({ seed: 31, clock });
    const gatewayRadio = network.addRadio("gateway", 1);
    const assetRadio = network.addRadio("asset-alpha", 2);
    const peerRadio = network.addRadio("asset-bravo", 3);
    network.connect("gateway", "asset-alpha");
    network.connect("gateway", "asset-bravo");
    network.connect("asset-alpha", "asset-bravo");
    const gateway = new LinkTransport({
      node: { role: "gateway", id: "gateway" },
      sourceGeneration: 1,
      radio: gatewayRadio,
      clock
    });
    const asset = new LinkTransport({
      node: { role: "asset", id: "asset-alpha" },
      sourceGeneration: 1,
      radio: assetRadio,
      clock
    });
    const peerPicture = new SharedPicture("peer-picture");
    const peer = new LinkTransport({
      node: { role: "asset", id: "asset-bravo" },
      sourceGeneration: 1,
      radio: peerRadio,
      clock,
      picture: peerPicture
    });
    asset.onEvent((event) => {
      if (event.type !== "message" || event.message.type !== "task_delivery" || !event.addressed_to_local) return;
      asset.settleInbound(event.settlement_id, true);
      asset.submit(
        {
          type: "task_report",
          action: "complete",
          task_id: event.message.task.task_id,
          runtime_id: "runtime-alpha",
          body: { output: { surveyed: true } }
        },
        { destination: { role: "gateway", id: "gateway" }, operationID: "complete-task-visible" }
      );
    });
    gateway.onEvent((event) => {
      if (event.type === "message" && event.message.type === "task_report" && event.addressed_to_local) {
        gateway.settleInbound(event.settlement_id, true);
      }
    });
    gateway.submit(
      { type: "task_delivery", delivery: "assignment", task: pendingTask("task-visible", "2026-09-02T12:00:00Z") },
      { destination: { role: "asset", id: "asset-alpha" }, operationID: "deliver-task-visible" }
    );
    await clock.runUntilIdle();
    expect(peerPicture.snapshot().records).toContainEqual(
      expect.objectContaining({
        id: "task-visible",
        source: { role: "asset", id: "asset-alpha" },
        confirmation: "awaiting_core",
        state: expect.objectContaining({ status: "completed", output: { surveyed: true } })
      })
    );
    expect(peer.diagnostics().inbound_awaiting_settlement).toBe(0);
  });
});

function directPair(): {
  clock: VirtualClock;
  gateway: LinkTransport;
  asset: LinkTransport;
  assetPicture: SharedPicture;
} {
  const clock = new VirtualClock();
  const network = new SimulatedPacketNetwork({ seed: 42, clock });
  const gatewayRadio = network.addRadio("gateway", 1);
  const assetRadio = network.addRadio("asset-alpha", 2);
  network.connect("gateway", "asset-alpha");
  const assetPicture = new SharedPicture("asset-picture");
  return {
    clock,
    gateway: new LinkTransport({
      node: { role: "gateway", id: "gateway" },
      sourceGeneration: 1,
      radio: gatewayRadio,
      clock
    }),
    asset: new LinkTransport({
      node: { role: "asset", id: "asset-alpha" },
      sourceGeneration: 1,
      radio: assetRadio,
      clock,
      picture: assetPicture
    }),
    assetPicture
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
    finished_at: "2026-09-02T12:05:00Z",
    status: "cancelled",
    updated_at: "2026-09-02T12:05:00Z"
  };
}

type ControlledTimer = {
  handle: TimerHandle;
  at: number;
  callback: () => void | Promise<void>;
};

class ControlledClock implements Clock {
  private current = 0;
  private readonly timers: ControlledTimer[] = [];

  now(): number {
    return this.current;
  }

  schedule(delayMs: number, callback: () => void | Promise<void>): TimerHandle {
    const handle = {};
    this.timers.push({ handle, at: this.current + delayMs, callback });
    return handle;
  }

  cancel(handle: TimerHandle): void {
    const index = this.timers.findIndex((timer) => timer.handle === handle);
    if (index >= 0) this.timers.splice(index, 1);
  }

  fireAt(at: number): Promise<void>[] {
    this.current = at;
    const due = this.timers.filter((timer) => timer.at <= at);
    for (const timer of due) this.cancel(timer.handle);
    return due.map((timer) => Promise.resolve(timer.callback()));
  }
}

class DeferredFirstSendRadio implements LinkRadio {
  readonly max_payload_bytes = 233;
  sendCount = 0;
  private firstSendResolution: (() => void) | undefined;
  private readonly handlers = new Set<(packet: RadioPacket) => void>();

  send(_payload: Uint8Array, _options: RadioSendOptions): Promise<void> {
    this.sendCount++;
    if (this.sendCount > 1) return Promise.resolve();
    return new Promise((resolve) => {
      this.firstSendResolution = resolve;
    });
  }

  resolveFirstSend(): void {
    this.firstSendResolution?.();
  }

  onPacket(handler: (packet: RadioPacket) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  receive(packet: RadioPacket): void {
    for (const handler of this.handlers) handler(packet);
  }

  async close(): Promise<void> {}
}

class FailingFirstSendRadio implements LinkRadio {
  readonly max_payload_bytes = 233;
  readonly attemptedOperations: string[] = [];
  private readonly handlers = new Set<(packet: RadioPacket) => void>();

  async send(payload: Uint8Array, _options: RadioSendOptions): Promise<void> {
    this.attemptedOperations.push(decodeFrame(payload).operation_id);
    if (this.attemptedOperations.length === 1) throw new Error("temporary serial failure");
  }

  onPacket(handler: (packet: RadioPacket) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async close(): Promise<void> {}
}
