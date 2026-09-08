import type { TaskResource } from "@the-drunken-coder/atlas-sdk";
import { describe, expect, it } from "vitest";
import { VirtualClock } from "./clock.js";
import { decodeFrame, type FrameEncoding } from "./frame.js";
import type { LinkRadio, RadioPacket, RadioSendOptions } from "./radio.js";
import { SimulatedPacketNetwork } from "./simulation.js";
import { positionPublication } from "./test-fixtures.js";
import { LinkTransport } from "./transport.js";
import type { ResourceStatePublication, StatePublication, TaskReport } from "./types.js";

const MESSAGE_FRAME_MARKER = 0xa6;
const DEFLATE_V2_FRAME_MARKER = 0xa3;
const BINARY_FRAME_MARKER = 0xa5;
const METHOD_FRAME_MARKER = 0xa7;
const FRAME_PROFILES = ["message-v1", "message-v2"] as const;

describe("message compression transport", () => {
  it.each(FRAME_PROFILES)(
    "compresses a large confirmed Task delivery and settles it once (%s)",
    async (frameEncoding) => {
      const pair = createPair({ frameEncoding });
      const received: string[] = [];
      pair.receiver.onEvent((event) => {
        if (event.type !== "message" || event.message.type !== "task_delivery") return;
        received.push(event.message.task.task_id);
        pair.receiver.settleInbound(event.settlement_id, true);
      });

      try {
        const operation = largeTaskDelivery("resource-compressed", 700);
        expect(
          pair.sender.submit(operation, { destination: pair.receiver.node, operationID: "resource-compressed" })
        ).toMatchObject({
          status: "queued"
        });
        await pair.clock.runUntilIdle();

        expect(pair.sender.status("resource-compressed")).toMatchObject({ status: "confirmed" });
        expect(received).toEqual(["resource-compressed"]);
        const frames = pair.senderRadio.sent.filter(
          ({ payload }) => decodeFrame(payload).operation_id === "resource-compressed"
        );
        expect(frames.length).toBeGreaterThan(1);
        expectWholeMessageFrames(frames.map(({ payload }) => payload));
      } finally {
        await pair.close();
      }
    }
  );

  it.each(FRAME_PROFILES)(
    "repairs one dropped middle chunk without duplicating application delivery (%s)",
    async (frameEncoding) => {
      const pair = createPair({ frameEncoding, operationID: "resource-repair", chunkIndex: 2 });
      let deliveries = 0;
      pair.receiver.onEvent((event) => {
        if (event.type !== "message" || event.message.type !== "task_delivery") return;
        deliveries++;
        pair.receiver.settleInbound(event.settlement_id, true);
      });

      try {
        const operation = largeTaskDelivery("resource-repair", 700);
        expect(
          pair.sender.submit(operation, { destination: pair.receiver.node, operationID: "resource-repair" })
        ).toMatchObject({
          status: "queued"
        });
        await pair.clock.runUntilIdle();

        expect(pair.dropRadio.dropped).toBe(1);
        expect(pair.dropRadio.droppedChunk).toBe(2);
        expect(pair.receiver.metrics().fragment_repair_requests_sent).toBe(1);
        expect(deliveries).toBe(1);
        expect(pair.sender.status("resource-repair")).toMatchObject({ status: "confirmed" });
        const frames = pair.senderRadio.sent
          .filter(({ payload }) => decodeFrame(payload).operation_id === "resource-repair")
          .map(({ payload }) => payload);
        expect(frames.length).toBeGreaterThan(1);
        expectWholeMessageFrames(frames);
      } finally {
        await pair.close();
      }
    }
  );

  it.each(FRAME_PROFILES)("delivers a compressed full state followed by a state delta (%s)", async (frameEncoding) => {
    const pair = createPair({ direction: "asset-to-gateway", frameEncoding, stateDeltas: true });
    const accepted: StatePublication[] = [];
    pair.receiver.onEvent((event) => {
      if (event.type === "message" && event.message.type === "state") accepted.push(event.message);
    });

    try {
      const first = largeStatePublication(1);
      const second = largeStatePublication(2);
      expect(pair.sender.submit(first, { operationID: "state-1" }).status).toBe("queued");
      await pair.clock.runUntilIdle();
      expect(pair.sender.submit(second, { operationID: "state-2" }).status).toBe("queued");
      await pair.clock.runUntilIdle();

      expect(accepted).toEqual([first, second]);
      const firstFrames = pair.senderRadio.sent
        .filter(({ payload }) => decodeFrame(payload).operation_id === "state-1")
        .map(({ payload }) => payload);
      const secondFrames = pair.senderRadio.sent
        .filter(({ payload }) => decodeFrame(payload).operation_id === "state-2")
        .map(({ payload }) => payload);
      expect(firstFrames.length).toBeGreaterThan(1);
      expectWholeMessageFrames(firstFrames);
      expect(secondFrames).toHaveLength(1);
      if (frameEncoding === "message-v1") expect(secondFrames[0]?.[0]).toBe(DEFLATE_V2_FRAME_MARKER);
    } finally {
      await pair.close();
    }
  });

  it.each(FRAME_PROFILES)("confirms an atomic Task report and receipt under %s", async (frameEncoding) => {
    const pair = createPair({ frameEncoding });
    let settlementID: string | undefined;
    let settlement: ReturnType<LinkTransport["settleInboundWithTaskReport"]> | undefined;
    let reports = 0;
    pair.receiver.onEvent((event) => {
      if (event.type !== "message" || event.message.type !== "task_delivery") return;
      settlementID = event.settlement_id;
      settlement = pair.receiver.settleInboundWithTaskReport(
        event.settlement_id,
        taskReport(event.message.task.task_id),
        pair.sender.node,
        "report-atomic"
      );
    });
    pair.sender.onEvent((event) => {
      if (event.type !== "message" || event.message.type !== "task_report") return;
      reports++;
      pair.sender.settleInbound(event.settlement_id, true);
    });

    try {
      expect(
        pair.sender.submit(
          { type: "task_delivery", delivery: "assignment", task: pendingTask("task-atomic") },
          { destination: pair.receiver.node, operationID: "deliver-atomic" }
        ).status
      ).toBe("queued");
      await pair.clock.runUntilIdle();

      expect(settlementID).toBeDefined();
      expect(settlement).toMatchObject({
        accepted: true,
        receipt: { status: "queued" },
        report: { operation_id: "report-atomic", status: "queued" }
      });
      expect(reports).toBe(1);
      expect(pair.sender.status("deliver-atomic")).toMatchObject({ status: "confirmed" });
      expect(pair.receiver.status("report-atomic")).toMatchObject({ status: "confirmed" });
      const compoundEntry = pair.receiverRadio.sent.find(({ payload }) => {
        const frame = decodeFrame(payload);
        return frame.message_type === "task_report" && frame.receipt !== undefined;
      });
      const compound = compoundEntry === undefined ? undefined : decodeFrame(compoundEntry.payload);
      const supportedMarkers =
        frameEncoding === "message-v1" ? [0xa4, BINARY_FRAME_MARKER] : [0xa4, BINARY_FRAME_MARKER, METHOD_FRAME_MARKER];
      expect(supportedMarkers).toContain(compoundEntry?.payload[0]);
      expect(compound?.receipt).toEqual({ operation_id: "deliver-atomic", message_id: expect.any(String) });
    } finally {
      await pair.close();
    }
  });
});

type PairOptions = {
  frameEncoding: FrameEncoding;
  operationID?: string;
  chunkIndex?: number;
  stateDeltas?: boolean;
  direction?: "gateway-to-asset" | "asset-to-gateway";
};

type Pair = {
  clock: VirtualClock;
  sender: LinkTransport;
  receiver: LinkTransport;
  senderRadio: RecordingRadio;
  receiverRadio: RecordingRadio;
  dropRadio: DropChunkRadio;
  close: () => Promise<void>;
};

function createPair(options: Partial<PairOptions> = {}): Pair {
  const clock = new VirtualClock();
  const network = new SimulatedPacketNetwork({
    seed: 41,
    clock,
    contentionWindowAirtimes: 0,
    propagationDelayMs: 0,
    relayDelayMs: 0
  });
  const senderBase = network.addRadio("gateway", 1);
  const receiverBase = network.addRadio("asset-alpha", 2);
  network.connect("gateway", "asset-alpha");
  const senderRadio = new RecordingRadio(senderBase);
  const dropRadio = new DropChunkRadio(receiverBase, {
    operationID: options.operationID ?? "",
    chunkIndex: options.chunkIndex ?? -1
  });
  const receiverRadio = new RecordingRadio(dropRadio);
  const assetToGateway = options.direction === "asset-to-gateway";
  const sender = new LinkTransport({
    node: assetToGateway ? { role: "asset", id: "asset-alpha" } : { role: "gateway", id: "gateway" },
    sourceGeneration: 1,
    serviceSession: assetToGateway ? "asset-session" : "gateway-session",
    radio: senderRadio,
    clock,
    frameEncoding: options.frameEncoding ?? "message-v1",
    createID: deterministicID(assetToGateway ? "asset" : "gateway"),
    ...(options.stateDeltas === undefined ? {} : { stateDeltas: options.stateDeltas })
  });
  const receiver = new LinkTransport({
    node: assetToGateway ? { role: "gateway", id: "gateway" } : { role: "asset", id: "asset-alpha" },
    sourceGeneration: 1,
    serviceSession: assetToGateway ? "gateway-session" : "asset-session",
    radio: receiverRadio,
    clock,
    frameEncoding: options.frameEncoding ?? "message-v1",
    createID: deterministicID(assetToGateway ? "gateway" : "asset"),
    ...(options.stateDeltas === undefined ? {} : { stateDeltas: options.stateDeltas })
  });
  return {
    clock,
    sender,
    receiver,
    senderRadio,
    receiverRadio,
    dropRadio,
    close: async () => {
      sender.stop();
      receiver.stop();
      await senderRadio.close();
      await receiverRadio.close();
    }
  };
}

function expectWholeMessageFrames(frames: Uint8Array[]): void {
  expect(frames.every((payload) => payload[0] === MESSAGE_FRAME_MARKER)).toBe(true);
}

function largeTaskDelivery(taskID: string, length: number) {
  return {
    type: "task_delivery" as const,
    delivery: "assignment" as const,
    task: pendingTask(taskID, length)
  };
}

function largeStatePublication(version: number): Extract<ResourceStatePublication, { resource_type: "entity" }> {
  const publication = positionPublication(version);
  return {
    ...publication,
    operation_id: `state-${version}`,
    resource: {
      ...publication.resource,
      extra: { detail: entropyText(500) }
    }
  };
}

function pendingTask(taskID: string, detailLength = 0): TaskResource {
  return {
    asset_id: "asset-alpha",
    command: "atlas.survey",
    created_at: "2026-09-02T12:00:00Z",
    input: detailLength === 0 ? {} : { detail: entropyText(detailLength) },
    status: "pending",
    task_id: taskID,
    updated_at: "2026-09-02T12:00:00Z"
  };
}

function taskReport(taskID: string): TaskReport {
  return {
    type: "task_report",
    action: "complete",
    task_id: taskID,
    runtime_id: "runtime-alpha",
    observation_time: "2026-09-02T12:00:00Z",
    body: { output: { complete: true } }
  };
}

function entropyText(length: number): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let state = 0x12345678;
  let result = "";
  for (let index = 0; index < length; index++) {
    state = Math.imul(state, 1_664_525) + 1_013_904_223;
    result += alphabet[(state >>> 0) % alphabet.length];
  }
  return result;
}

function deterministicID(prefix: string): () => string {
  let sequence = 0;
  return () => `${prefix}-${(++sequence).toString(36).padStart(6, "0")}`;
}

class RecordingRadio implements LinkRadio {
  readonly max_payload_bytes: number;
  readonly sent: { payload: Uint8Array; options: RadioSendOptions }[] = [];

  constructor(private readonly radio: LinkRadio) {
    this.max_payload_bytes = radio.max_payload_bytes;
  }

  maxPayloadBytes(options: RadioSendOptions): number {
    return this.radio.maxPayloadBytes?.(options) ?? this.radio.max_payload_bytes;
  }

  pacingDelayMs(payload: Uint8Array): number {
    return this.radio.pacingDelayMs?.(payload) ?? 0;
  }

  async send(payload: Uint8Array, options: RadioSendOptions): Promise<void> {
    this.sent.push({ payload: payload.slice(), options: { ...options } });
    await this.radio.send(payload, options);
  }

  onPacket(handler: (packet: RadioPacket) => void): () => void {
    return this.radio.onPacket(handler);
  }

  onDisconnect(handler: (reason: Error) => void): () => void {
    return this.radio.onDisconnect?.(handler) ?? (() => undefined);
  }

  async close(): Promise<void> {
    await this.radio.close();
  }
}

class DropChunkRadio implements LinkRadio {
  readonly max_payload_bytes: number;
  dropped = 0;
  droppedChunk: number | undefined;
  private readonly handlers = new Set<(packet: RadioPacket) => void>();
  private readonly unsubscribe: () => void;

  constructor(
    private readonly radio: LinkRadio,
    private readonly target: { operationID: string; chunkIndex: number }
  ) {
    this.max_payload_bytes = radio.max_payload_bytes;
    this.unsubscribe = radio.onPacket((packet) => {
      let shouldDrop = false;
      try {
        const frame = decodeFrame(packet.payload);
        shouldDrop =
          this.dropped === 0 &&
          frame.operation_id === this.target.operationID &&
          frame.chunk_index === this.target.chunkIndex;
        if (shouldDrop) this.droppedChunk = frame.chunk_index;
      } catch {
        // LinkTransport owns malformed-frame accounting; this wrapper only filters valid target frames.
      }
      if (shouldDrop) {
        this.dropped++;
        return;
      }
      for (const handler of this.handlers) handler(packet);
    });
  }

  maxPayloadBytes(options: RadioSendOptions): number {
    return this.radio.maxPayloadBytes?.(options) ?? this.radio.max_payload_bytes;
  }

  pacingDelayMs(payload: Uint8Array): number {
    return this.radio.pacingDelayMs?.(payload) ?? 0;
  }

  send(payload: Uint8Array, options: RadioSendOptions): Promise<void> {
    return this.radio.send(payload, options);
  }

  onPacket(handler: (packet: RadioPacket) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  onDisconnect(handler: (reason: Error) => void): () => void {
    return this.radio.onDisconnect?.(handler) ?? (() => undefined);
  }

  async close(): Promise<void> {
    this.unsubscribe();
    this.handlers.clear();
    await this.radio.close();
  }
}
