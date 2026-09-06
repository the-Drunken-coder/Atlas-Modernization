import { createHash } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { decodeBinaryPayload, encodeBinaryPayload } from "./binary-codec.js";
import { decompressValue, restoreValue } from "./compression-methods.js";
import { FRAME_DICTIONARY } from "./generated/radio-contract.generated.js";

/**
 * Whole-message compression envelope:
 *   0xb2 | version 0x01 | mode 0x00/0x01 | dictionary-deflate bytes
 *
 * Mode 0 compresses the original bytes. Mode 1 compresses the lossless
 * binary-v1 JSON representation and reconstructs canonical JSON on decode.
 * The envelope is applied before Link frame fragmentation, so each fragment
 * carries only the existing frame metadata and a slice of these bytes.
 */
const MESSAGE_CODEC_MARKER = 0xb2;
const MESSAGE_CODEC_VERSION = 1;
const MODE_CANONICAL = 0;
const MODE_BINARY = 1;
const MAX_MESSAGE_BYTES = 128 * 1024;
const MAX_BINARY_DEFLATE_OUTPUT_BYTES = MAX_MESSAGE_BYTES * 8 + 64;
const DICTIONARY = Buffer.from(FRAME_DICTIONARY);
/** SHA-256 of the pinned FRAME_DICTIONARY used by this codec. */
export const MESSAGE_CODEC_DICTIONARY_SHA256 = "fde4dbf9d274d7e52e4231bd7950a6e1d28752d6bd67d89be418622a72744f3d";
let dictionaryVerified = false;

type InflateInfo = {
  buffer: Buffer;
  engine: { bytesWritten: number };
};

/** Return a marked whole-message encoding only when it beats the input size. */
export function encodeCompressedMessage(payload: Uint8Array): Uint8Array | undefined {
  assertDictionary();
  assertMessageSize(payload);

  const canonical = wrap(MODE_CANONICAL, deflateRawSync(payload, { dictionary: DICTIONARY }));
  const binaryPayload = encodeBinaryPayload(payload);
  const binary =
    binaryPayload === undefined
      ? undefined
      : wrap(MODE_BINARY, deflateRawSync(binaryPayload, { dictionary: DICTIONARY }));
  const candidate = binary === undefined || canonical.byteLength <= binary.byteLength ? canonical : binary;
  return candidate.byteLength < payload.byteLength ? candidate : undefined;
}

/** Decode a marked message, or pass through an unmarked message unchanged. */
export function decodeMessagePayload(payload: Uint8Array): Uint8Array {
  assertMessageSize(payload);
  if (payload[0] === 0xb3) {
    if (payload[1] !== 1) throw new TypeError("Unknown message-v2 envelope version");
    const mode = payload[2] ?? -1;
    return restoreValue(mode, decompressValue(mode, payload.subarray(3), MAX_BINARY_DEFLATE_OUTPUT_BYTES));
  }
  if (payload[0] !== MESSAGE_CODEC_MARKER) return payload;
  assertDictionary();
  if (payload.byteLength < 3) throw new TypeError("Truncated whole-message codec envelope");
  if (payload[1] !== MESSAGE_CODEC_VERSION) throw new TypeError("Unknown whole-message codec version");
  const mode = payload[2];
  if (mode !== MODE_CANONICAL && mode !== MODE_BINARY) throw new TypeError("Unknown whole-message codec mode");
  const output = inflateMessage(payload.subarray(3), mode === MODE_BINARY);
  if (output.byteLength === 0) throw new TypeError("Decoded whole-message payload must not be empty");
  if (mode === MODE_BINARY) return decodeBinaryPayload(output, 0);
  return output;
}

function wrap(mode: number, compressed: Uint8Array): Uint8Array {
  return Buffer.concat([Buffer.from([MESSAGE_CODEC_MARKER, MESSAGE_CODEC_VERSION, mode]), compressed]);
}

function inflateMessage(compressed: Uint8Array, binary: boolean): Buffer {
  if (compressed.byteLength === 0) throw new TypeError("Truncated whole-message codec payload");
  const result = inflateRawSync(compressed, {
    dictionary: DICTIONARY,
    info: true,
    maxOutputLength: binary ? MAX_BINARY_DEFLATE_OUTPUT_BYTES : MAX_MESSAGE_BYTES
  }) as unknown;
  if (!isInflateInfo(result) || result.engine.bytesWritten !== compressed.byteLength)
    throw new TypeError("Invalid whole-message compressed payload");
  if (result.buffer.byteLength > (binary ? MAX_BINARY_DEFLATE_OUTPUT_BYTES : MAX_MESSAGE_BYTES))
    throw new RangeError("Decoded whole-message payload exceeds bound");
  return result.buffer;
}

function assertMessageSize(payload: Uint8Array): void {
  if (payload.byteLength > MAX_MESSAGE_BYTES) throw new RangeError("Whole-message payload exceeds 128 KiB");
}

function assertDictionary(): void {
  if (dictionaryVerified) return;
  const actual = createHash("sha256").update(DICTIONARY).digest("hex");
  if (actual !== MESSAGE_CODEC_DICTIONARY_SHA256) {
    throw new Error(
      `whole-message codec dictionary changed (expected ${MESSAGE_CODEC_DICTIONARY_SHA256}, got ${actual}); assign a new wire version`
    );
  }
  dictionaryVerified = true;
}

function isInflateInfo(value: unknown): value is InflateInfo {
  if (value === null || typeof value !== "object") return false;
  const result = value as Record<string, unknown>;
  if (!Buffer.isBuffer(result.buffer) || result.engine === null || typeof result.engine !== "object") return false;
  return typeof (result.engine as Record<string, unknown>).bytesWritten === "number";
}
