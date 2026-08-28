import { describe, expect, it } from "vitest";

import {
  attachTaskRequestHandler,
  taskMessage,
  type SupportedMessage,
  type TaskRequest,
  type TaskResponse,
} from "../src/messages/index.js";
import {
  parseNodeId,
  type NodeId,
  type ReceivedMessage,
  type SendOptions,
  type SendResult,
} from "../src/node.js";

describe("Task message", () => {
  it("round-trips state, synchronization, and lifecycle operations", () => {
    for (const example of taskMessage.examples) {
      expect(taskMessage.validate(example)).toBe(true);
      expect(taskMessage.decode(taskMessage.encode(example))).toEqual(example);
    }
  });

  it("rejects generic mutation and invalid lifecycle bodies", () => {
    expect(
      taskMessage.validate({
        type: "task",
        kind: "request",
        operation: "delete",
        request_id: "delete-1",
        task_id: "task-1",
        runtime_id: "runtime-1",
      }),
    ).toBe(false);
    expect(
      taskMessage.validate({
        type: "task",
        kind: "request",
        operation: "progress",
        request_id: "progress-1",
        task_id: "task-1",
        runtime_id: "runtime-1",
        body: { progress: Number.NaN },
      }),
    ).toBe(false);
    expect(
      taskMessage.validate({
        type: "task",
        kind: "state",
        task: { task_id: "task-1", status: "pending" },
      }),
    ).toBe(false);
  });

  it("executes only allowed requests and replays the response", async () => {
    const node = new TaskHandlerNode();
    const executor = new TaskExecutorProbe();
    const allowed = parseNodeId("aaaaaaaaaaaaaaaa");
    const request = taskMessage.examples.find(
      (message): message is Extract<TaskRequest, { operation: "sync" }> =>
        message.kind === "request" && message.operation === "sync",
    );
    if (request === undefined) throw new Error("missing sync example");
    const dispose = attachTaskRequestHandler(node, executor, allowed);

    await node.emit(request, parseNodeId("cccccccccccccccc"));
    await node.emit(request, allowed);
    await node.emit(request, allowed);

    expect(executor.requests).toEqual([request]);
    expect(node.sent).toHaveLength(2);
    expect(node.sent[0]?.message).toMatchObject({
      type: "task",
      kind: "response",
      request_id: request.request_id,
      status: 200,
    });
    await dispose();
    expect(node.sent[0]?.options.signal?.aborted).toBe(true);
  });
});

class TaskExecutorProbe {
  readonly requests: TaskRequest[] = [];

  execute(request: TaskRequest): Promise<TaskResponse> {
    this.requests.push(request);
    return Promise.resolve({
      type: "task",
      kind: "response",
      request_id: request.request_id,
      status: 200,
      body: { tasks: [] },
    });
  }
}

class TaskHandlerNode {
  readonly sent: {
    readonly message: SupportedMessage;
    readonly options: SendOptions;
  }[] = [];
  #listener: ((message: ReceivedMessage) => void | Promise<void>) | undefined;

  onMessage(
    listener: (message: ReceivedMessage) => void | Promise<void>,
  ): () => void {
    this.#listener = listener;
    return () => {
      this.#listener = undefined;
    };
  }

  send(message: SupportedMessage, options: SendOptions): Promise<SendResult> {
    this.sent.push({ message, options });
    return Promise.resolve({
      logicalId: "0000000000000001",
      messageType: 4,
      messageName: "task",
      destination: parseNodeId(options.destination),
      priority: "high",
      delivery: "complete",
      encodedBytes: 1,
      fragments: 1,
      transferOpenRetries: 0,
      completionRetries: 0,
      retransmissions: 0,
      receiptRequests: 0,
      receiptRequestRetries: 0,
      receipts: 0,
      durationMs: 1,
    });
  }

  async emit(message: TaskRequest, source: NodeId): Promise<void> {
    await this.#listener?.({
      message,
      source,
      destination: parseNodeId("bbbbbbbbbbbbbbbb"),
      logicalId: "0000000000000001",
      delivery: "complete",
      receivedAt: new Date(),
    });
  }
}
