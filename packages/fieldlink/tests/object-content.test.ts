import { describe, expect, it } from "vitest";

import { objectContentMessage } from "../src/messages/object-content.js";
import { FieldLinkNode, parseNodeId } from "../src/node.js";
import { memoryTransportPair } from "./helpers.js";

describe("Object-content message", () => {
  it("round-trips raw text and binary bytes without base64", () => {
    for (const example of objectContentMessage.examples) {
      expect(objectContentMessage.validate(example)).toBe(true);
      expect(
        objectContentMessage.decode(objectContentMessage.encode(example)),
      ).toEqual(example);
    }
    expect(
      objectContentMessage.decode(
        objectContentMessage.encode({
          type: "object-content",
          object_id: "empty-object",
          content: new Uint8Array(),
        }),
      ).content,
    ).toHaveLength(0);
  });

  it("rejects malformed headers and messages over the FieldLink bound", () => {
    expect(() => objectContentMessage.decode(Uint8Array.of(0, 0))).toThrow();
    expect(() =>
      objectContentMessage.encode({
        type: "object-content",
        object_id: "too-large",
        content: new Uint8Array(1024 * 1024),
      }),
    ).toThrow("exceeds");
  });

  it("moves exact large content at bulk priority", async () => {
    const [aTransport, bTransport] = memoryTransportPair();
    const a = new FieldLinkNode({
      nodeId: parseNodeId("aaaaaaaaaaaaaaaa"),
      transport: aTransport,
    });
    const b = new FieldLinkNode({
      nodeId: parseNodeId("bbbbbbbbbbbbbbbb"),
      transport: bTransport,
    });
    const content = new Uint8Array(16_384);
    for (let index = 0; index < content.length; index += 1) {
      content[index] = index & 0xff;
    }
    let received: Uint8Array | undefined;
    b.onMessage((message) => {
      if (message.message.type === "object-content") {
        received = message.message.content;
      }
    });

    const result = await a.send(
      {
        type: "object-content",
        object_id: "matrix-1",
        content_type: "application/octet-stream",
        content,
      },
      { destination: b.nodeId },
    );

    expect(result).toMatchObject({
      messageName: "object-content",
      priority: "bulk",
      delivery: "transfer",
    });
    expect(received).toEqual(content);
    await Promise.all([a.close(), b.close()]);
  });
});
