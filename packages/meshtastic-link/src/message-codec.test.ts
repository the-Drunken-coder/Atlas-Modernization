import { createHash, randomBytes } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { encodeBinaryPayload } from "./binary-codec.js";
import { encodeCanonicalJSON } from "./canonical-json.js";
import { FRAME_DICTIONARY } from "./generated/radio-contract.generated.js";
import { decodeMessagePayload, encodeCompressedMessage, MESSAGE_CODEC_DICTIONARY_SHA256 } from "./message-codec.js";

describe("whole-message codec", () => {
  it("pins the dictionary used by both modes", () => {
    expect(createHash("sha256").update(FRAME_DICTIONARY).digest("hex")).toBe(MESSAGE_CODEC_DICTIONARY_SHA256);
  });

  it("compresses and restores arbitrary bytes with canonical mode", () => {
    const payload = Buffer.from("opaque payload ".repeat(400));
    const encoded = encodeCompressedMessage(payload);
    if (!encoded) throw new Error("Expected repetitive payload to compress");
    expect(encoded.subarray(0, 3)).toEqual(Buffer.from([0xb2, 1, 0]));
    expect(Buffer.from(decodeMessagePayload(encoded))).toEqual(payload);
  });

  it("restores unknown fields, numbers, and surrogate strings through binary mode", () => {
    const payload = encodeCanonicalJSON({
      metadata: Array.from({ length: 200 }, (_, index) => ({
        count: index * 0.5,
        note: index % 2 === 0 ? "known-value" : "\ud800🚁\udfff",
        unknown_field: { enabled: index % 3 === 0, value: index + 0.25 }
      })),
      type: "plugin.invoke"
    });
    const encoded = encodeCompressedMessage(payload);
    if (!encoded) throw new Error("Expected canonical payload to compress");
    expect(encoded[0]).toBe(0xb2);
    expect(Buffer.from(decodeMessagePayload(encoded))).toEqual(Buffer.from(payload));

    const binaryPayload = encodeBinaryPayload(payload);
    if (!binaryPayload) throw new Error("Expected canonical payload to support binary mode");
    const manuallyMarkedBinary = Buffer.concat([
      Buffer.from([0xb2, 1, 1]),
      deflateRawSync(binaryPayload, { dictionary: Buffer.from(FRAME_DICTIONARY) })
    ]);
    expect(Buffer.from(decodeMessagePayload(manuallyMarkedBinary))).toEqual(Buffer.from(payload));
  });

  it("passes through unmarked payloads and rejects oversized inputs", () => {
    const payload = randomBytes(128);
    payload[0] = 0; // Keep this fixture outside the reserved envelope marker.
    expect(decodeMessagePayload(payload)).toBe(payload);
    expect(() => encodeCompressedMessage(new Uint8Array(128 * 1024 + 1))).toThrow("128 KiB");
    expect(() => decodeMessagePayload(new Uint8Array(128 * 1024 + 1))).toThrow("128 KiB");
  });

  it("rejects unknown versions, modes, truncation, trailing bytes, and decompression overflow", () => {
    const payload = Buffer.from("compressed ".repeat(300));
    const encoded = encodeCompressedMessage(payload);
    if (!encoded) throw new Error("Expected repetitive payload to compress");
    expect(() => decodeMessagePayload(Buffer.from([0xb2]))).toThrow("Truncated");
    expect(() => decodeMessagePayload(Buffer.from([0xb2, 2, 0]))).toThrow("version");
    expect(() => decodeMessagePayload(Buffer.from([0xb2, 1, 2]))).toThrow("mode");
    expect(() => decodeMessagePayload(encoded.subarray(0, -1))).toThrow();
    expect(() => decodeMessagePayload(Buffer.concat([encoded, Buffer.from([0])]))).toThrow("compressed");

    const oversized = Buffer.concat([
      Buffer.from([0xb2, 1, 0]),
      deflateRawSync(new Uint8Array(128 * 1024 + 1), { dictionary: Buffer.from(FRAME_DICTIONARY) })
    ]);
    expect(() => decodeMessagePayload(oversized)).toThrow();
  });
});
