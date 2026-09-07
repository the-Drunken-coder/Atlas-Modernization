import { brotliCompressSync, constants, deflateRawSync, zstdCompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { encodeBinaryPayload } from "./binary-codec.js";
import { encodeCanonicalJSON } from "./canonical-json.js";
import { encodeCompactValue } from "./compact-value.js";
import { compressValue, decompressValue, restoreValue } from "./compression-methods.js";
import { serializeLinkMessage } from "./contract.js";
import { decodeFrame, type FrameIdentity, fragmentPayload } from "./frame.js";
import { FRAME_DICTIONARY } from "./generated/radio-contract.generated.js";
import { decodeMessagePayload } from "./message-codec.js";

const MAX_MESSAGE_BYTES = 128 * 1024;
const MAX_DECOMPRESSED_BYTES = MAX_MESSAGE_BYTES * 8 + 64;
const dictionary = Buffer.from(FRAME_DICTIONARY);

describe("message-v2 compression methods", () => {
  it("round trips all nine algorithm and representation modes", () => {
    const payload = encodeCanonicalJSON({
      type: "task_report",
      task_id: "task-α-🚁",
      runtime_id: "runtime-alpha",
      observation_time: "2026-09-06T12:00:00Z",
      body: { output: { detail: "known-value ".repeat(80), complete: true } }
    });
    const binary = encodeBinaryPayload(payload);
    const compact = encodeCompactValue(payload);
    if (binary === undefined || compact === undefined) throw new Error("Expected both alternate representations");

    const representations = [payload, binary, compact];
    for (let mode = 0; mode <= 8; mode++) {
      const compressed = compressForMode(mode, representations[mode % 3]!);
      const envelope = Buffer.concat([Buffer.from([0xb3, 1, mode]), compressed]);
      expect(Buffer.from(decodeMessagePayload(envelope))).toEqual(Buffer.from(payload));
      expect(Buffer.from(restoreValue(mode, decompressValue(mode, compressed, MAX_DECOMPRESSED_BYTES)))).toEqual(
        Buffer.from(payload)
      );
    }
  });

  it("round trips the automatically selected method and representation", () => {
    const payload = encodeCanonicalJSON({
      entities: Array.from({ length: 120 }, (_, index) => ({
        id: `entity-${index}`,
        status: index % 2 === 0 ? "active" : "standby",
        description: "Repeated sensor observation with stable vocabulary"
      }))
    });
    const selected = compressValue(payload);
    expect(selected.mode).toBeGreaterThanOrEqual(0);
    expect(selected.mode).toBeLessThanOrEqual(8);
    expect(
      Buffer.from(restoreValue(selected.mode, decompressValue(selected.mode, selected.bytes, MAX_DECOMPRESSED_BYTES)))
    ).toEqual(Buffer.from(payload));
  });

  it("rejects unknown modes, truncation, trailing bytes, and output overflows", () => {
    expect(() => decodeMessagePayload(Buffer.from([0xb3, 1, 9]))).toThrow("Unknown");
    expect(() => decompressValue(9, new Uint8Array(), MAX_DECOMPRESSED_BYTES)).toThrow("Unknown");
    expect(() => restoreValue(9, new Uint8Array([1]))).toThrow("Unknown");
    expect(() => decodeMessagePayload(Buffer.from([0xb3]))).toThrow();
    expect(() => decodeMessagePayload(Buffer.from([0xb3, 1, 0]))).toThrow();

    const payload = Buffer.from("truncation fixture ".repeat(100));
    for (const mode of [0, 3, 6]) {
      const compressed = compressForMode(mode, payload);
      expect(() => decompressValue(mode, compressed.subarray(0, -1), MAX_DECOMPRESSED_BYTES)).toThrow();
      expect(() =>
        decompressValue(mode, Buffer.concat([compressed, Buffer.from([0])]), MAX_DECOMPRESSED_BYTES)
      ).toThrow();
      expect(() =>
        decodeMessagePayload(Buffer.concat([Buffer.from([0xb3, 1, mode]), compressed, Buffer.from([0])]))
      ).toThrow();
      const oversizedCompressed = compressForMode(mode, Buffer.alloc(MAX_MESSAGE_BYTES + 1, 0x61));
      expect(() => decompressValue(mode, oversizedCompressed, MAX_MESSAGE_BYTES)).toThrow();
      expect(() => decodeMessagePayload(Buffer.concat([Buffer.from([0xb3, 1, mode]), oversizedCompressed]))).toThrow();
    }
    expect(() => compressValue(new Uint8Array(MAX_MESSAGE_BYTES + 1))).toThrow("128 KiB");
  });

  it("does not increase complete framed bytes or packet count across payload caps", () => {
    const identity: FrameIdentity = {
      revision: 1,
      message_type: "task_report",
      source: { role: "asset", id: "asset-a" },
      destination: { role: "gateway", id: "gateway" },
      source_generation: 1,
      service_session: "session-a",
      source_sequence: 1,
      operation_id: "report-a",
      message_id: "message-a",
      priority: "task"
    };
    for (const length of [8, 40, 160]) {
      const payload = serializeLinkMessage({
        type: "task_report",
        action: "complete",
        task_id: "task-a",
        runtime_id: "runtime-a",
        observation_time: "2026-09-06T12:00:00Z",
        body: { output: Array.from({ length }, (_, index) => ({ sample: index, status: "active" })) }
      });
      for (const cap of [180, 219, 227, 233]) {
        const before = fragmentPayload(payload, identity, cap, "message-v1");
        const after = fragmentPayload(payload, identity, cap, "message-v2");
        expect(after.length).toBeLessThanOrEqual(before.length);
        expect(after.reduce((sum, frame) => sum + frame.byteLength, 0)).toBeLessThanOrEqual(
          before.reduce((sum, frame) => sum + frame.byteLength, 0)
        );
        expect(after.every((frame) => frame.byteLength <= cap)).toBe(true);
        const decoded = after.map(decodeFrame);
        expect(Buffer.from(decodeMessagePayload(Buffer.concat(decoded.map((frame) => frame.payload))))).toEqual(
          Buffer.from(payload)
        );
      }
    }
  });

  it("keeps Unicode headers and receipt identity in the joint method frame", () => {
    const identity: FrameIdentity = {
      revision: 1,
      message_type: "task_report",
      source: { role: "asset", id: "asset-α-\ud800" },
      destination: { role: "gateway", id: "gateway-🚁-\udfff" },
      source_generation: 7,
      service_session: "session-𝄞-\ud800",
      source_sequence: 19,
      operation_id: "report-α-\udfff",
      message_id: "message-🚁-\ud800",
      receipt: { operation_id: "control-α-\ud800", message_id: "task-🚁-\udfff" },
      priority: "task"
    };
    const payload = serializeLinkMessage({
      type: "task_report",
      action: "complete",
      task_id: "task-α-🚁",
      runtime_id: "runtime-\ud800",
      observation_time: "2026-09-06T12:00:00Z",
      body: { output: Array.from({ length: 100 }, (_, index) => index % 2) }
    });
    const frames = fragmentPayload(payload, identity, 233, "message-v2");
    expect(frames).toHaveLength(1);
    const frame = frames[0];
    if (frame === undefined) throw new Error("Missing method frame");
    expect(frame[0]).toBe(0xa7);
    const decoded = decodeFrame(frame);
    expect(decoded).toMatchObject(identity);
    expect(decoded.receipt).toEqual(identity.receipt);
    expect(Buffer.from(decoded.payload)).toEqual(Buffer.from(payload));
  });
});

function compressForMode(mode: number, payload: Uint8Array): Uint8Array {
  const algorithm = Math.floor(mode / 3);
  if (algorithm === 0) return deflateRawSync(payload, { dictionary, level: 9 });
  if (algorithm === 1) {
    return brotliCompressSync(payload, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: 4,
        [constants.BROTLI_PARAM_LGWIN]: 18,
        [constants.BROTLI_PARAM_SIZE_HINT]: payload.byteLength
      }
    });
  }
  if (algorithm === 2) {
    return zstdCompressSync(payload, {
      dictionary,
      params: {
        [constants.ZSTD_c_compressionLevel]: 9,
        [constants.ZSTD_c_windowLog]: 20
      }
    });
  }
  throw new TypeError(`Unknown compression algorithm for mode ${mode}`);
}
