import { createHash } from "node:crypto";
import {
  brotliCompressSync,
  brotliDecompressSync,
  constants,
  deflateRawSync,
  inflateRawSync,
  zstdCompressSync,
  zstdDecompressSync
} from "node:zlib";
import { decodeBinaryPayload, encodeBinaryPayload } from "./binary-codec.js";
import { decodeCompactValue, encodeCompactValue } from "./compact-value.js";
import { FRAME_DICTIONARY } from "./generated/radio-contract.generated.js";

// Modes 0/1/2 use dictionary DEFLATE; 3/4/5 use Brotli; 6/7/8 use Zstandard. Within each group,
// the payload representation is original bytes / binary-v1 / compact-value-v1.
// Compression levels are encoder policy; the mode fixes the decoder and vocabulary.
const MAX_MESSAGE_BYTES = 128 * 1024;
const dictionary = Buffer.from(FRAME_DICTIONARY);
const DICTIONARY_SHA256 = "fde4dbf9d274d7e52e4231bd7950a6e1d28752d6bd67d89be418622a72744f3d";
let dictionaryVerified = false;

export type CompressedValue = { mode: number; bytes: Uint8Array };

/** Compare complete encoded bodies, optionally sharing compression with a frame header. */
export function compressValue(payload: Uint8Array, header: Uint8Array = new Uint8Array()): CompressedValue {
  if (payload.byteLength > MAX_MESSAGE_BYTES) throw new RangeError("Message payload exceeds 128 KiB");
  assertDictionary();
  const representations = [payload, encodeBinaryPayload(payload), encodeCompactValue(payload)];
  let best: CompressedValue | undefined;
  for (const [representation, value] of representations.entries()) {
    if (value === undefined) continue;
    const body = header.byteLength === 0 ? value : Buffer.concat([header, value]);
    const candidates = [
      deflateRawSync(body, { dictionary, level: 9 }),
      brotliCompressSync(body, {
        params: {
          [constants.BROTLI_PARAM_QUALITY]: 4,
          [constants.BROTLI_PARAM_LGWIN]: 18,
          [constants.BROTLI_PARAM_SIZE_HINT]: body.byteLength
        }
      }),
      zstdCompressSync(body, {
        dictionary,
        params: {
          [constants.ZSTD_c_compressionLevel]: 9,
          [constants.ZSTD_c_windowLog]: 20
        }
      })
    ];
    for (const [algorithm, bytes] of candidates.entries()) {
      if (best === undefined || bytes.byteLength < best.bytes.byteLength)
        best = { mode: algorithm * 3 + representation, bytes };
    }
  }
  if (best === undefined) throw new Error("Missing compression candidate");
  return best;
}

/** Decode a compressed body; callers parse any frame header before restoring its payload. */
export function decompressValue(mode: number, bytes: Uint8Array, maxOutputLength: number): Uint8Array {
  validateMode(mode);
  assertDictionary();
  if (mode >= 6) assertZstandardBoundary(bytes);
  const options = { maxOutputLength, info: true };
  const result: unknown =
    mode < 3
      ? inflateRawSync(bytes, { ...options, dictionary })
      : mode < 6
        ? brotliDecompressSync(bytes, options)
        : zstdDecompressSync(bytes, { ...options, dictionary, params: { [constants.ZSTD_d_windowLogMax]: 20 } });
  if (
    result === null ||
    typeof result !== "object" ||
    !("buffer" in result) ||
    !Buffer.isBuffer(result.buffer) ||
    !("engine" in result) ||
    result.engine === null ||
    typeof result.engine !== "object" ||
    !("bytesWritten" in result.engine) ||
    result.engine.bytesWritten !== bytes.byteLength
  )
    throw new TypeError("Invalid compressed value boundary");
  return result.buffer;
}

export function restoreValue(mode: number, payload: Uint8Array): Uint8Array {
  validateMode(mode);
  const representation = mode % 3;
  const restored =
    representation === 0
      ? payload
      : representation === 1
        ? decodeBinaryPayload(payload, 0)
        : decodeCompactValue(payload);
  if (restored.byteLength === 0 || restored.byteLength > MAX_MESSAGE_BYTES)
    throw new RangeError("Restored message must contain 1–131072 bytes");
  return restored;
}

// Node 24 can consume incomplete Zstandard input without reporting an error. Check one
// complete frame before invoking its decoder; bytesWritten alone cannot prove completion.
// Format: https://github.com/facebook/zstd/blob/dev/doc/zstd_compression_format.md
function assertZstandardBoundary(bytes: Uint8Array): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 6 || view.getUint32(0, true) !== 0xfd2fb528)
    throw new TypeError("Invalid Zstandard frame boundary");
  const descriptor = view.getUint8(4);
  if ((descriptor & 8) !== 0) throw new TypeError("Reserved Zstandard frame flag");
  const singleSegment = (descriptor & 32) !== 0;
  const sizeFlag = descriptor >> 6;
  const contentSizeBytes = sizeFlag === 0 ? (singleSegment ? 1 : 0) : 2 ** sizeFlag;
  const dictionaryFlag = descriptor & 3;
  const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
  let offset = 5 + (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
  let lastBlock = false;
  while (!lastBlock) {
    if (offset + 3 > bytes.byteLength) throw new TypeError("Truncated Zstandard block header");
    const header = view.getUint16(offset, true) | (view.getUint8(offset + 2) << 16);
    offset += 3;
    lastBlock = (header & 1) !== 0;
    const type = (header >> 1) & 3;
    if (type === 3) throw new TypeError("Reserved Zstandard block type");
    offset += type === 1 ? 1 : header >>> 3;
    if (offset > bytes.byteLength) throw new TypeError("Truncated Zstandard block");
  }
  if ((descriptor & 4) !== 0) offset += 4;
  if (offset !== bytes.byteLength) throw new TypeError("Invalid Zstandard frame boundary");
}

function validateMode(mode: number): void {
  if (!Number.isInteger(mode) || mode < 0 || mode > 8) throw new TypeError("Unknown message-v2 compression mode");
}

function assertDictionary(): void {
  if (dictionaryVerified) return;
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  if (major < 24 || (major === 24 && minor < 6))
    throw new Error("Message-v2 requires Node 24.6 or newer for Zstandard dictionaries");
  if (createHash("sha256").update(dictionary).digest("hex") !== DICTIONARY_SHA256)
    throw new Error("Message-v2 dictionary changed; assign a new wire version");
  dictionaryVerified = true;
}
