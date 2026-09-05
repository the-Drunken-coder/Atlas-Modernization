import { PassThrough, Writable } from "node:stream";
import { createInterface } from "node:readline";
import { describe, expect, it, vi } from "vitest";

import {
  AdapterProcessNode,
  filteredExecArguments,
  runAdapterProcess,
  serveAdapter,
  type StartAdapterProcessOptions,
} from "../src/adapter-process.js";
import { AdapterEvidence } from "../src/evidence.js";
import { encodeFrame, FrameKind } from "../src/frame.js";
import { observationMessage } from "../src/messages/observation.js";
import { testMessage } from "../src/messages/test.js";
import { FieldLinkNode, parseNodeId } from "../src/node.js";
import type { InboxMessage } from "../src/radio.js";
import { eventually, MemoryTransport } from "./helpers.js";

const nodeA = parseNodeId("aaaaaaaaaaaaaaaa");
const nodeB = parseNodeId("bbbbbbbbbbbbbbbb");

describe("NDJSON adapter server", () => {
  it("stops the adapter after a fatal runtime failure", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const node = new FieldLinkNode({
      nodeId: nodeB,
      transport: new MemoryTransport(),
    });
    const close = vi.spyOn(node, "close");
    let reportFatal: ((error: Error) => void | Promise<void>) | undefined;
    const reader = lineReader(output);
    const serving = serveAdapter({
      path: "test",
      channel: 1,
      input,
      output,
      createRuntime: (options) => {
        reportFatal = options.onFatalError;
        return Promise.resolve({ node, ready: ready(1) });
      },
    });
    await reader.nextType("ready");
    if (reportFatal === undefined) {
      throw new Error("Runtime fatal callback was not installed");
    }

    await reportFatal(new Error("disk full"));

    expect(await reader.nextType("listener-error")).toMatchObject({
      error: "disk full",
    });
    await expect(serving).rejects.toThrow("disk full");
    expect(close).toHaveBeenCalledOnce();
    reader.close();
  });

  it("starts runtime shutdown before a send that ignores abort settles", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let reportSendStarted = (): void => undefined;
    const sendStarted = new Promise<void>((resolve) => {
      reportSendStarted = resolve;
    });
    const node = {
      close: vi.fn(() => Promise.resolve()),
      congestion: () => Promise.resolve({}),
      onEvent: () => () => undefined,
      onMessage: () => () => undefined,
      onPassiveMessage: () => () => undefined,
      publish: () => new Promise<never>(() => undefined),
      send: () => {
        reportSendStarted();
        return new Promise<never>(() => undefined);
      },
    } as unknown as FieldLinkNode;
    const serving = serveAdapter({
      path: "test",
      channel: 1,
      input,
      output,
      teardownTimeoutMs: 25,
      createRuntime: () =>
        Promise.resolve({
          node,
          activate: () => Promise.resolve(),
          ready: ready(1),
        }),
    });
    const reader = lineReader(output);
    await reader.nextType("ready");
    input.write(`${JSON.stringify({ id: 1, type: "activate" })}\n`);
    await reader.nextType("response");
    input.write(
      `${JSON.stringify({
        id: 2,
        type: "send",
        message: {
          type: "test",
          kind: "response",
          correlationId: 1,
          payload: {},
        },
        destination: nodeA,
      })}\n`,
    );
    await sendStarted;
    input.write(`${JSON.stringify({ id: 3, type: "close" })}\n`);
    const stopped = expect(serving).rejects.toThrow(
      "adapter active operations",
    );

    await vi.waitFor(() => {
      expect(node.close).toHaveBeenCalledOnce();
    });
    await stopped;
    reader.close();
  });

  it("stops fatal teardown before a notification write settles", async () => {
    const input = new PassThrough();
    let writeCount = 0;
    let releaseWrite = (): void => undefined;
    const output = new Writable({
      write: (_chunk, _encoding, callback) => {
        writeCount += 1;
        if (writeCount === 1) {
          callback();
        } else {
          releaseWrite = callback;
        }
      },
    });
    const node = new FieldLinkNode({
      nodeId: nodeB,
      transport: new MemoryTransport(),
    });
    const close = vi.spyOn(node, "close");
    let reportFatal: ((error: Error) => void | Promise<void>) | undefined;
    const serving = serveAdapter({
      path: "test",
      channel: 1,
      input,
      output,
      createRuntime: (options) => {
        reportFatal = options.onFatalError;
        return Promise.resolve({ node, ready: ready(1) });
      },
    });
    await vi.waitFor(() => {
      expect(writeCount).toBe(1);
    });
    if (reportFatal === undefined) {
      throw new Error("Runtime fatal callback was not installed");
    }

    reportFatal(new Error("radio failed"));
    await vi.waitFor(() => {
      expect(close).toHaveBeenCalledOnce();
    });
    releaseWrite();
    await expect(serving).rejects.toThrow("radio failed");
  });

  it("interrupts an inline writer wait when fatal teardown starts", async () => {
    const input = new PassThrough();
    let writeCount = 0;
    let releaseWrite = (): void => undefined;
    const output = new Writable({
      write: (_chunk, _encoding, callback) => {
        writeCount += 1;
        if (writeCount === 2) {
          releaseWrite = callback;
          return;
        }
        callback();
      },
    });
    const node = new FieldLinkNode({
      nodeId: nodeB,
      transport: new MemoryTransport(),
    });
    let reportFatal: ((error: Error) => void | Promise<void>) | undefined;
    const serving = serveAdapter({
      path: "test",
      channel: 1,
      input,
      output,
      teardownTimeoutMs: 25,
      createRuntime: (options) => {
        reportFatal = options.onFatalError;
        return Promise.resolve({
          node,
          activate: () => Promise.resolve(),
          ready: ready(1),
        });
      },
    });
    await vi.waitFor(() => {
      expect(writeCount).toBe(1);
    });

    input.write(`${JSON.stringify({ id: 1, type: "activate" })}\n`);
    await vi.waitFor(() => {
      expect(writeCount).toBe(2);
    });
    if (reportFatal === undefined) {
      throw new Error("Runtime fatal callback was not installed");
    }

    reportFatal(new Error("radio failed"));
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      serving.then(
        () => ({ type: "resolved" as const }),
        (error: unknown) => ({ type: "rejected" as const, error }),
      ),
      new Promise<{ readonly type: "timed-out" }>((resolve) => {
        timeout = setTimeout(() => resolve({ type: "timed-out" }), 250);
      }),
    ]);
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
    releaseWrite();
    await expect(serving).rejects.toThrow("radio failed");
    expect(result.type).toBe("rejected");
  });

  it("closes a runtime created after startup cancellation", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const controller = new AbortController();
    const node = new FieldLinkNode({
      nodeId: nodeB,
      transport: new MemoryTransport(),
    });
    const close = vi.spyOn(node, "close");
    const start = vi.fn(() => Promise.resolve());
    const runtime = { node, start, ready: ready(1) };
    const runtimeCreated = new Promise<typeof runtime>((resolve) => {
      controller.signal.addEventListener(
        "abort",
        () => {
          resolve(runtime);
        },
        { once: true },
      );
    });
    const serving = serveAdapter({
      path: "test",
      channel: 1,
      input,
      output,
      signal: controller.signal,
      createRuntime: () => runtimeCreated,
    });

    controller.abort(new Error("startup cancelled"));

    await expect(serving).rejects.toThrow("startup cancelled");
    expect(start).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("closes the runtime to interrupt startup work", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const controller = new AbortController();
    const node = new FieldLinkNode({
      nodeId: nodeB,
      transport: new MemoryTransport(),
    });
    let releaseStart = (): void => undefined;
    const startReleased = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    let reportStart = (): void => undefined;
    const startEntered = new Promise<void>((resolve) => {
      reportStart = resolve;
    });
    const originalClose = node.close.bind(node);
    const close = vi.spyOn(node, "close").mockImplementation(() => {
      releaseStart();
      return originalClose();
    });
    const safetyRelease = setTimeout(releaseStart, 100);
    const serving = serveAdapter({
      path: "test",
      channel: 1,
      input,
      output,
      signal: controller.signal,
      createRuntime: () =>
        Promise.resolve({
          node,
          start: async () => {
            reportStart();
            await startReleased;
          },
          ready: ready(1),
        }),
    });
    await startEntered;

    controller.abort(new Error("startup cancelled"));

    try {
      await expect(serving).rejects.toThrow("startup cancelled");
      expect(close).toHaveBeenCalled();
    } finally {
      clearTimeout(safetyRelease);
    }
  });

  it("reports safe ready metadata and carries typed bytes as base64", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const transport = new MemoryTransport();
    const node = new FieldLinkNode({ nodeId: nodeB, transport });
    let started = false;
    let activated = false;
    const preservedInbox: unknown[] = [];
    let emitInbox:
      ((message: InboxMessage) => void | Promise<void>) | undefined;
    const reader = lineReader(output);
    const serving = serveAdapter({
      path: "/dev/cu.test",
      channel: 2,
      input,
      output,
      processId: 123,
      onInboxMessage: (message) => {
        preservedInbox.push(message);
      },
      createRuntime: (options) => {
        emitInbox = options.onInboxMessage;
        return Promise.resolve({
          node,
          start: () => {
            started = true;
            return Promise.resolve();
          },
          activate: () => {
            activated = true;
            return Promise.resolve();
          },
          ready: ready(123),
        });
      },
    });
    expect(await reader.nextType("ready")).toMatchObject({
      processId: 123,
      nodeId: nodeB,
      supportedMessages: [
        { id: 1, name: "test" },
        { id: 2, name: "resource" },
      ],
      retryStrategies: [{ id: 1, name: "selective-window" }],
    });
    expect(started).toBe(true);
    await emitInbox?.({
      channelMessage: {
        channelIdx: 2,
        pathLen: 1,
        txtType: 0,
        senderTimestamp: 1,
        text: "stale",
      },
    });
    expect(await reader.nextType("inbox-message")).toMatchObject({
      message: { channelMessage: { text: "stale" } },
    });
    expect(preservedInbox).toHaveLength(1);
    input.write(
      `${JSON.stringify({
        id: 1,
        type: "activate",
      })}\n`,
    );
    expect(await reader.nextType("response")).toMatchObject({
      id: 1,
      ok: true,
    });
    expect(activated).toBe(true);
    input.write(`${JSON.stringify({ id: 2, type: "congestion" })}\n`);
    expect(await reader.nextType("response")).toMatchObject({
      id: 2,
      ok: true,
      result: {
        pressure: "idle",
        queues: { pendingSends: 0, activeOutboundTransfers: 0 },
        traffic: { framesSent: 0, retries: 0 },
      },
    });
    input.write(
      `${JSON.stringify({
        id: 3,
        type: "send",
        message: {
          type: "test",
          kind: "response",
          correlationId: 7,
          payload: { $fieldlinkBytes: "AP8=" },
        },
        destination: nodeA,
      })}\n`,
    );
    expect(await reader.nextType("response")).toMatchObject({
      id: 3,
      ok: true,
      result: { delivery: "complete", encodedBytes: 7 },
    });

    transport.inject({
      bytes: encodeFrame({
        transmissionId: 1,
        kind: FrameKind.complete,
        source: nodeA,
        destination: nodeB,
        logicalId: 5n,
        messageType: 1,
        body: testMessage.encode({
          type: "test",
          kind: "response",
          correlationId: 9,
          payload: Uint8Array.of(1, 2, 3),
        }),
      }),
    });
    const message = await reader.nextType("message");
    expect(message).toMatchObject({
      message: {
        message: {
          type: "test",
          kind: "response",
          correlationId: 9,
          payload: { $fieldlinkBytes: "AQID" },
        },
      },
    });
    input.write(`${JSON.stringify({ id: 4, type: "close" })}\n`);
    expect(await reader.nextType("response")).toMatchObject({
      id: 4,
      ok: true,
    });
    input.end();
    await serving;
    reader.close();
  });

  it("requires durable parent acknowledgement for drained inbox messages", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const node = new FieldLinkNode({
      nodeId: nodeB,
      transport: new MemoryTransport(),
    });
    let started = false;
    let outputText = "";
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      outputText += chunk;
    });
    let reportLocalPersistence = (): void => undefined;
    const localPersistenceStarted = new Promise<void>((resolve) => {
      reportLocalPersistence = resolve;
    });
    let releaseLocalPersistence = (): void => undefined;
    const localPersistence = new Promise<void>((resolve) => {
      releaseLocalPersistence = resolve;
    });
    let emitInbox:
      ((message: InboxMessage) => void | Promise<void>) | undefined;
    const reader = lineReader(output);
    const serving = serveAdapter({
      path: "test",
      channel: 1,
      input,
      output,
      parentManagesEvidence: true,
      onInboxMessage: async () => {
        reportLocalPersistence();
        await localPersistence;
      },
      createRuntime: (options) => {
        emitInbox = options.onInboxMessage;
        return Promise.resolve({
          node,
          start: () => {
            started = true;
            return Promise.resolve();
          },
          ready: ready(1),
        });
      },
    });

    await expect(reader.nextType("parent-ready-required")).resolves.toEqual({
      type: "parent-ready-required",
    });
    expect(started).toBe(false);
    input.write(`${JSON.stringify({ id: 1, type: "parent-ready" })}\n`);
    await reader.nextType("ready");
    expect(started).toBe(true);

    if (emitInbox === undefined) {
      throw new Error("Runtime inbox callback was not installed");
    }
    let preserved = false;
    const preserving = Promise.resolve(
      emitInbox({
        channelMessage: {
          channelIdx: 1,
          pathLen: 1,
          txtType: 0,
          senderTimestamp: 1,
          text: "preserve me",
        },
      }),
    ).then(() => {
      preserved = true;
    });
    await localPersistenceStarted;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(outputText).not.toContain('"type":"inbox-message"');
    releaseLocalPersistence();
    const inbox = await reader.nextType("inbox-message");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(preserved).toBe(false);
    input.write(`${JSON.stringify({ type: "inbox-ack", id: inbox.id })}\n`);
    await preserving;
    expect(preserved).toBe(true);

    input.write(`${JSON.stringify({ id: 2, type: "close" })}\n`);
    await reader.nextType("response");
    input.end();
    await serving;
    reader.close();
  });

  it("keeps every stdout line valid JSON", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const lines: string[] = [];
    output.setEncoding("utf8");
    output.on("data", (chunk: string) =>
      lines.push(...chunk.trim().split("\n")),
    );
    const node = new FieldLinkNode({
      nodeId: nodeB,
      transport: new MemoryTransport(),
    });
    const serving = serveAdapter({
      path: "test",
      channel: 1,
      input,
      output,
      createRuntime: () => Promise.resolve({ node, ready: ready(1) }),
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    input.write('{"id":1,"type":"close"}\n');
    input.end();
    await serving;
    expect(lines.length).toBeGreaterThan(0);
    expect(() => {
      for (const line of lines) {
        JSON.parse(line);
      }
    }).not.toThrow();
  });
});

describe("adapter process command", () => {
  it("keeps interruption handlers installed while evidence closes", async () => {
    const originalListeners = new Set(process.listeners("SIGINT"));
    let abort: NodeJS.SignalsListener | undefined;
    let handlerPresentDuringClose = false;
    const evidence = {
      close: () => {
        handlerPresentDuringClose =
          abort !== undefined && process.listeners("SIGINT").includes(abort);
        abort?.("SIGINT");
        return Promise.resolve();
      },
    } as unknown as AdapterEvidence;
    const create = vi
      .spyOn(AdapterEvidence, "create")
      .mockImplementation(() => {
        abort = process
          .listeners("SIGINT")
          .find((listener) => !originalListeners.has(listener));
        abort?.("SIGINT");
        return Promise.resolve(evidence);
      });

    try {
      await expect(
        runAdapterProcess({
          name: "adapter",
          radio: "test",
          channel: 1,
          allowInboxDrain: true,
          evidenceManagedByParent: true,
          output: "test-output",
        }),
      ).resolves.toBe(130);
      expect(create).toHaveBeenCalledWith("test-output");
      expect(handlerPresentDuringClose).toBe(true);
      expect(process.listeners("SIGINT")).toEqual([...originalListeners]);
    } finally {
      create.mockRestore();
    }
  });
});

describe("adapter process proxy", () => {
  it("requires runtime inbox-drain acknowledgement before spawning", async () => {
    const options = {
      path: "test",
      channel: 1,
      allowInboxDrain: false,
      program: nodeScript(cooperativeChildScript()),
    } as unknown as StartAdapterProcessOptions;

    await expect(AdapterProcessNode.start(options)).rejects.toThrow(
      "explicit inbox-drain acknowledgement",
    );
  });

  it("sends typed messages and closes cooperatively", async () => {
    const adapter = await AdapterProcessNode.start({
      path: "test",
      channel: 1,
      allowInboxDrain: true,
      program: nodeScript(cooperativeChildScript()),
    });
    await adapter.activate();
    await expect(adapter.congestion()).resolves.toMatchObject({
      pressure: "idle",
      queues: { pendingSends: 0 },
      traffic: { framesSent: 0 },
    });
    const observation = observationMessage.examples[0];
    if (observation === undefined) {
      throw new Error("missing Observation example");
    }
    await expect(adapter.publish(observation)).resolves.toMatchObject({
      messageName: "observation",
      confirmed: false,
    });
    const result = await adapter.send(
      {
        type: "test",
        kind: "response",
        correlationId: 1,
        payload: Uint8Array.of(1, 2),
      },
      { destination: nodeB },
    );
    expect(result).toMatchObject({ delivery: "complete", encodedBytes: 7 });
    await expect(adapter.close()).resolves.toBeUndefined();
  });

  it("cancels adapter activation and reaps the child", async () => {
    const adapter = await AdapterProcessNode.start({
      path: "test",
      channel: 1,
      allowInboxDrain: true,
      exitTimeoutMs: 10,
      program: nodeScript(`${writeReady()} process.stdin.resume();`),
    });
    const controller = new AbortController();
    const activation = adapter.activate(controller.signal);
    controller.abort(new Error("activation cancelled"));

    await expect(activation).rejects.toThrow("activation cancelled");
    await expect(adapter.close()).rejects.toThrow();
  });

  it("preserves startup inbox evidence without delivering stale messages", async () => {
    const inbox: unknown[] = [];
    const adapter = await AdapterProcessNode.start({
      path: "test",
      channel: 39,
      allowInboxDrain: true,
      onInboxMessage: (message) => {
        inbox.push(message);
      },
      program: nodeScript(preReadyEvidenceChildScript()),
    });
    const messages: unknown[] = [];
    adapter.onMessage((message) => {
      messages.push(message);
    });
    await adapter.activate();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(adapter.channel.index).toBe(39);
    expect(inbox).toHaveLength(1);
    expect(messages).toHaveLength(0);
    await adapter.close();
  });

  it("isolates a synchronous proxy listener failure", async () => {
    const listenerErrors: Error[] = [];
    const adapter = await AdapterProcessNode.start({
      path: "test",
      channel: 1,
      allowInboxDrain: true,
      onListenerError: (error) => {
        listenerErrors.push(error);
      },
      program: nodeScript(listenerFailureChildScript()),
    });
    adapter.onEvent(() => {
      throw new Error("proxy listener failed");
    });

    await adapter.activate();
    await eventually(() => listenerErrors.length === 1);

    expect(listenerErrors[0]?.message).toBe("proxy listener failed");
    await expect(adapter.close()).resolves.toBeUndefined();
  });

  it("drains async proxy listeners before completing close", async () => {
    let release = (): void => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let acknowledgeClose = (): void => undefined;
    const closeAcknowledged = new Promise<void>((resolve) => {
      acknowledgeClose = resolve;
    });
    let observeChildExit = (): void => undefined;
    const childExited = new Promise<void>((resolve) => {
      observeChildExit = resolve;
    });
    let started = 0;
    const adapter = await AdapterProcessNode.start({
      path: "test",
      channel: 1,
      allowInboxDrain: true,
      onStderrEnd: observeChildExit,
      program: nodeScript(listenerDrainChildScript()),
    });
    const listener = async (): Promise<void> => {
      started += 1;
      await released;
    };
    adapter.onMessage(listener);
    adapter.onPassiveMessage(listener);
    adapter.onEvent(async (event) => {
      if (event.type === "adapter-close-ack") {
        acknowledgeClose();
      }
      await listener();
    });

    await adapter.activate();
    await eventually(() => started === 3);

    let closed = false;
    const closing = adapter.close().then(() => {
      closed = true;
    });
    await closeAcknowledged;
    await childExited;
    expect(closed).toBe(false);
    release();
    await expect(closing).resolves.toBeUndefined();
  });

  it("allows a proxy listener to initiate close", async () => {
    let listenerClosed = false;
    const adapter = await AdapterProcessNode.start({
      path: "test",
      channel: 1,
      allowInboxDrain: true,
      exitTimeoutMs: 500,
      program: nodeScript(listenerDrainChildScript()),
    });
    adapter.onMessage(async () => {
      await adapter.close();
      listenerClosed = true;
    });

    await adapter.activate();
    await eventually(() => listenerClosed);
    await expect(adapter.close()).resolves.toBeUndefined();
  });

  it("bounds close when a proxy listener never settles", async () => {
    let reportStarted = (): void => undefined;
    const started = new Promise<void>((resolve) => {
      reportStarted = resolve;
    });
    const adapter = await AdapterProcessNode.start({
      path: "test",
      channel: 1,
      allowInboxDrain: true,
      exitTimeoutMs: 500,
      program: nodeScript(listenerDrainChildScript()),
    });
    adapter.onMessage(() => {
      reportStarted();
      return new Promise<void>(() => undefined);
    });

    await adapter.activate();
    await started;
    await expect(adapter.close()).rejects.toThrow(
      "Timed out waiting for adapter listener callbacks",
    );
  });

  it("reaps an adapter that fails before readiness", async () => {
    await expect(
      AdapterProcessNode.start({
        path: "test",
        channel: 1,
        allowInboxDrain: true,
        exitTimeoutMs: 10,
        program: nodeScript(malformedStartupChildScript()),
      }),
    ).rejects.toThrow();
  });

  it("rejects and reaps startup when its signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("startup cancelled"));

    await expect(
      AdapterProcessNode.start({
        path: "test",
        channel: 1,
        allowInboxDrain: true,
        signal: controller.signal,
        exitTimeoutMs: 10,
        program: nodeScript(`${writeReady()} setInterval(()=>{},1000);`),
      }),
    ).rejects.toThrow("startup cancelled");
  });

  it("cancels and reaps an adapter while waiting for ready", async () => {
    const controller = new AbortController();
    let reportStarted = (): void => undefined;
    const started = new Promise<void>((resolve) => {
      reportStarted = resolve;
    });
    const starting = AdapterProcessNode.start({
      path: "test",
      channel: 1,
      allowInboxDrain: true,
      signal: controller.signal,
      exitTimeoutMs: 10,
      onStderr: (message) => {
        if (message.includes("started")) {
          reportStarted();
        }
      },
      program: nodeScript(uncooperativeStartupChildScript()),
    });
    const rejected = expect(starting).rejects.toThrow("startup cancelled");
    await started;

    controller.abort(new Error("startup cancelled"));

    await rejected;
  });

  it("waits for startup evidence callbacks before completing close", async () => {
    let releaseInbox = (): void => undefined;
    const inboxReleased = new Promise<void>((resolve) => {
      releaseInbox = resolve;
    });
    let inboxStarted = false;
    const adapter = await AdapterProcessNode.start({
      path: "test",
      channel: 1,
      allowInboxDrain: true,
      onInboxMessage: async () => {
        inboxStarted = true;
        await inboxReleased;
      },
      program: nodeScript(closeWithBufferedInboxChildScript()),
    });

    let closed = false;
    const closing = adapter.close().then(() => {
      closed = true;
    });
    await eventually(() => inboxStarted);
    expect(closed).toBe(false);
    releaseInbox();
    await closing;
    expect(closed).toBe(true);
  });

  it("waits for stderr to close before completing adapter close", async () => {
    let stderrEnded = false;
    const adapter = await AdapterProcessNode.start({
      path: "test",
      channel: 1,
      allowInboxDrain: true,
      onStderrEnd: () => {
        stderrEnded = true;
      },
      program: nodeScript(delayedStderrCloseChildScript()),
    });
    await adapter.activate();

    await adapter.close();

    expect(stderrEnded).toBe(true);
  });

  it("rejects pending work when the child exits", async () => {
    const adapter = await AdapterProcessNode.start({
      path: "test",
      channel: 1,
      allowInboxDrain: true,
      program: nodeScript(
        `${writeReady()} ${activateThen("process.exit(7);")}`,
      ),
    });
    await adapter.activate();
    await expect(
      adapter.send(
        {
          type: "test",
          kind: "response",
          correlationId: 1,
          payload: new Uint8Array(),
        },
        { destination: nodeB },
      ),
    ).rejects.toThrow("code 7");
  });

  it("fails and reaps an adapter whose stdout closes unexpectedly", async () => {
    const adapter = await AdapterProcessNode.start({
      path: "test",
      channel: 1,
      allowInboxDrain: true,
      requestTimeoutMs: 10_000,
      exitTimeoutMs: 100,
      program: nodeScript(closedStdoutChildScript()),
    });

    await expect(adapter.activate()).rejects.toThrow(
      "Adapter stdout ended unexpectedly",
    );
    await expect(adapter.close()).rejects.toThrow();
  });

  it("drains the final response before treating child exit as failure", async () => {
    const script = `${writeReady()}
${activateThen('const response={type:"response",id:request.id,ok:true,result:{logicalId:"0000000000000001",messageType:1,messageName:"test",destination:request.destination,priority:"normal",delivery:"complete",encodedBytes:5,fragments:1,transferOpenRetries:0,completionRetries:0,retransmissions:0,receiptRequests:0,receiptRequestRetries:0,receipts:0,durationMs:1}};process.stdout.write(JSON.stringify(response)+"\\n",()=>process.exit(0));')}`;
    const adapter = await AdapterProcessNode.start({
      path: "test",
      channel: 1,
      allowInboxDrain: true,
      program: nodeScript(script),
    });
    await adapter.activate();
    await expect(
      adapter.send(
        {
          type: "test",
          kind: "response",
          correlationId: 1,
          payload: new Uint8Array(),
        },
        { destination: nodeB },
      ),
    ).resolves.toMatchObject({ delivery: "complete" });
  });

  it("propagates abort and persistent request timeout", async () => {
    const aborting = await AdapterProcessNode.start({
      path: "test",
      channel: 1,
      allowInboxDrain: true,
      program: nodeScript(abortChildScript()),
    });
    await aborting.activate();
    const controller = new AbortController();
    const send = aborting.send(
      {
        type: "test",
        kind: "response",
        correlationId: 1,
        payload: new Uint8Array(),
      },
      { destination: nodeB, signal: controller.signal },
    );
    controller.abort(new Error("stop"));
    await expect(send).rejects.toThrow("stop");
    await aborting.close();

    const timingOut = await AdapterProcessNode.start({
      path: "test",
      channel: 1,
      allowInboxDrain: true,
      requestTimeoutMs: 10,
      program: nodeScript(
        `${writeReady()} ${activateThen("")} process.stdin.on("end",()=>process.exit(0)); process.stdin.resume();`,
      ),
    });
    await timingOut.activate();
    await expect(
      timingOut.send(
        {
          type: "test",
          kind: "response",
          correlationId: 1,
          payload: new Uint8Array(),
        },
        { destination: nodeB },
      ),
    ).rejects.toThrow("timed out");
    await expect(timingOut.close()).rejects.toThrow("timed out");
  });

  it("settles an aborted request before the child responds", async () => {
    const adapter = await AdapterProcessNode.start({
      path: "test",
      channel: 1,
      allowInboxDrain: true,
      requestTimeoutMs: 10_000,
      program: nodeScript(unresponsiveAbortChildScript()),
    });
    await adapter.activate();
    const controller = new AbortController();
    let settled = false;
    const send = adapter.send(
      {
        type: "test",
        kind: "response",
        correlationId: 1,
        payload: new Uint8Array(),
      },
      { destination: nodeB, signal: controller.signal },
    );
    const observed = send.then(
      () => undefined,
      () => {
        settled = true;
      },
    );

    controller.abort(new Error("stop"));
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(true);
      await expect(send).rejects.toThrow("stop");
    } finally {
      await adapter.close();
      await observed;
    }
  });

  it("force-stops and reaps an adapter that ignores termination", async () => {
    const adapter = await AdapterProcessNode.start({
      path: "test",
      channel: 1,
      allowInboxDrain: true,
      exitTimeoutMs: 10,
      program: nodeScript(uncooperativeCloseChildScript()),
    });
    await adapter.activate();

    await expect(adapter.close()).rejects.toThrow(
      "Could not close adapter process",
    );
  });

  it("bounds an ignored close request with the exit timeout", async () => {
    const adapter = await AdapterProcessNode.start({
      path: "test",
      channel: 1,
      allowInboxDrain: true,
      requestTimeoutMs: 500,
      exitTimeoutMs: 10,
      program: nodeScript(ignoredCloseChildScript()),
    });
    await adapter.activate();

    const closing = adapter.close();
    await expect(
      adapter.send(
        {
          type: "test",
          kind: "response",
          correlationId: 1,
          payload: new Uint8Array(),
        },
        { destination: nodeB },
      ),
    ).rejects.toThrow("Adapter is closed");
    await expect(closing).rejects.toThrow("timed out after 10 ms");
  });

  it("returns the same cleanup result to concurrent close callers", async () => {
    const adapter = await AdapterProcessNode.start({
      path: "test",
      channel: 1,
      allowInboxDrain: true,
      requestTimeoutMs: 500,
      exitTimeoutMs: 10,
      program: nodeScript(ignoredCloseChildScript()),
    });
    await adapter.activate();

    const first = adapter.close();
    const second = adapter.close();

    expect(second).toBe(first);
    const [firstResult, secondResult] = await Promise.allSettled([
      first,
      second,
    ]);
    expect(firstResult.status).toBe("rejected");
    expect(secondResult.status).toBe("rejected");
    if (
      firstResult.status === "rejected" &&
      secondResult.status === "rejected"
    ) {
      expect(secondResult.reason).toBe(firstResult.reason);
    }
  });

  it("reports a nonzero adapter exit during close", async () => {
    const adapter = await AdapterProcessNode.start({
      path: "test",
      channel: 1,
      allowInboxDrain: true,
      program: nodeScript(nonzeroCloseChildScript()),
    });
    await adapter.activate();

    await expect(adapter.close()).rejects.toThrow("code 7");
  });

  it("removes controller-only execution flags from child arguments", () => {
    expect(
      filteredExecArguments([
        "--import",
        "tsx",
        "--inspect=9229",
        "--inspect-wait",
        "--inspect-wait=9230",
        "--watch-path",
        "src",
        "--conditions=development",
      ]),
    ).toEqual(["--import", "tsx", "--conditions=development"]);
  });
});

function ready(processId: number, channelIndex = 1) {
  return {
    processId,
    identity: {
      nodeId: nodeB,
      fingerprint: nodeB,
      name: "test",
      model: "fake",
      firmwareVersion: "1",
      firmwareBuildDate: "2026-01-01",
      firmwareProtocolCode: 12,
      clientProtocolVersion: 1,
      radio: {
        frequency: 915_000_000,
        bandwidth: 250_000,
        spreadingFactor: 10,
        codingRate: 5,
        transmitPower: 10,
        maximumTransmitPower: 22,
      },
    },
    channel: {
      index: channelIndex,
      name: "test",
      configured: true,
      keyFingerprint: "0011223344556677",
    },
    nodeId: nodeB,
    supportedMessages: [
      { id: 1, name: "test", defaultPriority: "normal" as const },
      { id: 2, name: "resource", defaultPriority: "normal" as const },
    ],
    retryStrategies: [{ id: 1, name: "selective-window" as const }],
    delivery: {
      meshCoreDataType: 0xffff,
      meshCoreMode: "flood" as const,
      maximumChannelDatagramBytes: 163 as const,
    },
  };
}

function lineReader(output: PassThrough) {
  const lines = createInterface({ input: output, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  return {
    async nextType(type: string): Promise<Record<string, unknown>> {
      for (;;) {
        const next = await iterator.next();
        if (next.done) {
          throw new Error(`stdout ended before ${type}`);
        }
        const value = JSON.parse(next.value) as Record<string, unknown>;
        if (value.type === type) {
          return value;
        }
      }
    },
    close: () => {
      lines.close();
    },
  };
}

function nodeScript(source: string) {
  return { executable: process.execPath, arguments: ["-e", source] };
}

function writeReady(channelIndex = 1): string {
  return `process.stdout.write(${JSON.stringify(`${JSON.stringify({ type: "ready", ...ready(999, channelIndex) })}\n`)});`;
}

function preReadyEvidenceChildScript(): string {
  const inbox = {
    type: "inbox-message",
    id: 1,
    message: {
      channelMessage: {
        channelIdx: 39,
        pathLen: 1,
        txtType: 0,
        senderTimestamp: 1,
        text: "stale",
      },
    },
  };
  const stale = {
    type: "message",
    message: {
      message: {
        type: "test",
        kind: "response",
        correlationId: 1,
        payload: { $fieldlinkBytes: "" },
      },
      source: nodeA,
      destination: nodeB,
      logicalId: "0000000000000001",
      delivery: "complete",
      receivedAt: "2026-08-24T12:00:00.000Z",
    },
  };
  return `process.stdout.write(${JSON.stringify(`${JSON.stringify(inbox)}\n${JSON.stringify(stale)}\n${JSON.stringify({ type: "ready", ...ready(999, 39) })}\n`)});
${activateThen('if(request.type==="close"){process.stdout.write(JSON.stringify({type:"response",id:request.id,ok:true})+"\\n",()=>process.exit(0));}')}`;
}

function closeWithBufferedInboxChildScript(): string {
  const inbox = {
    type: "inbox-message",
    id: 1,
    message: {
      channelMessage: {
        channelIdx: 1,
        pathLen: 1,
        txtType: 0,
        senderTimestamp: 1,
        text: "final",
      },
    },
  };
  return `${writeReady()}
let pending="",closeId;
process.stdin.setEncoding("utf8");
process.stdin.on("data",chunk=>{pending+=chunk;let i;while((i=pending.indexOf("\\n"))>=0){const line=pending.slice(0,i);pending=pending.slice(i+1);if(!line)continue;const request=JSON.parse(line);if(request.type==="close"){closeId=request.id;process.stdout.write(${JSON.stringify(`${JSON.stringify(inbox)}\n`)});}else if(request.type==="inbox-ack"){process.stdout.write(JSON.stringify({type:"response",id:closeId,ok:true})+"\\n",()=>process.exit(0));}}});`;
}

function cooperativeChildScript(): string {
  const congestion = {
    sampledAt: "2026-08-26T12:00:00.000Z",
    windowMs: 60_000,
    pressure: "idle",
    queues: {
      pendingSends: 0,
      activeOutboundTransfers: 0,
      waitingOutboundTransfers: 0,
      activeInboundTransfers: 0,
      activePassiveInboundTransfers: 0,
      scheduledFrames: { high: 0, normal: 0, bulk: 0 },
      meshcoreQueueLength: 0,
    },
    traffic: {
      framesSent: 0,
      bytesSent: 0,
      retries: 0,
      transportErrors: 0,
    },
    waitMs: {
      high: { samples: 0, meanMs: 0, maximumMs: 0 },
      normal: { samples: 0, meanMs: 0, maximumMs: 0 },
      bulk: { samples: 0, meanMs: 0, maximumMs: 0 },
    },
  };
  return `${writeReady()}
let pending="";
process.stdin.setEncoding("utf8");
process.stdin.on("data",chunk=>{pending+=chunk;let i;while((i=pending.indexOf("\\n"))>=0){const line=pending.slice(0,i);pending=pending.slice(i+1);if(!line)continue;const request=JSON.parse(line);if(request.type==="activate"){process.stdout.write(JSON.stringify({type:"response",id:request.id,ok:true})+"\\n");}else if(request.type==="congestion"){process.stdout.write(JSON.stringify({type:"response",id:request.id,ok:true,result:${JSON.stringify(congestion)}})+"\\n");}else if(request.type==="publish"){process.stdout.write(JSON.stringify({type:"response",id:request.id,ok:true,result:{logicalId:"0000000000000002",messageType:5,messageName:"observation",priority:"normal",delivery:"transfer",confirmed:false,encodedBytes:256,fragments:3,durationMs:2}})+"\\n");}else if(request.type==="send"){process.stdout.write(JSON.stringify({type:"response",id:request.id,ok:true,result:{logicalId:"0000000000000001",messageType:1,messageName:"test",destination:request.destination,priority:"normal",delivery:"complete",encodedBytes:7,fragments:1,transferOpenRetries:0,completionRetries:0,retransmissions:0,receiptRequests:0,receiptRequestRetries:0,receipts:0,durationMs:1}})+"\\n");}else if(request.type==="close"){process.stdout.write(JSON.stringify({type:"response",id:request.id,ok:true})+"\\n",()=>process.exit(0));}}});`;
}

function listenerFailureChildScript(): string {
  return `${writeReady()}
let pending="";
process.stdin.setEncoding("utf8");
process.stdin.on("data",chunk=>{pending+=chunk;let i;while((i=pending.indexOf("\\n"))>=0){const line=pending.slice(0,i);pending=pending.slice(i+1);if(!line)continue;const request=JSON.parse(line);if(request.type==="activate"){const response=JSON.stringify({type:"response",id:request.id,ok:true});const event=JSON.stringify({type:"event",event:{type:"protocol-error",at:"2026-08-24T12:00:00.000Z",message:"test"}});process.stdout.write(response+"\\n"+event+"\\n");}else if(request.type==="close"){process.stdout.write(JSON.stringify({type:"response",id:request.id,ok:true})+"\\n",()=>process.exit(0));}}});`;
}

function listenerDrainChildScript(): string {
  const message = {
    message: {
      type: "test",
      kind: "response",
      correlationId: 1,
      payload: { $fieldlinkBytes: "" },
    },
    source: nodeA,
    destination: nodeB,
    logicalId: "0000000000000001",
    delivery: "complete",
    receivedAt: "2026-08-24T12:00:00.000Z",
  };
  const notifications = [
    { type: "message", message },
    { type: "passive-message", message },
    {
      type: "event",
      event: {
        type: "protocol-error",
        at: "2026-08-24T12:00:00.000Z",
        message: "test",
      },
    },
  ]
    .map((value) => JSON.stringify(value))
    .join("\n");
  const closeAcknowledgement = JSON.stringify({
    type: "event",
    event: {
      type: "adapter-close-ack",
      at: "2026-08-24T12:00:00.000Z",
      message: "close acknowledged",
    },
  });
  return `${writeReady()}
let pending="";
process.stdin.setEncoding("utf8");
process.stdin.on("data",chunk=>{pending+=chunk;let i;while((i=pending.indexOf("\\n"))>=0){const line=pending.slice(0,i);pending=pending.slice(i+1);if(!line)continue;const request=JSON.parse(line);if(request.type==="activate"){const response=JSON.stringify({type:"response",id:request.id,ok:true});process.stdout.write(response+"\\n"+${JSON.stringify(`${notifications}\n`)});}else if(request.type==="close"){const response=JSON.stringify({type:"response",id:request.id,ok:true});process.stderr.write("closing\\n");process.stdout.write(response+"\\n"+${JSON.stringify(`${closeAcknowledgement}\n`)},()=>setTimeout(()=>process.exit(0),25));}}});`;
}

function closedStdoutChildScript(): string {
  return `${writeReady()}
process.on("SIGTERM",()=>process.exit(0));
process.stdout.end();
setInterval(()=>{},1000);`;
}

function abortChildScript(): string {
  return `${writeReady()}
let pending="",sendId;
process.stdin.setEncoding("utf8");
process.stdin.on("data",chunk=>{pending+=chunk;let i;while((i=pending.indexOf("\\n"))>=0){const line=pending.slice(0,i);pending=pending.slice(i+1);if(!line)continue;const request=JSON.parse(line);if(request.type==="activate"){process.stdout.write(JSON.stringify({type:"response",id:request.id,ok:true})+"\\n");}else if(request.type==="send"){sendId=request.id;}else if(request.type==="abort"){process.stdout.write(JSON.stringify({type:"response",id:sendId,ok:false,error:"Adapter request aborted"})+"\\n");}else if(request.type==="close"){process.stdout.write(JSON.stringify({type:"response",id:request.id,ok:true})+"\\n",()=>process.exit(0));}}});`;
}

function unresponsiveAbortChildScript(): string {
  return `${writeReady()}
let pending="",sendId;
process.stdin.setEncoding("utf8");
process.stdin.on("data",chunk=>{pending+=chunk;let i;while((i=pending.indexOf("\\n"))>=0){const line=pending.slice(0,i);pending=pending.slice(i+1);if(!line)continue;const request=JSON.parse(line);if(request.type==="activate"){process.stdout.write(JSON.stringify({type:"response",id:request.id,ok:true})+"\\n");}else if(request.type==="send"){sendId=request.id;}else if(request.type==="close"){const responses=JSON.stringify({type:"response",id:sendId,ok:false,error:"send stopped"})+"\\n"+JSON.stringify({type:"response",id:request.id,ok:true})+"\\n";process.stdout.write(responses,()=>process.exit(0));}}});`;
}

function delayedStderrCloseChildScript(): string {
  return `${writeReady()}
const {spawn}=require("node:child_process");
${activateThen('if(request.type==="close"){spawn(process.execPath,["-e","setTimeout(()=>{},100)"],{stdio:["ignore","ignore",process.stderr]});process.stdout.write(JSON.stringify({type:"response",id:request.id,ok:true})+"\\n",()=>process.exit(0));}')}`;
}

function activateThen(next: string): string {
  return `let pending="";
process.stdin.setEncoding("utf8");
process.stdin.on("data",chunk=>{pending+=chunk;let i;while((i=pending.indexOf("\\n"))>=0){const line=pending.slice(0,i);pending=pending.slice(i+1);if(!line)continue;const request=JSON.parse(line);if(request.type==="activate"){process.stdout.write(JSON.stringify({type:"response",id:request.id,ok:true})+"\\n");}else{${next}}}});`;
}

function uncooperativeCloseChildScript(): string {
  return `${writeReady()}
${activateThen('if(request.type==="close"){process.stdout.write(JSON.stringify({type:"response",id:request.id,ok:true})+"\\n");}')}
process.on("SIGTERM",()=>{});
setInterval(()=>{},1000);`;
}

function ignoredCloseChildScript(): string {
  return `${writeReady()}
${activateThen("")}
process.stdin.on("end",()=>process.exit(0));
process.stdin.resume();`;
}

function nonzeroCloseChildScript(): string {
  return `${writeReady()}
${activateThen('if(request.type==="close"){process.stdout.write(JSON.stringify({type:"response",id:request.id,ok:true})+"\\n",()=>process.exit(7));}')}`;
}

function malformedStartupChildScript(): string {
  return `process.on("SIGTERM",()=>{});
setInterval(()=>{},1000);
process.stdout.write("{malformed}\\n");`;
}

function uncooperativeStartupChildScript(): string {
  return `process.stderr.write("started\\n");
process.on("SIGTERM",()=>{});
setInterval(()=>{},1000);`;
}
