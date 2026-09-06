import { describe, expect, it } from "vitest";
import { VirtualClock } from "./clock.js";
import { deserializeLinkMessage, serializeLinkMessage } from "./contract.js";
import { decodeFrame, type FrameIdentity, fragmentPayload } from "./frame.js";
import { SharedPicture } from "./picture.js";
import type { LinkRadio, RadioPacket, RadioSendOptions } from "./radio.js";
import { LinkTransport } from "./transport.js";
import type { TaskReport } from "./types.js";

describe("deflate-v3 compound receipts", () => {
  it("combines an unstarted one-frame Task report with its confirmed receipt", async () => {
    const { clock, gateway, asset, gatewayRadio, assetRadio, taskFrame } = await joinedPair();
    const assetEvents: string[] = [];
    const packetEvents: string[] = [];
    gateway.onEvent((event) => {
      if (event.type === "message" && event.message.type === "task_report" && event.addressed_to_local) {
        gateway.settleInbound(event.settlement_id, true);
      }
    });
    asset.onEvent((event) => {
      if (event.type === "message" && event.message.type === "task_delivery") {
        expect(asset.settleInbound(event.settlement_id, true)).toBe(true);
        expect(
          asset.submit(report("task-1"), {
            destination: { role: "gateway", id: "gateway" },
            operationID: "report-1"
          }).status
        ).toBe("queued");
      }
      if (event.type === "operation") assetEvents.push(`${event.result.operation_id}:${event.result.status}`);
      if (event.type === "packet_sent") packetEvents.push(event.operation_id);
    });

    assetRadio.receive(taskFrame);
    await clock.advanceBy(0);

    expect(assetRadio.sends).toHaveLength(1);
    const combined = decodeFrame(assetRadio.sends[0]!.payload);
    expect(combined.message_type).toBe("task_report");
    expect(combined.receipt).toEqual({ operation_id: "deliver-1", message_id: "gateway-id" });
    expect(assetRadio.sends[0]!.options).toMatchObject({ priority: "safety", request_id: 71 });
    expect(assetEvents).toContain("control_id-1:sent");
    expect(packetEvents).toEqual(["report-1"]);
    expect(asset.metrics().packets_sent).toBe(1);

    gatewayRadio.receive({
      payload: assetRadio.sends[0]!.payload,
      received_at: clock.now(),
      radio_source: 2,
      radio_packet_id: 72,
      channel: 1,
      public_key_encrypted: false
    });
    await clock.advanceBy(0);

    expect(gateway.status("deliver-1")?.status).toBe("confirmed");
    expect(gatewayRadio.sends).toHaveLength(2);
    expect(assetRadio.sends[0]!.payload).not.toEqual(gatewayRadio.sends[0]!.payload);
    expect(asset.status("report-1")?.status).toBe("queued");
  });

  it("leaves the receipt and report standalone when the compound frame does not fit", async () => {
    const { clock, asset, assetRadio, taskFrame } = await joinedPair(150);
    asset.onEvent((event) => {
      if (event.type !== "message" || event.message.type !== "task_delivery") return;
      asset.settleInbound(event.settlement_id, true);
      asset.submit(largeReport("task-1"), {
        destination: { role: "gateway", id: "gateway" },
        operationID: "report-1"
      });
    });

    assetRadio.receive(taskFrame);
    await clock.advanceBy(0);

    const frames = assetRadio.sends.map(({ payload }) => decodeFrame(payload));
    expect(assetRadio.sends.every(({ payload }) => payload[0] === 0xa3)).toBe(true);
    expect(frames.every((frame) => frame.receipt === undefined)).toBe(true);
    const messages = ["control", "task_report"].map((type) => {
      const chunks = frames
        .filter((frame) => frame.message_type === type)
        .sort((a, b) => a.chunk_index - b.chunk_index);
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks.length).toBe(chunks[0]?.chunk_count);
      return deserializeLinkMessage(Buffer.concat(chunks.map((frame) => frame.payload)));
    });
    expect(messages).toEqual([
      expect.objectContaining({ type: "control", control: "confirmed" }),
      largeReport("task-1")
    ]);
  });

  it("does not pair a report that has already started", async () => {
    const { clock, asset, assetRadio, taskFrame, deferred } = await joinedPair(233, true);
    let settlementID: string | undefined;
    asset.onEvent((event) => {
      if (event.type !== "message" || event.message.type !== "task_delivery") return;
      settlementID = event.settlement_id;
      asset.submit(report("task-1"), {
        destination: { role: "gateway", id: "gateway" },
        operationID: "report-1"
      });
    });
    assetRadio.onSend = () => {
      if (settlementID !== undefined) {
        expect(asset.settleInbound(settlementID, true)).toBe(true);
        settlementID = undefined;
      }
    };

    assetRadio.receive(taskFrame);
    const pumping = clock.advanceBy(0);
    await assetRadio.sendStarted;
    expect(assetRadio.sends).toHaveLength(1);
    expect(assetRadio.sends.every(({ payload }) => decodeFrame(payload).receipt === undefined)).toBe(true);
    deferred.resolve();
    await pumping;
    await clock.advanceBy(0);

    expect(assetRadio.sends).toHaveLength(2);
    expect(assetRadio.sends.every(({ payload }) => decodeFrame(payload).receipt === undefined)).toBe(true);
    expect(assetRadio.sends.every(({ payload }) => payload[0] === 0xa3)).toBe(true);
  });

  it("keeps the embedded receipt on report retries and processes it before report rejection", async () => {
    const gatewayPicture = new SharedPicture("gateway-picture");
    const { clock, gateway, asset, gatewayRadio, assetRadio, taskFrame } = await joinedPair(233, false, gatewayPicture);
    gatewayPicture.apply(
      {
        type: "state",
        resource_type: "task",
        resource: { ...pendingTask("task-other"), asset_id: "asset-bravo" },
        observation_time: "2026-09-02T12:00:00Z",
        path: "gateway_feed",
        confirmation: "core_confirmed"
      },
      {
        source: { role: "gateway", id: "gateway" },
        source_generation: 1,
        service_session: gateway.serviceSession,
        source_sequence: 1,
        received_at: clock.now()
      }
    );
    asset.onEvent((event) => {
      if (event.type !== "message" || event.message.type !== "task_delivery") return;
      asset.settleInbound(event.settlement_id, true);
      asset.submit(report("task-other"), {
        destination: { role: "gateway", id: "gateway" },
        operationID: "report-1"
      });
    });
    gateway.onEvent((event) => {
      if (event.type === "message" && event.message.type === "task_report")
        gateway.settleInbound(event.settlement_id, false);
    });

    assetRadio.receive(taskFrame);
    await clock.advanceBy(0);
    const combined = assetRadio.sends[0]!;
    gatewayRadio.receive({
      payload: combined.payload,
      received_at: clock.now(),
      radio_source: 2,
      channel: 1,
      public_key_encrypted: false
    });
    await clock.advanceBy(0);

    expect(gateway.status("deliver-1")?.status).toBe("confirmed");
    expect(gateway.diagnostics().inbound_awaiting_settlement).toBe(0);
    expect(gatewayRadio.sends).toHaveLength(2);
    expect(assetRadio.sends[0]!.options.request_id).toBe(71);
    await clock.advanceBy(5_000);
    expect(assetRadio.sends[1]).toBeDefined();
    expect(decodeFrame(assetRadio.sends[1]!.payload).receipt).toEqual(decodeFrame(combined.payload).receipt);
  });

  it("sends a standalone receipt when a compound send is rejected after report cancellation", async () => {
    const { clock, asset, assetRadio, taskFrame, deferred } = await joinedPair(233, true);
    let cancelDuringSend = false;
    asset.onEvent((event) => {
      if (event.type !== "message" || event.message.type !== "task_delivery") return;
      asset.settleInbound(event.settlement_id, true);
      asset.submit(report("task-1"), {
        destination: { role: "gateway", id: "gateway" },
        operationID: "report-1"
      });
      cancelDuringSend = true;
    });
    assetRadio.onSend = (entry) => {
      if (!cancelDuringSend || entry.payload[0] !== 0xa4) return;
      cancelDuringSend = false;
      expect(asset.cancel("report-1")).toBe(true);
    };

    assetRadio.receive(taskFrame);
    const pumping = clock.advanceBy(0);
    await assetRadio.sendStarted;
    expect(assetRadio.sends).toHaveLength(1);
    deferred.reject(new Error("queue rejected"));
    await pumping;
    await clock.advanceBy(0);

    expect(asset.status("report-1")?.status).toBe("failed");
    expect(assetRadio.sends).toHaveLength(2);
    expect(deserializeLinkMessage(decodeFrame(assetRadio.sends[1]!.payload).payload)).toMatchObject({
      type: "control",
      control: "confirmed"
    });
  });

  it("finishes the receipt when the report is canceled after successful compound admission", async () => {
    const { clock, asset, assetRadio, taskFrame, deferred } = await joinedPair(233, true);
    const outcomes: string[] = [];
    let cancelDuringSend = false;
    asset.onEvent((event) => {
      if (event.type === "operation") outcomes.push(`${event.result.operation_id}:${event.result.status}`);
      if (event.type !== "message" || event.message.type !== "task_delivery") return;
      asset.settleInbound(event.settlement_id, true);
      asset.submit(report("task-1"), {
        destination: { role: "gateway", id: "gateway" },
        operationID: "report-1"
      });
      cancelDuringSend = true;
    });
    assetRadio.onSend = (entry) => {
      if (!cancelDuringSend || entry.payload[0] !== 0xa4) return;
      cancelDuringSend = false;
      expect(asset.cancel("report-1")).toBe(true);
    };

    assetRadio.receive(taskFrame);
    const pumping = clock.advanceBy(0);
    await assetRadio.sendStarted;
    expect(assetRadio.sends).toHaveLength(1);
    deferred.resolve();
    await pumping;
    await clock.advanceBy(0);

    expect(asset.status("report-1")?.status).toBe("failed");
    expect(outcomes).toContain("report-1:failed");
    expect(outcomes).toContain("control_id-1:sent");
    expect(assetRadio.sends).toHaveLength(1);
    expect(asset.metrics().packets_sent).toBe(1);
  });

  it("does not process the report after its compound receipt callback stops the receiver", async () => {
    const { clock, gateway, asset, gatewayRadio, assetRadio, taskFrame } = await joinedPair();
    asset.onEvent((event) => {
      if (event.type !== "message" || event.message.type !== "task_delivery") return;
      asset.settleInbound(event.settlement_id, true);
      asset.submit(report("task-1"), {
        destination: { role: "gateway", id: "gateway" },
        operationID: "report-1"
      });
    });
    gateway.onEvent((event) => {
      if (event.type === "operation" && event.result.operation_id === "deliver-1")
        gateway.stop("receipt callback stop");
    });

    assetRadio.receive(taskFrame);
    await clock.advanceBy(0);
    const combined = assetRadio.sends[0];
    if (!combined) throw new Error("compound report was not sent");
    gatewayRadio.receive({
      payload: combined.payload,
      received_at: clock.now(),
      radio_source: 2,
      channel: 1,
      public_key_encrypted: false
    });
    await clock.advanceBy(0);

    expect(gateway.status("deliver-1")?.status).toBe("confirmed");
    expect(gateway.diagnostics()).toMatchObject({ stopped: true, inbound_awaiting_settlement: 0 });
  });

  it("does not resurrect a fragmented operation canceled from its packet event", async () => {
    const clock = new VirtualClock();
    const radio = new CaptureRadio(233, false);
    const transport = new LinkTransport({
      node: { role: "asset", id: "asset-alpha" },
      sourceGeneration: 1,
      serviceSession: "asset-session",
      radio,
      clock,
      frameEncoding: "deflate-v3",
      createID: () => "report-frame"
    });
    let packetEvents = 0;
    transport.onEvent((event) => {
      if (event.type !== "packet_sent") return;
      packetEvents++;
      expect(transport.cancel("report-1")).toBe(true);
    });
    try {
      expect(
        transport.submit(largeReport("task-1"), {
          destination: { role: "gateway", id: "gateway" },
          operationID: "report-1"
        }).status
      ).toBe("queued");
      await clock.advanceBy(0);

      expect(packetEvents).toBe(1);
      expect(radio.sends).toHaveLength(1);
      expect(transport.status("report-1")?.status).toBe("failed");
      expect(transport.diagnostics().queue_depth).toBe(0);
    } finally {
      transport.stop();
    }
  });

  it("fails both paired operations on stop without requeueing", async () => {
    const { clock, asset, assetRadio, taskFrame, deferred } = await joinedPair(233, true);
    const outcomes: string[] = [];
    asset.onEvent((event) => {
      if (event.type === "operation") outcomes.push(`${event.result.operation_id}:${event.result.status}`);
      if (event.type !== "message" || event.message.type !== "task_delivery") return;
      asset.settleInbound(event.settlement_id, true);
      asset.submit(report("task-1"), {
        destination: { role: "gateway", id: "gateway" },
        operationID: "report-1"
      });
    });
    assetRadio.onSend = () => asset.stop("test stop");

    assetRadio.receive(taskFrame);
    const pumping = clock.advanceBy(0);
    await assetRadio.sendStarted;
    deferred.resolve();
    await pumping;
    await clock.advanceBy(0);

    expect(asset.diagnostics().stopped).toBe(true);
    expect(assetRadio.sends).toHaveLength(1);
    expect(outcomes).toContain("report-1:failed");
    expect(outcomes).toContain("control_id-1:failed");
  });

  it("requires the receipt reference to match the original operation and message", async () => {
    const { clock, gateway, gatewayRadio, taskFrame } = await joinedPair();
    const original = decodeFrame(taskFrame.payload);
    const reportIdentity: FrameIdentity = {
      revision: 1,
      message_type: "task_report",
      source: { role: "asset", id: "asset-alpha" },
      destination: { role: "gateway", id: "gateway" },
      source_generation: 1,
      service_session: "asset-session",
      source_sequence: 1,
      operation_id: "report-1",
      message_id: "report-frame",
      priority: "task",
      receipt: { operation_id: "deliver-1", message_id: "wrong-message" }
    };
    const reportFrame = fragmentPayload(serializeLinkMessage(report("task-1")), reportIdentity, 233, "deflate-v3")[0]!;
    gatewayRadio.receive({
      payload: reportFrame,
      received_at: clock.now(),
      radio_source: 2,
      channel: 1,
      public_key_encrypted: false
    });
    await clock.advanceBy(0);

    expect(original.message_id).toBe("gateway-id");
    expect(gateway.status("deliver-1")?.status).toBe("queued");
  });

  it("requires an asset source and rejects receipts from stale generations", async () => {
    const { clock, gateway, gatewayRadio } = await joinedPair();
    const makeReportFrame = (source: { role: "asset"; id: string }, generation: number, operationID: string) =>
      fragmentPayload(
        serializeLinkMessage(report("task-1")),
        {
          revision: 1,
          message_type: "task_report",
          source,
          destination: { role: "gateway", id: "gateway" },
          source_generation: generation,
          service_session: `${source.id}-session`,
          source_sequence: generation,
          operation_id: `report-${operationID}`,
          message_id: `report-${operationID}`,
          priority: "task",
          receipt: { operation_id: operationID, message_id: "gateway-id" }
        },
        233,
        "deflate-v3"
      )[0]!;

    gatewayRadio.receive({
      payload: makeReportFrame({ role: "asset", id: "asset-bravo" }, 1, "deliver-1"),
      received_at: clock.now(),
      radio_source: 2,
      channel: 1,
      public_key_encrypted: false
    });
    await clock.advanceBy(0);
    expect(gateway.status("deliver-1")?.status).toBe("queued");

    gateway.submit(
      { type: "task_delivery", delivery: "assignment", task: pendingTask("task-2") },
      { destination: { role: "asset", id: "asset-alpha" }, operationID: "deliver-2" }
    );
    await clock.advanceBy(0);
    gatewayRadio.receive({
      payload: makeReportFrame({ role: "asset", id: "asset-alpha" }, 2, "deliver-1"),
      received_at: clock.now(),
      radio_source: 2,
      channel: 1,
      public_key_encrypted: false
    });
    await clock.advanceBy(0);
    expect(gateway.status("deliver-1")?.status).toBe("confirmed");

    gatewayRadio.receive({
      payload: makeReportFrame({ role: "asset", id: "asset-alpha" }, 1, "deliver-2"),
      received_at: clock.now(),
      radio_source: 2,
      channel: 1,
      public_key_encrypted: false
    });
    await clock.advanceBy(0);
    expect(gateway.status("deliver-2")?.status).toBe("queued");
  });
});

async function joinedPair(
  requestBudget = 233,
  deferred = false,
  picture?: SharedPicture
): Promise<{
  clock: VirtualClock;
  gateway: LinkTransport;
  asset: LinkTransport;
  gatewayRadio: CaptureRadio;
  assetRadio: CaptureRadio;
  taskFrame: RadioPacket;
  deferred: DeferredSend;
}> {
  const clock = new VirtualClock();
  const gatewayRadio = new CaptureRadio(requestBudget, false);
  const assetRadio = new CaptureRadio(requestBudget, deferred);
  const gateway = new LinkTransport({
    node: { role: "gateway", id: "gateway" },
    sourceGeneration: 1,
    serviceSession: "gateway-session",
    radio: gatewayRadio,
    clock,
    ...(picture === undefined ? {} : { picture }),
    frameEncoding: "deflate-v3",
    createID: () => "gateway-id"
  });
  const asset = new LinkTransport({
    node: { role: "asset", id: "asset-alpha" },
    sourceGeneration: 1,
    serviceSession: "asset-session",
    radio: assetRadio,
    clock,
    frameEncoding: "deflate-v3",
    createID: () => "id-1"
  });
  gateway.submit(
    { type: "task_delivery", delivery: "assignment", task: pendingTask("task-1") },
    { destination: asset.node, operationID: "deliver-1" }
  );
  await clock.advanceBy(0);
  const taskPayload = gatewayRadio.sends[0]?.payload;
  if (!taskPayload) throw new Error("gateway task was not sent");
  const taskFrame: RadioPacket = {
    payload: taskPayload,
    received_at: clock.now(),
    radio_source: 1,
    radio_packet_id: 71,
    channel: 1,
    public_key_encrypted: false
  };
  return {
    clock,
    gateway,
    asset,
    gatewayRadio,
    assetRadio,
    taskFrame,
    deferred: assetRadio.deferred
  };
}

function report(taskID: string): TaskReport {
  return {
    type: "task_report",
    action: "complete",
    task_id: taskID,
    runtime_id: "runtime-alpha",
    observation_time: "2026-09-02T12:00:00Z",
    body: { output: { complete: true } }
  };
}

function largeReport(taskID: string): TaskReport {
  return {
    type: "task_report",
    action: "complete",
    task_id: taskID,
    runtime_id: "runtime-alpha",
    observation_time: "2026-09-02T12:00:00Z",
    body: { output: { complete: true, detail: "x".repeat(500) } }
  };
}

function pendingTask(taskID: string) {
  return {
    asset_id: "asset-alpha",
    command: "atlas.survey",
    created_at: "2026-09-02T12:00:00Z",
    input: {},
    status: "pending" as const,
    task_id: taskID,
    updated_at: "2026-09-02T12:00:00Z"
  };
}

type Capture = { payload: Uint8Array; options: RadioSendOptions };

class CaptureRadio implements LinkRadio {
  readonly max_payload_bytes = 233;
  readonly sends: Capture[] = [];
  readonly deferred: DeferredSend = new DeferredSend();
  readonly sendStarted: Promise<void>;
  onSend: ((entry: Capture) => void) | undefined;
  private resolveSendStarted!: () => void;
  private didSignalSendStarted = false;
  private readonly handlers = new Set<(packet: RadioPacket) => void>();

  constructor(
    private readonly requestBudget: number,
    private readonly deferFirst: boolean
  ) {
    this.sendStarted = new Promise((resolve) => {
      this.resolveSendStarted = resolve;
    });
  }

  maxPayloadBytes(options: RadioSendOptions): number {
    return options.request_id === undefined ? this.max_payload_bytes : this.requestBudget;
  }

  async send(payload: Uint8Array, options: RadioSendOptions): Promise<void> {
    const entry = { payload: payload.slice(), options: { ...options } };
    this.sends.push(entry);
    if (!this.didSignalSendStarted) {
      this.didSignalSendStarted = true;
      this.resolveSendStarted();
    }
    this.onSend?.(entry);
    if (this.deferFirst && this.sends.length === 1) return this.deferred.promise;
  }

  onPacket(handler: (packet: RadioPacket) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  receive(packet: RadioPacket): void {
    for (const handler of this.handlers) handler(packet);
  }

  pacingDelayMs(_payload: Uint8Array): number {
    return 0;
  }

  async close(): Promise<void> {}
}

class DeferredSend {
  readonly promise: Promise<void>;
  private resolvePromise!: () => void;
  private rejectPromise!: (reason: Error) => void;

  constructor() {
    this.promise = new Promise<void>((resolve, reject) => {
      this.resolvePromise = resolve;
      this.rejectPromise = reject;
    });
  }

  resolve(): void {
    this.resolvePromise();
  }

  reject(reason: Error): void {
    this.rejectPromise(reason);
  }
}
