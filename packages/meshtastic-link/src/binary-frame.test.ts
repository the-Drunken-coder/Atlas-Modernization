import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  BINARY_V1_VOCABULARY_SHA256,
  decodeBinaryPayload,
  decodeBinaryUtf8,
  encodeBinaryUtf8
} from "./binary-codec.js";
import { encodeCanonicalJSON } from "./canonical-json.js";
import { serializeLinkMessage } from "./contract.js";
import { decodeFrame, type FrameIdentity, fragmentPayload } from "./frame.js";
import { FRAME_BINARY_KEYS, FRAME_BINARY_STRINGS } from "./generated/radio-contract.generated.js";
import { positionPublication } from "./test-fixtures.js";

describe("binary-v1 Link frames", () => {
  it("pins the ordered binary vocabulary", () => {
    const actual = createHash("sha256")
      .update(JSON.stringify([FRAME_BINARY_KEYS, FRAME_BINARY_STRINGS]))
      .digest("hex");
    expect(BINARY_V1_VOCABULARY_SHA256).toBe(actual);
  });

  it("round trips scalar UTF-8 and WTF-8 code units exactly", () => {
    for (const value of ["", "é", "𝄞", "\ud800", "\udfff", "\ud800🚁\udfff"]) {
      expect(decodeBinaryUtf8(encodeBinaryUtf8(value))).toBe(value);
    }
  });

  it("round trips a canonical report, receipt, and lone surrogate without loss", () => {
    const payload = serializeLinkMessage({
      type: "task_report",
      action: "complete",
      task_id: "task-1",
      runtime_id: "runtime-alpha",
      observation_time: "2026-09-02T12:00:00Z",
      body: { output: { text: "\ud800🚁" } }
    });
    const identity: FrameIdentity = {
      ...frameIdentity("task_report"),
      source: { role: "asset", id: "asset-alpha-\ud800" },
      destination: { role: "gateway", id: "gateway-bravo-\udfff" },
      service_session: "session-\ud800",
      operation_id: "report-\udfff",
      message_id: "report-\ud800",
      receipt: { operation_id: "control-\ud800", message_id: "task-\udfff" }
    };
    const frame = fragmentPayload(payload, identity, 233, "binary-v1")[0];
    if (!frame) throw new Error("Missing binary-v1 frame");
    expect(frame[0]).toBe(0xa5);
    const decoded = decodeFrame(frame);
    expect(decoded).toMatchObject(identity);
    expect(Buffer.from(decoded.payload)).toEqual(Buffer.from(payload));
  });

  it("keeps lone-surrogate identities on binary-v1 opaque fragments", () => {
    const payload = randomBytes(1024);
    const identity: FrameIdentity = {
      ...frameIdentity("state"),
      source: { role: "asset", id: "asset-\ud800-alpha" },
      destination: { role: "gateway", id: "gateway-\udfff-bravo" },
      service_session: "session-\ud800",
      operation_id: "operation-\udfff",
      message_id: "message-\ud800"
    };
    const frames = fragmentPayload(payload, identity, 200, "binary-v1");
    expect(frames.length).toBeGreaterThan(1);
    expect(frames.every((frame) => frame[0] === 0xa5 && frame.byteLength <= 200)).toBe(true);
    const decoded = frames.map(decodeFrame).sort((left, right) => left.chunk_index - right.chunk_index);
    expect(Buffer.concat(decoded.map((frame) => Buffer.from(frame.payload)))).toEqual(payload);
    for (const frame of decoded) expect(frame).toMatchObject(identity);
  });

  it("keeps receipt metadata and opaque payloads lossless with unsafe identities", () => {
    const payload = randomBytes(16);
    const identity: FrameIdentity = {
      ...frameIdentity("task_report"),
      source: { role: "asset", id: "asset-\ud800-alpha" },
      destination: { role: "gateway", id: "gateway-\udfff-bravo" },
      service_session: "session-\ud800",
      operation_id: "report-\udfff",
      message_id: "report-\ud800",
      receipt: { operation_id: "control-\ud800", message_id: "task-\udfff" }
    };
    const frame = fragmentPayload(payload, identity, 233, "binary-v1")[0];
    if (!frame) throw new Error("Missing binary-v1 frame");
    expect(frame[0]).toBe(0xa5);
    const decoded = decodeFrame(frame);
    expect(decoded).toMatchObject(identity);
    expect(Buffer.from(decoded.payload)).toEqual(payload);
  });

  it("keeps arbitrary non-JSON payloads lossless through the adaptive fallback", () => {
    const payload = randomBytes(1024);
    const identity = frameIdentity("state");
    const adaptive = fragmentPayload(payload, identity, 200, "binary-v1");
    const fallback = fragmentPayload(payload, identity, 200, "deflate-v2");
    expect(adaptive).toEqual(fallback);
    expect(Buffer.concat(adaptive.map((frame) => Buffer.from(decodeFrame(frame).payload)))).toEqual(payload);
  });

  it("never exceeds deflate-v3 for recorded canonical fixture shapes", () => {
    const fixtures = [
      {
        type: "state" as const,
        payload: serializeLinkMessage(positionPublication(1)),
        identity: frameIdentity("state")
      },
      {
        type: "task_report" as const,
        payload: serializeLinkMessage({
          type: "task_report",
          action: "complete",
          task_id: "task-1",
          runtime_id: "runtime-alpha",
          observation_time: "2026-09-02T12:00:00Z",
          body: { output: { surveyed: true } }
        }),
        identity: frameIdentity("task_report")
      },
      {
        type: "resource_operation" as const,
        payload: serializeLinkMessage({
          type: "resource_operation",
          operation: "task.progress",
          target_id: "task-1",
          runtime_id: "runtime-alpha",
          input: { progress: 0.5 }
        }),
        identity: frameIdentity("resource_operation")
      }
    ];
    for (const fixture of fixtures) {
      const binary = fragmentPayload(fixture.payload, fixture.identity, 233, "binary-v1");
      const deflateV3 = fragmentPayload(fixture.payload, fixture.identity, 233, "deflate-v3");
      expect(binary.reduce((total, frame) => total + frame.byteLength, 0)).toBeLessThanOrEqual(
        deflateV3.reduce((total, frame) => total + frame.byteLength, 0)
      );
      expect(Buffer.concat(binary.map((frame) => Buffer.from(decodeFrame(frame).payload)))).toEqual(
        Buffer.from(fixture.payload)
      );
    }
  });

  it("preserves generic protocol-shaped arrays and unknown fields", () => {
    const prototypeKey = "__proto__";
    const payload = encodeCanonicalJSON({
      extra_field: [null, false, true, -12.5, "unknown-value", { [prototypeKey]: "safe" }],
      type: "plugin.invoke"
    });
    const identity = frameIdentity("data_request");
    const frame = fragmentPayload(payload, identity, 233, "binary-v1")[0];
    if (!frame) throw new Error("Missing binary-v1 frame");
    expect(frame[0]).toBe(0xa5);
    expect(Buffer.from(decodeFrame(frame).payload)).toEqual(Buffer.from(payload));
  });

  it("rejects truncated binary-v1 frames and reports the distinct marker", () => {
    expect(() => decodeFrame(Uint8Array.from([0xa5]))).toThrow();
    expect(() => decodeFrame(Uint8Array.from([0xa8]))).toThrow("Unknown Link frame encoding marker");
    expect(() => decodeBinaryPayload(Uint8Array.from([7]), 0)).toThrow("Unknown binary-v1 value tag");
  });
});

function frameIdentity(messageType: FrameIdentity["message_type"]): FrameIdentity {
  return {
    revision: 1,
    message_type: messageType,
    source: { role: "asset", id: "asset-alpha" },
    source_generation: 1,
    service_session: "session-alpha",
    source_sequence: 1,
    operation_id: "operation-1",
    message_id: "message-1",
    priority: messageType === "task_report" ? "task" : "live_state"
  };
}
