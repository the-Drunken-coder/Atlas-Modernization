import { describe, expect, it } from "vitest";

import {
  attachRuntimeRequestHandler,
  runtimeMessage,
  type RuntimeRequest,
  type RuntimeResponse,
  type SupportedMessage,
} from "../src/messages/index.js";
import {
  parseNodeId,
  type NodeId,
  type ReceivedMessage,
  type SendOptions,
  type SendResult,
} from "../src/node.js";

describe("Runtime message", () => {
  it("validates the broad lifecycle operations", () => {
    for (const example of runtimeMessage.examples) {
      expect(runtimeMessage.validate(example)).toBe(true);
      expect(runtimeMessage.decode(runtimeMessage.encode(example))).toEqual(
        example,
      );
    }
    expect(
      runtimeMessage.validate({
        type: "runtime",
        kind: "request",
        operation: "register",
        request_id: "register-1",
        asset_id: "asset-1",
        runtime_id: "runtime-1",
        asset: { entity_id: "different", entity_type: "asset" },
      }),
    ).toBe(false);
    expect(
      runtimeMessage.validate({
        type: "runtime",
        kind: "request",
        operation: "ready",
        request_id: "ready-1",
        asset_id: "asset-1",
        runtime_id: "runtime-1",
        manifest: [Number.NaN],
      }),
    ).toBe(false);
    expect(
      runtimeMessage.validate({
        type: "runtime",
        kind: "request",
        operation: "check_in",
        request_id: "check-in-1",
        asset_id: "asset-1",
        runtime_id: "runtime-1",
        body: { telemetry: { latitude: 38.8977 } },
      }),
    ).toBe(false);
    expect(
      runtimeMessage.validate({
        type: "runtime",
        kind: "request",
        operation: "check_in",
        request_id: "check-in-1",
        asset_id: "asset-1",
        runtime_id: "runtime-1",
        body: { latitude: 91 },
      }),
    ).toBe(false);
  });

  it("matches a response only at the request source", () => {
    const sent = registerRequest();
    const received = {
      type: "runtime",
      kind: "response",
      request_id: sent.request_id,
      status: 204,
    } as const;

    expect(
      runtimeMessage.exercise.isComplete({
        sent,
        received,
        side: "source",
      }),
    ).toBe(true);
    expect(
      runtimeMessage.exercise.isComplete({
        sent,
        received,
        side: "destination",
      }),
    ).toBe(false);
  });

  it("executes only allowed requests and replays a cached response", async () => {
    const node = new RuntimeHandlerNode();
    const executor = new RuntimeExecutorProbe();
    const allowed = parseNodeId("aaaaaaaaaaaaaaaa");
    const dispose = attachRuntimeRequestHandler(node, executor, allowed);
    const request = registerRequest();

    await node.emit(request, parseNodeId("cccccccccccccccc"));
    await node.emit(request, allowed);
    await node.emit(request, allowed);

    expect(executor.requests).toHaveLength(1);
    expect(node.sent).toHaveLength(2);
    expect(node.sent[0]?.message).toMatchObject({
      type: "runtime",
      kind: "response",
      request_id: request.request_id,
      status: 204,
    });
    await dispose();
    expect(node.sent[0]?.options.signal?.aborted).toBe(true);
  });

  it("rejects request ID reuse with different Runtime JSON", async () => {
    const node = new RuntimeHandlerNode();
    const executor = new RuntimeExecutorProbe();
    const allowed = parseNodeId("aaaaaaaaaaaaaaaa");
    const dispose = attachRuntimeRequestHandler(node, executor, allowed);
    const request = registerRequest();

    await node.emit(request, allowed);
    await node.emit({ ...request, runtime_id: "runtime-2" }, allowed);

    expect(executor.requests).toHaveLength(1);
    expect(node.sent[1]?.message).toMatchObject({ status: 409 });
    await dispose();
  });
});

class RuntimeExecutorProbe {
  readonly requests: RuntimeRequest[] = [];

  execute(request: RuntimeRequest): Promise<RuntimeResponse> {
    this.requests.push(request);
    return Promise.resolve({
      type: "runtime",
      kind: "response",
      request_id: request.request_id,
      status: 204,
    });
  }
}

class RuntimeHandlerNode {
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
      messageType: 3,
      messageName: "runtime",
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

  async emit(message: RuntimeRequest, source: NodeId): Promise<void> {
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

function registerRequest() {
  return {
    type: "runtime" as const,
    kind: "request" as const,
    operation: "register" as const,
    request_id: "register-1",
    asset_id: "asset-1",
    runtime_id: "runtime-1",
    asset: { entity_id: "asset-1", entity_type: "asset" },
  };
}
