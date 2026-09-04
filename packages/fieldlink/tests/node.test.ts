import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  COMPLETE_MESSAGE_BODY_BYTES,
  decodeFrame,
  encodeFrame,
  FIELDLINK_MAX_MESSAGE_BYTES,
  FrameKind,
  TRANSFER_FRAGMENT_BYTES,
} from "../src/frame.js";
import { testMessage } from "../src/messages/test.js";
import {
  FieldLinkNode,
  parseNodeId,
  type FieldLinkEvent,
  type ReceivedMessage,
} from "../src/node.js";
import { selectiveWindowStrategy } from "../src/retry-strategies/selective-window.js";
import type { TransferSenderSession } from "../src/retry.js";
import { eventually, MemoryTransport, memoryTransportPair } from "./helpers.js";

const nodeA = parseNodeId("aaaaaaaaaaaaaaaa");
const nodeB = parseNodeId("bbbbbbbbbbbbbbbb");
const elsewhere = parseNodeId("cccccccccccccccc");

describe("selective-window retry evidence", () => {
  it("counts a recovered transfer-open retry", async () => {
    let openAttempts = 0;
    const session = {
      fragmentCount: 1,
      open() {
        openAttempts += 1;
        if (openAttempts === 1) {
          return Promise.reject(new Error("transfer start dropped"));
        }
        return Promise.resolve();
      },
      sendFragment() {
        return Promise.resolve();
      },
      requestReceipt() {
        return Promise.resolve(1);
      },
      waitForCompletion() {
        return Promise.resolve();
      },
    } satisfies TransferSenderSession;

    await expect(
      selectiveWindowStrategy.createSender().run(session),
    ).resolves.toMatchObject({ transferOpenRetries: 1 });
  });

  it("counts recovery after a completion timeout", async () => {
    let completionAttempts = 0;
    const session = {
      fragmentCount: 1,
      open: () => Promise.resolve(),
      sendFragment: () => Promise.resolve(),
      requestReceipt: () => Promise.resolve(1),
      waitForCompletion: () => {
        completionAttempts += 1;
        return completionAttempts === 1
          ? Promise.reject(new Error("completion dropped"))
          : Promise.resolve();
      },
    } satisfies TransferSenderSession;

    await expect(
      selectiveWindowStrategy.createSender().run(session),
    ).resolves.toMatchObject({ completionRetries: 1 });
  });
});

describe("FieldLinkNode delivery", () => {
  it("reserves the broadcast Node ID for passive publication", async () => {
    const broadcast = parseNodeId("0000000000000000");
    expect(
      () =>
        new FieldLinkNode({
          nodeId: broadcast,
          transport: new MemoryTransport(),
        }),
    ).toThrow("cannot use the broadcast Node ID");

    const node = new FieldLinkNode({
      nodeId: nodeA,
      transport: new MemoryTransport(),
    });
    await expect(
      node.send(test("response", 0), { destination: broadcast }),
    ).rejects.toThrow("use publish()");
    await node.close();
  });

  it("uses a complete frame at the exact threshold and echoes once", async () => {
    const [transportA, transportB] = memoryTransportPair();
    const a = new FieldLinkNode({ nodeId: nodeA, transport: transportA });
    const b = new FieldLinkNode({ nodeId: nodeB, transport: transportB });
    const received: ReceivedMessage[] = [];
    a.onMessage((message) => {
      received.push(message);
    });

    const result = await a.send(
      test("request", COMPLETE_MESSAGE_BODY_BYTES - 5),
      { destination: nodeB },
    );
    await eventually(() => received.length === 1);

    expect(result.delivery).toBe("complete");
    expect(result.encodedBytes).toBe(COMPLETE_MESSAGE_BODY_BYTES);
    expect(received[0]?.message).toEqual(
      test("response", COMPLETE_MESSAGE_BODY_BYTES - 5),
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    expect(transportA.sent).toHaveLength(1);
    expect(transportB.sent).toHaveLength(1);
    await Promise.all([a.close(), b.close()]);
  });

  it("fragments above the exact threshold and resends only a missing fragment", async () => {
    const [transportA, transportB] = memoryTransportPair();
    let dropped = false;
    transportA.drop = (bytes) => {
      const frame = decodeFrame(bytes);
      if (
        !dropped &&
        frame.kind === FrameKind.fragment &&
        frame.fragmentIndex === 2
      ) {
        dropped = true;
        return true;
      }
      return false;
    };
    const a = new FieldLinkNode({
      nodeId: nodeA,
      transport: transportA,
      retryTimeoutMs: 10,
    });
    const b = new FieldLinkNode({
      nodeId: nodeB,
      transport: transportB,
      retryTimeoutMs: 10,
    });
    const received: ReceivedMessage[] = [];
    a.onMessage((message) => {
      received.push(message);
    });

    const result = await a.send(test("request", 4096), {
      destination: nodeB,
      priority: "bulk",
    });
    await eventually(() => received.length === 1, 3000);
    const requestFragments = transportA.sent
      .map(decodeFrame)
      .filter(
        (
          frame,
        ): frame is Extract<
          ReturnType<typeof decodeFrame>,
          { kind: FrameKind.fragment }
        > => frame.kind === FrameKind.fragment,
      );
    const counts = new Map<number, number>();
    for (const frame of requestFragments) {
      counts.set(
        frame.fragmentIndex,
        (counts.get(frame.fragmentIndex) ?? 0) + 1,
      );
    }
    expect(result.delivery).toBe("transfer");
    expect(result.retransmissions).toBe(1);
    expect(counts.get(2)).toBe(2);
    expect(
      [...counts.entries()]
        .filter(([index]) => index !== 2)
        .every(([, count]) => count === 1),
    ).toBe(true);
    expect(received[0]?.message).toEqual(test("response", 4096));
    await Promise.all([a.close(), b.close()]);
  });

  it("keeps intentional repairs distinct from MeshCore duplicate copies", async () => {
    const [transportA, transportB] = memoryTransportPair();
    const seenAtA = new Set<string>();
    const seenAtB = new Set<string>();
    let droppedFragment = false;
    transportA.drop = (bytes) => {
      const frame = decodeFrame(bytes);
      if (
        !droppedFragment &&
        frame.kind === FrameKind.fragment &&
        frame.fragmentIndex === 2
      ) {
        droppedFragment = true;
        return true;
      }
      const key = Buffer.from(bytes).toString("hex");
      if (seenAtB.has(key)) {
        return true;
      }
      seenAtB.add(key);
      return false;
    };
    transportB.drop = (bytes) => {
      const key = Buffer.from(bytes).toString("hex");
      if (seenAtA.has(key)) {
        return true;
      }
      seenAtA.add(key);
      return false;
    };
    const a = new FieldLinkNode({
      nodeId: nodeA,
      transport: transportA,
      retryTimeoutMs: 10,
    });
    const b = new FieldLinkNode({
      nodeId: nodeB,
      transport: transportB,
      retryTimeoutMs: 10,
    });

    const result = await a.send(test("response", 4096), {
      destination: nodeB,
    });
    const firstWindowRequests = transportA.sent
      .map((bytes) => ({ bytes, frame: decodeFrame(bytes) }))
      .filter(
        ({ frame }) =>
          frame.kind === FrameKind.receiptRequest && frame.windowStart === 0,
      );

    expect(result.retransmissions).toBe(1);
    expect(firstWindowRequests).toHaveLength(2);
    expect(
      new Set(
        firstWindowRequests.map(({ bytes }) =>
          Buffer.from(bytes).toString("hex"),
        ),
      ).size,
    ).toBe(2);
    await Promise.all([a.close(), b.close()]);
  });

  it("retries a lost receipt request before repairing fragments", async () => {
    const [transportA, transportB] = memoryTransportPair();
    let droppedFragment = false;
    let droppedReceiptRequest = false;
    transportA.drop = (bytes) => {
      const frame = decodeFrame(bytes);
      if (
        !droppedFragment &&
        frame.kind === FrameKind.fragment &&
        frame.fragmentIndex === 2
      ) {
        droppedFragment = true;
        return true;
      }
      if (!droppedReceiptRequest && frame.kind === FrameKind.receiptRequest) {
        droppedReceiptRequest = true;
        return true;
      }
      return false;
    };
    const a = new FieldLinkNode({
      nodeId: nodeA,
      transport: transportA,
      retryTimeoutMs: 10,
    });
    const b = new FieldLinkNode({
      nodeId: nodeB,
      transport: transportB,
      retryTimeoutMs: 10,
    });

    const result = await a.send(test("response", 600), {
      destination: nodeB,
    });
    const frames = transportA.sent.map(decodeFrame);
    const fragmentCounts = new Map<number, number>();
    for (const frame of frames) {
      if (frame.kind === FrameKind.fragment) {
        fragmentCounts.set(
          frame.fragmentIndex,
          (fragmentCounts.get(frame.fragmentIndex) ?? 0) + 1,
        );
      }
    }

    expect(result.retransmissions).toBe(1);
    expect(result.receiptRequests).toBe(3);
    expect(result.receiptRequestRetries).toBe(1);
    expect(fragmentCounts.get(2)).toBe(2);
    expect(
      [...fragmentCounts.entries()]
        .filter(([index]) => index !== 2)
        .every(([, count]) => count === 1),
    ).toBe(true);
    expect(
      frames.filter((frame) => frame.kind === FrameKind.receiptRequest),
    ).toHaveLength(3);
    await Promise.all([a.close(), b.close()]);
  });

  it("repairs a burst without resending received fragments", async () => {
    const [transportA, transportB] = memoryTransportPair();
    const missing = new Set([1, 2, 3]);
    transportA.drop = (bytes) => {
      const frame = decodeFrame(bytes);
      if (
        frame.kind === FrameKind.fragment &&
        missing.delete(frame.fragmentIndex)
      ) {
        return true;
      }
      return false;
    };
    const a = new FieldLinkNode({
      nodeId: nodeA,
      transport: transportA,
      retryTimeoutMs: 10,
    });
    const b = new FieldLinkNode({
      nodeId: nodeB,
      transport: transportB,
      retryTimeoutMs: 10,
    });
    const result = await a.send(test("response", 600), {
      destination: nodeB,
    });
    const counts = new Map<number, number>();
    for (const frame of transportA.sent.map(decodeFrame)) {
      if (frame.kind === FrameKind.fragment) {
        counts.set(
          frame.fragmentIndex,
          (counts.get(frame.fragmentIndex) ?? 0) + 1,
        );
      }
    }
    expect(result.retransmissions).toBe(3);
    expect([1, 2, 3].every((index) => counts.get(index) === 2)).toBe(true);
    expect(
      [...counts.entries()]
        .filter(([index]) => ![1, 2, 3].includes(index))
        .every(([, count]) => count === 1),
    ).toBe(true);
    await Promise.all([a.close(), b.close()]);
  });

  it("delivers a validated transfer before retrying a lost completion", async () => {
    const transportA = new MemoryTransport();
    const transportB = new FailsFirstCompletionTransport();
    transportA.peer = transportB;
    transportB.peer = transportA;
    const a = new FieldLinkNode({
      nodeId: nodeA,
      transport: transportA,
      retryTimeoutMs: 10,
    });
    const b = new FieldLinkNode({
      nodeId: nodeB,
      transport: transportB,
      retryTimeoutMs: 10,
    });
    const received: ReceivedMessage[] = [];
    const events: FieldLinkEvent[] = [];
    b.onMessage((message) => {
      received.push(message);
    });
    b.onEvent((event) => {
      events.push(event);
    });

    await expect(
      a.send(test("response", 200), { destination: nodeB }),
    ).resolves.toMatchObject({ delivery: "transfer" });
    expect(received).toHaveLength(1);
    expect(transportB.failedCompletion).toBe(true);
    expect(transportB.listenerErrors[0]?.message).toBe(
      "completion send failed",
    );
    expect(
      events.some(
        (event) =>
          event.type === "protocol-error" &&
          String(event.message).includes("Inbound handling failed"),
      ),
    ).toBe(true);
    await Promise.all([a.close(), b.close()]);
  });

  it("preserves cancellation while waiting for transfer completion", async () => {
    const [transportA, transportB] = memoryTransportPair();
    let completionDropped = false;
    transportB.drop = (bytes) => {
      if (decodeFrame(bytes).kind !== FrameKind.completion) {
        return false;
      }
      completionDropped = true;
      return true;
    };
    const a = new FieldLinkNode({
      nodeId: nodeA,
      transport: transportA,
      retryTimeoutMs: 1000,
    });
    const b = new FieldLinkNode({
      nodeId: nodeB,
      transport: transportB,
      retryTimeoutMs: 1000,
    });
    const controller = new AbortController();
    const sending = a.send(test("response", 200), {
      destination: nodeB,
      signal: controller.signal,
    });
    const rejected = expect(sending).rejects.toThrow(
      "completion wait cancelled",
    );
    await eventually(() => completionDropped);

    controller.abort(new Error("completion wait cancelled"));

    await rejected;
    await Promise.all([a.close(), b.close()]);
  });

  it("does not let an aborted cancellation wait on the MeshCore queue", async () => {
    const transport = new MemoryTransport();
    transport.queueLength = 1;
    const node = new FieldLinkNode({
      nodeId: nodeA,
      transport,
      retryTimeoutMs: 10,
    });
    const controller = new AbortController();
    const sending = node.send(test("response", 200), {
      destination: nodeB,
      signal: controller.signal,
    });
    const rejected = expect(sending).rejects.toThrow("queue wait cancelled");
    await eventually(() => transport.queueLengths.length > 0);

    controller.abort(new Error("queue wait cancelled"));

    await rejected;
    await node.close();
  });

  it("rejects caller cancellation promptly with the default retry timeout", async () => {
    const transport = new MemoryTransport();
    transport.queueLength = 1;
    const node = new FieldLinkNode({ nodeId: nodeA, transport });
    const controller = new AbortController();
    const startedAt = performance.now();
    const sending = node.send(test("response", 200), {
      destination: nodeB,
      signal: controller.signal,
    });
    await eventually(() => transport.queueLengths.length > 0);

    controller.abort(new Error("cancel promptly"));

    await expect(sending).rejects.toThrow("cancel promptly");
    expect(performance.now() - startedAt).toBeLessThan(500);
    await node.close();
  });

  it("releases the receiver transfer slot after caller cancellation", async () => {
    const [transportA, transportB] = memoryTransportPair();
    transportA.drop = (bytes) => decodeFrame(bytes).kind === FrameKind.fragment;
    const a = new FieldLinkNode({
      nodeId: nodeA,
      transport: transportA,
      retryTimeoutMs: 20,
    });
    const b = new FieldLinkNode({
      nodeId: nodeB,
      transport: transportB,
      retryTimeoutMs: 20,
    });
    let controller: AbortController | undefined;
    let cancellationsRemaining = 4;
    const events: FieldLinkEvent[] = [];
    b.onEvent((event) => {
      events.push(event);
      if (event.type === "transfer-accepted" && cancellationsRemaining > 0) {
        cancellationsRemaining -= 1;
        controller?.abort(new Error("caller cancelled transfer"));
      }
    });

    try {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        controller = new AbortController();
        await expect(
          a.send(test("response", 4096), {
            destination: nodeB,
            signal: controller.signal,
          }),
        ).rejects.toThrow("caller cancelled transfer");
        await Promise.all([transportA.settle(), transportB.settle()]);
        await eventually(
          () =>
            transportA.sent
              .map(decodeFrame)
              .filter((frame) => frame.kind === FrameKind.cancellation)
              .length ===
            attempt + 1,
        );
        await eventually(
          () =>
            events.filter((event) => event.type === "transfer-cancelled")
              .length ===
            attempt + 1,
        );
      }

      expect(
        transportA.sent
          .map(decodeFrame)
          .filter((frame) => frame.kind === FrameKind.cancellation),
      ).toHaveLength(4);
      expect(
        events.filter((event) => event.type === "transfer-cancelled"),
      ).toHaveLength(4);

      transportA.drop = undefined;
      await expect(
        a.send(test("response", 4096), { destination: nodeB }),
      ).resolves.toMatchObject({ delivery: "transfer" });
    } finally {
      await Promise.all([a.close(), b.close()]);
    }
  });

  it("isolates synchronous message and event listener failures", async () => {
    const [transportA, transportB] = memoryTransportPair();
    const a = new FieldLinkNode({
      nodeId: nodeA,
      transport: transportA,
      retryTimeoutMs: 20,
    });
    const b = new FieldLinkNode({
      nodeId: nodeB,
      transport: transportB,
      retryTimeoutMs: 20,
    });
    a.onEvent(() => {
      throw new Error("event listener failed");
    });
    b.onMessage(() => {
      throw new Error("message listener failed");
    });

    await expect(
      a.send(test("response", 200), { destination: nodeB }),
    ).resolves.toMatchObject({ delivery: "transfer" });
    await Promise.all([a.close(), b.close()]);
  });

  it("ignores transfer control from a node other than the destination", async () => {
    const transport = new MemoryTransport();
    const node = new FieldLinkNode({
      nodeId: nodeA,
      transport,
      retryTimeoutMs: 1000,
    });
    const controller = new AbortController();
    const sending = node
      .send(test("response", 200), {
        destination: nodeB,
        signal: controller.signal,
      })
      .catch(() => undefined);
    await eventually(() => transport.sent.length > 0);
    const startBytes = transport.sent[0];
    if (startBytes === undefined) {
      throw new Error("Expected transfer start bytes");
    }
    const start = decodeFrame(startBytes);
    if (start.kind !== FrameKind.transferStart) {
      throw new Error("Expected transfer start");
    }

    transport.inject({
      bytes: encodeFrame({
        transmissionId: 99,
        kind: FrameKind.transferReady,
        source: elsewhere,
        destination: nodeA,
        logicalId: start.logicalId,
      }),
    });
    await transport.settle();
    await new Promise<void>((resolve) => setTimeout(resolve, 5));

    expect(
      transport.sent.some(
        (bytes) => decodeFrame(bytes).kind === FrameKind.fragment,
      ),
    ).toBe(false);
    controller.abort(new Error("done"));
    await sending;
    await node.close();
  });

  it("lets a high-priority complete message preempt a bulk repair", async () => {
    const [transportA, transportB] = memoryTransportPair();
    let droppedReceipt = false;
    transportB.drop = (bytes) => {
      const frame = decodeFrame(bytes);
      if (!droppedReceipt && frame.kind === FrameKind.receipt) {
        droppedReceipt = true;
        return true;
      }
      return false;
    };
    const a = new FieldLinkNode({
      nodeId: nodeA,
      transport: transportA,
      retryTimeoutMs: 20,
    });
    const b = new FieldLinkNode({
      nodeId: nodeB,
      transport: transportB,
      retryTimeoutMs: 20,
    });
    const bulk = a.send(test("response", 1200), {
      destination: nodeB,
      priority: "bulk",
    });
    await eventually(() =>
      transportA.sent.some(
        (bytes) => decodeFrame(bytes).kind === FrameKind.receiptRequest,
      ),
    );
    const high = a.send(test("response", 1), {
      destination: nodeB,
      priority: "high",
    });
    await high;
    await bulk;
    const frames = transportA.sent.map(decodeFrame);
    const completeIndex = frames.findIndex(
      (frame) => frame.kind === FrameKind.complete,
    );
    const retransmissionIndex = frames.findIndex(
      (frame, index) =>
        index > completeIndex && frame.kind === FrameKind.fragment,
    );
    expect(completeIndex).toBeGreaterThan(0);
    expect(retransmissionIndex).toBeGreaterThan(completeIndex);
    expect(transportA.queueLengths.every((length) => length === 0)).toBe(true);
    await Promise.all([a.close(), b.close()]);
  });

  it("rechecks complete-message priority after waiting for MeshCore", async () => {
    const transport = new MemoryTransport();
    transport.queueLength = 1;
    const node = new FieldLinkNode({ nodeId: nodeA, transport });
    const bulk = node.send(
      { ...test("response", 0), correlationId: 1 },
      { destination: nodeB, priority: "bulk" },
    );
    await eventually(() => transport.queueLengths.length > 0);
    const high = node.send(
      { ...test("response", 0), correlationId: 2 },
      { destination: nodeB, priority: "high" },
    );

    transport.queueLength = 0;
    await Promise.all([bulk, high]);

    expect(
      transport.sent.map((bytes) => {
        const frame = decodeFrame(bytes);
        if (frame.kind !== FrameKind.complete) {
          throw new Error("Expected a complete frame");
        }
        return testMessage.decode(frame.body).correlationId;
      }),
    ).toEqual([2, 1]);
    await node.close();
  });

  it("queues a high-priority transfer behind the one active outbound transfer", async () => {
    const transportA = new PausesAfterFirstBulkFragmentTransport();
    const transportB = new MemoryTransport();
    transportA.peer = transportB;
    transportB.peer = transportA;
    const a = new FieldLinkNode({
      nodeId: nodeA,
      transport: transportA,
      retryTimeoutMs: 100,
    });
    const b = new FieldLinkNode({
      nodeId: nodeB,
      transport: transportB,
      retryTimeoutMs: 100,
    });
    const completed: string[] = [];
    const bulk = a
      .send(test("response", 1200), {
        destination: nodeB,
        priority: "bulk",
      })
      .then(() => completed.push("bulk"));
    await eventually(() => transportA.paused);
    const high = a
      .send(test("response", 400), {
        destination: nodeB,
        priority: "high",
      })
      .then(() => completed.push("high"));

    transportA.queueLength = 0;
    await Promise.all([bulk, high]);

    const frames = transportA.sent.map(decodeFrame);
    const firstBulkFragment = frames.findIndex(
      (frame) =>
        frame.kind === FrameKind.fragment &&
        frame.logicalId === transportA.bulkLogicalId,
    );
    const highStart = frames.findIndex(
      (frame) =>
        frame.kind === FrameKind.transferStart && frame.priority === "high",
    );
    const lastBulkFragment = frames.findLastIndex(
      (frame) =>
        frame.kind === FrameKind.fragment &&
        frame.logicalId === transportA.bulkLogicalId,
    );
    expect(firstBulkFragment).toBeGreaterThan(-1);
    expect(highStart).toBeGreaterThan(lastBulkFragment);
    expect(frames[highStart]).toMatchObject({
      kind: FrameKind.transferStart,
      priority: "high",
    });
    expect(completed).toEqual(["bulk", "high"]);
    await Promise.all([a.close(), b.close()]);
  });

  it("yields an outbound bulk transfer to an inbound high transfer", async () => {
    const transportA = new MemoryTransport();
    const transportB = new PausesAfterFirstBulkFragmentTransport();
    transportA.peer = transportB;
    transportB.peer = transportA;
    const a = new FieldLinkNode({
      nodeId: nodeA,
      transport: transportA,
      retryTimeoutMs: 100,
    });
    const b = new FieldLinkNode({
      nodeId: nodeB,
      transport: transportB,
      retryTimeoutMs: 100,
    });
    const bulk = b.send(test("response", 1200), {
      destination: nodeA,
      priority: "bulk",
    });
    await eventually(() => transportB.paused);
    const high = a.send(test("response", 400), {
      destination: nodeB,
      priority: "high",
    });
    await eventually(() =>
      transportA.sent.some((bytes) => {
        const frame = decodeFrame(bytes);
        return (
          frame.kind === FrameKind.transferStart && frame.priority === "high"
        );
      }),
    );

    transportB.queueLength = 0;
    await Promise.all([bulk, high]);

    const highStart = transportA.sent
      .map(decodeFrame)
      .find(
        (frame) =>
          frame.kind === FrameKind.transferStart && frame.priority === "high",
      );
    if (highStart === undefined) {
      throw new Error("Expected a high-priority transfer start");
    }
    const sentByB = transportB.sent.map(decodeFrame);
    const readyIndex = sentByB.findIndex(
      (frame) =>
        frame.kind === FrameKind.transferReady &&
        frame.logicalId === highStart.logicalId,
    );
    const completionIndex = sentByB.findIndex(
      (frame) =>
        frame.kind === FrameKind.completion &&
        frame.logicalId === highStart.logicalId,
    );
    expect(readyIndex).toBeGreaterThanOrEqual(0);
    expect(completionIndex).toBeGreaterThan(readyIndex);
    expect(
      sentByB
        .slice(readyIndex + 1, completionIndex)
        .some(
          (frame) =>
            frame.kind === FrameKind.fragment &&
            frame.logicalId === transportB.bulkLogicalId,
        ),
    ).toBe(false);
    await Promise.all([a.close(), b.close()]);
  });

  it("accepts a sent frame before waiting to pace the next one", async () => {
    const transport = new QueuesAfterSendTransport();
    const node = new FieldLinkNode({ nodeId: nodeA, transport });
    const controller = new AbortController();
    const sending = node.send(test("response", 0), {
      destination: nodeB,
      signal: controller.signal,
    });
    await eventually(() => transport.sent.length === 1);

    controller.abort(new Error("abort after acceptance"));

    await expect(sending).resolves.toMatchObject({ delivery: "complete" });
    await node.close();
  });

  it("accepts completion when the final selective-window receipt is lost", async () => {
    const [transportA, transportB] = memoryTransportPair();
    transportB.drop = (bytes) => decodeFrame(bytes).kind === FrameKind.receipt;
    const a = new FieldLinkNode({
      nodeId: nodeA,
      transport: transportA,
      retryTimeoutMs: 5,
    });
    const b = new FieldLinkNode({
      nodeId: nodeB,
      transport: transportB,
      retryTimeoutMs: 5,
    });
    await expect(
      a.send(test("response", 300), { destination: nodeB }),
    ).resolves.toMatchObject({ delivery: "transfer", retransmissions: 0 });
    await Promise.all([a.close(), b.close()]);
  });

  it("answers a late receipt request with one completion frame", async () => {
    const [transportA, transportB] = memoryTransportPair();
    const a = new FieldLinkNode({
      nodeId: nodeA,
      transport: transportA,
      retryTimeoutMs: 10,
    });
    const b = new FieldLinkNode({
      nodeId: nodeB,
      transport: transportB,
      retryTimeoutMs: 10,
    });
    const events: FieldLinkEvent[] = [];
    b.onEvent((event) => {
      events.push(event);
    });
    const result = await a.send(test("response", 200), {
      destination: nodeB,
    });
    await Promise.all([transportA.settle(), transportB.settle()]);
    const sentBeforeRequest = transportB.sent.length;

    transportB.inject({
      bytes: encodeFrame({
        transmissionId: 99,
        kind: FrameKind.receiptRequest,
        source: nodeA,
        destination: nodeB,
        logicalId: BigInt(`0x${result.logicalId}`),
        windowStart: 0,
        windowCount: 2,
      }),
    });
    await transportB.settle();
    await eventually(() => transportB.sent.length === sentBeforeRequest + 1);

    expect(
      transportB.sent.slice(sentBeforeRequest).map(decodeFrame),
    ).toMatchObject([{ kind: FrameKind.completion }]);
    expect(events.some((event) => event.type === "protocol-error")).toBe(false);
    await Promise.all([a.close(), b.close()]);
  });

  it("fails cleanly when every receipt and completion is lost", async () => {
    const [transportA, transportB] = memoryTransportPair();
    transportB.drop = (bytes) => {
      const kind = decodeFrame(bytes).kind;
      return kind === FrameKind.receipt || kind === FrameKind.completion;
    };
    const a = new FieldLinkNode({
      nodeId: nodeA,
      transport: transportA,
      retryTimeoutMs: 5,
    });
    const b = new FieldLinkNode({
      nodeId: nodeB,
      transport: transportB,
      retryTimeoutMs: 5,
    });
    const events: FieldLinkEvent[] = [];
    a.onEvent((event) => {
      events.push(event);
    });
    await expect(
      a.send(test("response", 300), { destination: nodeB }),
    ).rejects.toThrow("exhausted repairs");
    expect(events.some((event) => event.type === "transfer-failed")).toBe(true);
    await Promise.all([a.close(), b.close()]);
  });

  it("accepts an encoded 1 MiB message and rejects an oversized value", async () => {
    const [transportA, transportB] = memoryTransportPair();
    const a = new FieldLinkNode({
      nodeId: nodeA,
      transport: transportA,
      retryTimeoutMs: 20,
    });
    const b = new FieldLinkNode({
      nodeId: nodeB,
      transport: transportB,
      retryTimeoutMs: 20,
    });
    const result = await a.send(
      test("response", FIELDLINK_MAX_MESSAGE_BYTES - 5),
      { destination: nodeB },
    );
    expect(result.encodedBytes).toBe(FIELDLINK_MAX_MESSAGE_BYTES);
    expect(result.fragments).toBe(
      Math.ceil(FIELDLINK_MAX_MESSAGE_BYTES / TRANSFER_FRAGMENT_BYTES),
    );
    await expect(
      a.send(test("response", FIELDLINK_MAX_MESSAGE_BYTES - 4), {
        destination: nodeB,
      }),
    ).rejects.toThrow("Unsupported or invalid");
    await Promise.all([a.close(), b.close()]);
  }, 30_000);

  it("filters other destinations and reports a fragment with no start", async () => {
    const transport = new MemoryTransport();
    const node = new FieldLinkNode({ nodeId: nodeB, transport });
    const messages: ReceivedMessage[] = [];
    const events: FieldLinkEvent[] = [];
    node.onMessage((message) => {
      messages.push(message);
    });
    node.onEvent((event) => {
      events.push(event);
    });
    transport.inject({
      bytes: encodeFrame({
        transmissionId: 1,
        kind: FrameKind.complete,
        source: nodeA,
        destination: elsewhere,
        logicalId: 1n,
        messageType: 1,
        body: testMessage.encode(test("response", 0)),
      }),
    });
    transport.inject({
      bytes: encodeFrame({
        transmissionId: 2,
        kind: FrameKind.complete,
        source: nodeA,
        destination: nodeB,
        logicalId: 3n,
        messageType: 99,
        body: new Uint8Array(),
      }),
    });
    transport.inject({
      bytes: encodeFrame({
        transmissionId: 3,
        kind: FrameKind.fragment,
        source: nodeA,
        destination: nodeB,
        logicalId: 2n,
        fragmentIndex: 0,
        body: Uint8Array.of(1),
      }),
    });
    await transport.settle();
    expect(messages).toHaveLength(0);
    expect(events.some((event) => event.type === "protocol-error")).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === "protocol-error" &&
          String(event.message).includes("Unknown message type 99"),
      ),
    ).toBe(true);
    await node.close();
  });
});

describe("inbound transfer validation", () => {
  it("reassembles duplicate and reordered fragments idempotently", async () => {
    const transport = new MemoryTransport();
    const node = new FieldLinkNode({
      nodeId: nodeB,
      transport,
      retryTimeoutMs: 5,
    });
    const body = testMessage.encode(test("response", 200));
    const frames = transferFrames(10n, body, 1);
    const [firstFragment, secondFragment] = frames.fragments;
    if (firstFragment === undefined || secondFragment === undefined) {
      throw new Error("Expected two transfer fragments");
    }
    const messages: ReceivedMessage[] = [];
    node.onMessage((message) => {
      messages.push(message);
    });
    transport.inject({ bytes: encodeFrame(frames.start) });
    transport.inject({ bytes: encodeFrame(secondFragment) });
    transport.inject({ bytes: encodeFrame(firstFragment) });
    transport.inject({ bytes: encodeFrame(firstFragment) });
    await transport.settle();
    await eventually(() => messages.length === 1);
    expect(messages[0]?.message).toEqual(test("response", 200));
    await node.close();
  });

  it("keeps a completed tombstone when a delayed cancellation arrives", async () => {
    const transport = new MemoryTransport();
    const node = new FieldLinkNode({ nodeId: nodeB, transport });
    const transfer = transferFrames(
      11n,
      testMessage.encode(test("response", 200)),
      1,
    );
    const messages: ReceivedMessage[] = [];
    node.onMessage((message) => {
      messages.push(message);
    });

    transport.inject({ bytes: encodeFrame(transfer.start) });
    for (const fragment of transfer.fragments) {
      transport.inject({ bytes: encodeFrame(fragment) });
    }
    await transport.settle();
    await eventually(() => messages.length === 1);

    transport.inject({
      bytes: encodeFrame({
        transmissionId: 99,
        kind: FrameKind.cancellation,
        source: nodeA,
        destination: nodeB,
        logicalId: 11n,
        code: 1,
      }),
    });
    transport.inject({ bytes: encodeFrame(transfer.start) });
    for (const fragment of transfer.fragments) {
      transport.inject({ bytes: encodeFrame(fragment) });
    }
    await transport.settle();

    expect(messages).toHaveLength(1);
    await node.close();
  });

  it("rejects digest mismatch, unknown strategy, resource limits, and inactivity", async () => {
    let now = 0;
    const transport = new MemoryTransport();
    const node = new FieldLinkNode({
      nodeId: nodeB,
      transport,
      inboundTransferIdleMs: 10,
      now: () => now,
    });
    const events: FieldLinkEvent[] = [];
    node.onEvent((event) => {
      events.push(event);
    });

    const wrongDigest = transferFrames(
      20n,
      testMessage.encode(test("response", 200)),
      1,
    );
    const corruptStart = {
      ...wrongDigest.start,
      digest: new Uint8Array(32),
    };
    transport.inject({ bytes: encodeFrame(corruptStart) });
    for (const fragment of wrongDigest.fragments) {
      transport.inject({ bytes: encodeFrame(fragment) });
    }
    const unknown = transferFrames(
      21n,
      testMessage.encode(test("response", 200)),
      99,
    );
    transport.inject({ bytes: encodeFrame(unknown.start) });
    for (let id = 30n; id < 35n; id += 1n) {
      const pending = transferFrames(
        id,
        testMessage.encode(test("response", 200)),
        1,
      );
      transport.inject({ bytes: encodeFrame(pending.start) });
    }
    await transport.settle();
    now = 20;
    await eventually(
      () =>
        events.filter((event) => event.type === "protocol-error").length >= 3,
    );
    await eventually(() =>
      events.some((event) => event.type === "transfer-expired"),
    );
    expect(
      events.some(
        (event) =>
          event.type === "protocol-error" &&
          String(event.message).includes("digest"),
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === "protocol-error" &&
          String(event.message).includes("Unsupported retry"),
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === "protocol-error" &&
          String(event.message).includes("limit"),
      ),
    ).toBe(true);
    expect(events.some((event) => event.type === "transfer-expired")).toBe(
      true,
    );
    await node.close();
  });

  it("releases invalid inbound state before a rejection send can fail", async () => {
    const transport = new FailsRejectionTransport();
    const node = new FieldLinkNode({ nodeId: nodeB, transport });
    const messages: ReceivedMessage[] = [];
    node.onMessage((message) => {
      messages.push(message);
    });

    for (let id = 30n; id < 34n; id += 1n) {
      const invalid = transferFrames(
        id,
        testMessage.encode(test("response", 200)),
        1,
      );
      transport.inject({
        bytes: encodeFrame({
          ...invalid.start,
          digest: new Uint8Array(32),
        }),
      });
      for (const fragment of invalid.fragments) {
        transport.inject({ bytes: encodeFrame(fragment) });
      }
    }
    const valid = transferFrames(
      40n,
      testMessage.encode(test("response", 200)),
      1,
    );
    transport.inject({ bytes: encodeFrame(valid.start) });
    for (const fragment of valid.fragments) {
      transport.inject({ bytes: encodeFrame(fragment) });
    }

    await transport.settle();
    await eventually(() => messages.length === 1);
    expect(transport.rejectionFailures).toBe(4);
    expect(messages[0]?.message).toEqual(test("response", 200));
    await node.close();
  });

  it("does not refresh inbound activity for an invalid fragment", async () => {
    let now = 0;
    const transport = new MemoryTransport();
    const node = new FieldLinkNode({
      nodeId: nodeB,
      transport,
      inboundTransferIdleMs: 10,
      now: () => now,
    });
    const events: FieldLinkEvent[] = [];
    node.onEvent((event) => {
      events.push(event);
    });
    const transfer = transferFrames(
      50n,
      testMessage.encode(test("response", 200)),
      1,
    );
    transport.inject({ bytes: encodeFrame(transfer.start) });
    await transport.settle();

    now = 9;
    transport.inject({
      bytes: encodeFrame({
        transmissionId: 99,
        kind: FrameKind.fragment,
        source: nodeA,
        destination: nodeB,
        logicalId: 50n,
        fragmentIndex: transfer.fragments.length,
        body: Uint8Array.of(1),
      }),
    });
    await transport.settle();
    now = 15;

    await eventually(() =>
      events.some((event) => event.type === "transfer-expired"),
    );
    await node.close();
  });

  it("does not refresh a completed tombstone for an invalid fragment", async () => {
    let now = 0;
    const transport = new MemoryTransport();
    const node = new FieldLinkNode({
      nodeId: nodeB,
      transport,
      inboundTransferIdleMs: 10,
      now: () => now,
    });
    const events: FieldLinkEvent[] = [];
    node.onEvent((event) => {
      events.push(event);
    });
    const transfer = transferFrames(
      53n,
      testMessage.encode(test("response", 200)),
      1,
    );
    transport.inject({ bytes: encodeFrame(transfer.start) });
    for (const fragment of transfer.fragments) {
      transport.inject({ bytes: encodeFrame(fragment) });
    }
    await transport.settle();

    now = 9;
    transport.inject({
      bytes: encodeFrame({
        transmissionId: 99,
        kind: FrameKind.fragment,
        source: nodeA,
        destination: nodeB,
        logicalId: 53n,
        fragmentIndex: transfer.fragments.length,
        body: Uint8Array.of(1),
      }),
    });
    transport.inject({
      bytes: encodeFrame({
        transmissionId: 100,
        kind: FrameKind.fragment,
        source: nodeA,
        destination: nodeB,
        logicalId: 53n,
        fragmentIndex: 0,
        body: Uint8Array.of(1),
      }),
    });
    await transport.settle();
    now = 15;

    await eventually(() =>
      events.some((event) => event.type === "transfer-tombstone-expired"),
    );
    await node.close();
  });

  it("does not refresh inbound activity for an invalid receipt window", async () => {
    let now = 0;
    const transport = new MemoryTransport();
    const node = new FieldLinkNode({
      nodeId: nodeB,
      transport,
      inboundTransferIdleMs: 10,
      now: () => now,
    });
    const events: FieldLinkEvent[] = [];
    node.onEvent((event) => {
      events.push(event);
    });
    const transfer = transferFrames(
      51n,
      testMessage.encode(test("response", 200)),
      1,
    );
    transport.inject({ bytes: encodeFrame(transfer.start) });
    await transport.settle();

    now = 9;
    transport.inject({
      bytes: encodeFrame({
        transmissionId: 99,
        kind: FrameKind.receiptRequest,
        source: nodeA,
        destination: nodeB,
        logicalId: 51n,
        windowStart: transfer.fragments.length,
        windowCount: 1,
      }),
    });
    await transport.settle();
    now = 15;

    await eventually(() =>
      events.some((event) => event.type === "transfer-expired"),
    );
    await node.close();
  });

  it("does not refresh inbound activity for a conflicting repeated start", async () => {
    let now = 0;
    const transport = new MemoryTransport();
    const node = new FieldLinkNode({
      nodeId: nodeB,
      transport,
      inboundTransferIdleMs: 10,
      now: () => now,
    });
    const events: FieldLinkEvent[] = [];
    node.onEvent((event) => {
      events.push(event);
    });
    const transfer = transferFrames(
      52n,
      testMessage.encode(test("response", 200)),
      1,
    );
    transport.inject({ bytes: encodeFrame(transfer.start) });
    await transport.settle();

    now = 9;
    transport.inject({
      bytes: encodeFrame({
        ...transfer.start,
        transmissionId: 99,
        digest: new Uint8Array(32),
      }),
    });
    await transport.settle();
    now = 15;

    await eventually(() =>
      events.some((event) => event.type === "transfer-expired"),
    );
    await node.close();
  });

  it("bounds pending sends at 64", async () => {
    const transport = new MemoryTransport();
    transport.queueLength = 1;
    const node = new FieldLinkNode({ nodeId: nodeA, transport });
    const controllers = Array.from({ length: 64 }, () => new AbortController());
    const pending = controllers.map((controller) =>
      node
        .send(test("response", 0), {
          destination: nodeB,
          signal: controller.signal,
        })
        .catch(() => undefined),
    );
    await expect(
      node.send(test("response", 0), { destination: nodeB }),
    ).rejects.toThrow("64-send limit");
    for (const controller of controllers) {
      controller.abort();
    }
    await Promise.all(pending);
    await node.close();
  });

  it("releases an aborted send while it waits for the transfer slot", async () => {
    const transport = new MemoryTransport();
    transport.queueLength = 1;
    const node = new FieldLinkNode({ nodeId: nodeA, transport });
    const active = Array.from({ length: 3 }, () =>
      node
        .send(test("response", 200), {
          destination: nodeB,
          priority: "bulk",
        })
        .catch(() => undefined),
    );
    await eventually(() => transport.queueLengths.length > 0);
    const controller = new AbortController();
    const waiting = node.send(test("response", 200), {
      destination: nodeB,
      priority: "bulk",
      signal: controller.signal,
    });
    const rejected = expect(waiting).rejects.toThrow("slot wait cancelled");

    controller.abort(new Error("slot wait cancelled"));

    await rejected;
    await node.close();
    await Promise.all(active);
  });

  it("removes an aborted frame queued behind an inbound response", async () => {
    const transport = new MemoryTransport();
    transport.queueLength = 1;
    const node = new FieldLinkNode({ nodeId: nodeB, transport });
    const transfer = transferFrames(
      61n,
      testMessage.encode(test("response", 200)),
      1,
    );
    transport.inject({ bytes: encodeFrame(transfer.start) });
    await eventually(() => transport.queueLengths.length > 0);
    const controller = new AbortController();
    const sending = node.send(test("response", 0), {
      destination: nodeA,
      signal: controller.signal,
    });
    const rejected = expect(sending).rejects.toThrow("queued frame cancelled");

    controller.abort(new Error("queued frame cancelled"));

    await rejected;
    await node.close();
    await transport.settle();
  });

  it("releases every queued transfer when close interrupts the first", async () => {
    const transport = new MemoryTransport();
    transport.queueLength = 1;
    const node = new FieldLinkNode({ nodeId: nodeA, transport });
    const sends = Array.from({ length: 3 }, () =>
      node.send(test("response", 300), { destination: nodeB }).then(
        () => undefined,
        (error: unknown) => error,
      ),
    );
    await eventually(() => transport.queueLengths.length > 0);

    await node.close();
    const results = await Promise.all(sends);
    expect(results.every((result) => result instanceof Error)).toBe(true);
  });

  it("cancels pending inbound control work before closing", async () => {
    const transport = new MemoryTransport();
    transport.queueLength = 1;
    const node = new FieldLinkNode({ nodeId: nodeB, transport });
    const transfer = transferFrames(
      60n,
      testMessage.encode(test("response", 200)),
      1,
    );
    transport.inject({ bytes: encodeFrame(transfer.start) });
    await eventually(() => transport.queueLengths.length > 0);

    await node.close();
    expect(transport.closed).toBe(true);
  });

  it("keeps equal logical IDs from different sources isolated", async () => {
    const transport = new MemoryTransport();
    const node = new FieldLinkNode({ nodeId: nodeB, transport });
    const received: ReceivedMessage[] = [];
    node.onMessage((message) => {
      received.push(message);
    });
    const first = transferFrames(
      71n,
      testMessage.encode(test("response", 200)),
      1,
      nodeA,
    );
    const second = transferFrames(
      71n,
      testMessage.encode({ ...test("response", 200), correlationId: 43 }),
      1,
      elsewhere,
    );

    transport.inject({ bytes: encodeFrame(first.start) });
    transport.inject({ bytes: encodeFrame(second.start) });
    for (let index = 0; index < first.fragments.length; index += 1) {
      const firstFragment = first.fragments[index];
      const secondFragment = second.fragments[index];
      if (firstFragment === undefined || secondFragment === undefined) {
        throw new Error("transfer fragment fixtures do not align");
      }
      transport.inject({ bytes: encodeFrame(firstFragment) });
      transport.inject({ bytes: encodeFrame(secondFragment) });
    }

    await eventually(() => received.length === 2);
    expect(received.map((message) => message.source).sort()).toEqual(
      [nodeA, elsewhere].sort(),
    );
    await node.close();
  });

  it("bounds completed transfer tombstones", async () => {
    const transport = new MemoryTransport();
    const node = new FieldLinkNode({ nodeId: nodeB, transport });
    const events: FieldLinkEvent[] = [];
    node.onEvent((event) => {
      events.push(event);
    });
    const body = testMessage.encode(test("response", 200));

    for (let id = 1n; id <= 65n; id += 1n) {
      const transfer = transferFrames(id, body, 1);
      transport.inject({ bytes: encodeFrame(transfer.start) });
      for (const fragment of transfer.fragments) {
        transport.inject({ bytes: encodeFrame(fragment) });
      }
      await transport.settle();
    }
    const first = transferFrames(1n, body, 1);
    transport.inject({ bytes: encodeFrame(first.start) });

    await eventually(
      () =>
        events.filter(
          (event) =>
            event.type === "transfer-accepted" &&
            event.logicalId === "0000000000000001",
        ).length === 2,
    );
    await node.close();
  });

  it("drains an accepted async message listener before close", async () => {
    const transport = new MemoryTransport();
    const node = new FieldLinkNode({ nodeId: nodeB, transport });
    let reportStarted = (): void => undefined;
    const started = new Promise<void>((resolve) => {
      reportStarted = resolve;
    });
    let release = (): void => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    node.onMessage(async () => {
      reportStarted();
      await released;
      await node.send(test("response", 0), { destination: nodeA });
    });
    transport.inject({
      bytes: encodeFrame({
        transmissionId: 1,
        kind: FrameKind.complete,
        source: nodeA,
        destination: nodeB,
        logicalId: 72n,
        messageType: 1,
        body: testMessage.encode(test("request", 0)),
      }),
    });
    await started;

    const closing = node.close();
    let closed = false;
    void closing.then(() => {
      closed = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(closed).toBe(false);
    release();

    await closing;
    expect(
      transport.sent.map(decodeFrame).some((frame) => {
        if (frame.kind !== FrameKind.complete) return false;
        return testMessage.decode(frame.body).kind === "response";
      }),
    ).toBe(true);
  });

  it("drains an accepted async event listener before close", async () => {
    const transport = new MemoryTransport();
    const node = new FieldLinkNode({ nodeId: nodeB, transport });
    let reportStarted = (): void => undefined;
    const started = new Promise<void>((resolve) => {
      reportStarted = resolve;
    });
    let release = (): void => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    node.onEvent(async () => {
      reportStarted();
      await released;
    });
    transport.inject({
      bytes: encodeFrame({
        transmissionId: 1,
        kind: FrameKind.complete,
        source: nodeA,
        destination: nodeB,
        logicalId: 73n,
        messageType: 1,
        body: testMessage.encode(test("response", 0)),
      }),
    });
    await started;

    let closed = false;
    const closing = node.close().then(() => {
      closed = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(closed).toBe(false);
    release();
    await expect(closing).resolves.toBeUndefined();
  });

  it("cancels a built-in reply queue wait during close", async () => {
    const transport = new MemoryTransport();
    transport.queueLength = 1;
    const node = new FieldLinkNode({ nodeId: nodeB, transport });
    transport.inject({
      bytes: encodeFrame({
        transmissionId: 1,
        kind: FrameKind.complete,
        source: nodeA,
        destination: nodeB,
        logicalId: 74n,
        messageType: 1,
        body: testMessage.encode(test("request", 0)),
      }),
    });
    await eventually(() => transport.queueLengths.length > 0);

    const closing = node.close();
    const result = await Promise.race([
      closing.then(() => "closed" as const),
      new Promise<"timeout">((resolve) => {
        setTimeout(() => resolve("timeout"), 100);
      }),
    ]);
    if (result === "timeout") {
      transport.queueLength = 0;
    }
    await closing;
    expect(result).toBe("closed");
  });

  it("returns the same promise to concurrent close callers", async () => {
    const transport = new MemoryTransport();
    const node = new FieldLinkNode({ nodeId: nodeB, transport });

    const first = node.close();
    const second = node.close();

    expect(second).toBe(first);
    await first;
  });
});

class FailsFirstCompletionTransport extends MemoryTransport {
  failedCompletion = false;

  override send(bytes: Uint8Array): Promise<void> {
    if (
      !this.failedCompletion &&
      decodeFrame(bytes).kind === FrameKind.completion
    ) {
      this.failedCompletion = true;
      return Promise.reject(new Error("completion send failed"));
    }
    return super.send(bytes);
  }
}

class QueuesAfterSendTransport extends MemoryTransport {
  override send(bytes: Uint8Array): Promise<void> {
    const sent = super.send(bytes);
    this.queueLength = 1;
    return sent;
  }
}

class PausesAfterFirstBulkFragmentTransport extends MemoryTransport {
  bulkLogicalId: bigint | undefined;
  paused = false;

  override send(bytes: Uint8Array): Promise<void> {
    const frame = decodeFrame(bytes);
    if (frame.kind === FrameKind.transferStart && frame.priority === "bulk") {
      this.bulkLogicalId = frame.logicalId;
    }
    const sent = super.send(bytes);
    if (
      !this.paused &&
      frame.kind === FrameKind.fragment &&
      frame.logicalId === this.bulkLogicalId
    ) {
      this.paused = true;
      this.queueLength = 1;
    }
    return sent;
  }
}

class FailsRejectionTransport extends MemoryTransport {
  rejectionFailures = 0;

  override send(bytes: Uint8Array): Promise<void> {
    if (decodeFrame(bytes).kind === FrameKind.rejection) {
      this.rejectionFailures += 1;
      return Promise.reject(new Error("rejection send failed"));
    }
    return super.send(bytes);
  }
}

function test(
  kind: "request" | "response",
  payloadBytes: number,
): ReturnType<typeof testMessage.decode> {
  return {
    type: "test",
    kind,
    correlationId: 42,
    payload: Uint8Array.from(
      { length: payloadBytes },
      (_value, index) => index & 0xff,
    ),
  };
}

function transferFrames(
  logicalId: bigint,
  body: Uint8Array,
  retryStrategy: number,
  source = nodeA,
) {
  const fragmentCount = Math.ceil(body.length / TRANSFER_FRAGMENT_BYTES);
  return {
    start: {
      transmissionId: 1,
      kind: FrameKind.transferStart,
      source,
      destination: nodeB,
      logicalId,
      messageType: 1,
      totalLength: body.length,
      fragmentCount,
      fragmentSize: TRANSFER_FRAGMENT_BYTES,
      digest: createHash("sha256").update(body).digest(),
      retryStrategy,
      priority: "normal",
    } as const,
    fragments: Array.from({ length: fragmentCount }, (_value, index) => ({
      transmissionId: index + 2,
      kind: FrameKind.fragment as const,
      source,
      destination: nodeB,
      logicalId,
      fragmentIndex: index,
      body: body.slice(
        index * TRANSFER_FRAGMENT_BYTES,
        (index + 1) * TRANSFER_FRAGMENT_BYTES,
      ),
    })),
  };
}
