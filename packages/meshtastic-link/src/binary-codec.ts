import { createHash } from "node:crypto";
import { decodeJSON, encodeCanonicalJSON } from "./canonical-json.js";
import { FRAME_BINARY_KEYS, FRAME_BINARY_STRINGS } from "./generated/radio-contract.generated.js";

const MAX_BINARY_DEPTH = 64;
const MAX_BINARY_NODES = 65_536;
const MAX_BINARY_BYTES = 128 * 1024;
const TAG_NULL = 0;
const TAG_FALSE = 1;
const TAG_TRUE = 2;
const TAG_NUMBER = 3;
const TAG_STRING = 4;
const TAG_ARRAY = 5;
const TAG_OBJECT = 6;
/** SHA-256 of JSON.stringify([FRAME_BINARY_KEYS, FRAME_BINARY_STRINGS]); order is wire-significant. */
export const BINARY_V1_VOCABULARY_SHA256 = "45b9871d47b18b9ad88998c35e18ec0dbf32f9bd5bda483e52c6d54ed0fff1d7";
let binaryVocabularyVerified = false;
const binaryKeyIndexes = new Map(FRAME_BINARY_KEYS.map((key, index) => [key, index]));
const binaryStringIndexes = new Map(FRAME_BINARY_STRINGS.map((value, index) => [value, index]));

export function encodeBinaryPayload(payload: Uint8Array): Uint8Array | undefined {
  assertBinaryVocabulary();
  let value: unknown;
  try {
    value = decodeJSON(payload);
    const canonical = encodeCanonicalJSON(value);
    if (!Buffer.from(canonical).equals(Buffer.from(payload))) return undefined;
  } catch {
    return undefined;
  }
  const output: number[] = [];
  try {
    writeValue(output, value, 0, { count: 0 });
  } catch {
    return undefined;
  }
  return Uint8Array.from(output);
}

export function decodeBinaryPayload(raw: Uint8Array, start: number): Uint8Array {
  assertBinaryVocabulary();
  const state = { offset: start, count: 0 };
  const value = readValue(raw, state, 0);
  if (state.offset !== raw.byteLength) throw new TypeError("Invalid binary-v1 payload boundary");
  const payload = encodeCanonicalJSON(value);
  if (payload.byteLength > MAX_BINARY_BYTES) throw new RangeError("Binary payload exceeds 128 KiB");
  return payload;
}

export function encodeBinaryUtf8(value: string): Uint8Array {
  const output: number[] = [];
  for (let index = 0; index < value.length; index++) {
    const first = value.charCodeAt(index);
    const second = value.charCodeAt(index + 1);
    const codePoint =
      first >= 0xd800 && first <= 0xdbff && second >= 0xdc00 && second <= 0xdfff
        ? (index++, 0x10000 + ((first - 0xd800) << 10) + second - 0xdc00)
        : first;
    if (codePoint <= 0x7f) {
      output.push(codePoint);
    } else if (codePoint <= 0x7ff) {
      output.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint <= 0xffff) {
      output.push(0xe0 | (codePoint >> 12), 0x80 | ((codePoint >> 6) & 0x3f), 0x80 | (codePoint & 0x3f));
    } else {
      output.push(
        0xf0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f)
      );
    }
  }
  return Uint8Array.from(output);
}

export function decodeBinaryUtf8(bytes: Uint8Array): string {
  const output: string[] = [];
  for (let index = 0; index < bytes.length; ) {
    const first = bytes[index++];
    if (first === undefined) throw new TypeError("Invalid binary-v1 UTF-8 string");
    if (first <= 0x7f) {
      output.push(String.fromCharCode(first));
      continue;
    }
    if (first >= 0xc2 && first <= 0xdf) {
      const second = continuation(bytes, index++);
      output.push(String.fromCharCode(((first & 0x1f) << 6) | second));
      continue;
    }
    if (first >= 0xe0 && first <= 0xef) {
      const second = bytes[index++];
      if (second === undefined || (second & 0xc0) !== 0x80 || (first === 0xe0 && second < 0xa0))
        throw new TypeError("Invalid binary-v1 UTF-8 string");
      const third = continuation(bytes, index++);
      const codePoint = ((first & 0x0f) << 12) | ((second & 0x3f) << 6) | third;
      output.push(String.fromCharCode(codePoint));
      continue;
    }
    if (first >= 0xf0 && first <= 0xf4) {
      const second = bytes[index++];
      if (
        second === undefined ||
        (second & 0xc0) !== 0x80 ||
        (first === 0xf0 && second < 0x90) ||
        (first === 0xf4 && second > 0x8f)
      )
        throw new TypeError("Invalid binary-v1 UTF-8 string");
      const third = continuation(bytes, index++);
      const fourth = continuation(bytes, index++);
      const codePoint = ((first & 0x07) << 18) | ((second & 0x3f) << 12) | ((third & 0x3f) << 6) | fourth;
      output.push(String.fromCodePoint(codePoint));
      continue;
    }
    throw new TypeError("Invalid binary-v1 UTF-8 string");
  }
  return output.join("");
}

function writeValue(output: number[], value: unknown, depth: number, state: { count: number }): void {
  if (depth > MAX_BINARY_DEPTH || ++state.count > MAX_BINARY_NODES) throw new RangeError("Binary payload is too deep");
  if (value === null) {
    output.push(TAG_NULL);
  } else if (value === false) {
    output.push(TAG_FALSE);
  } else if (value === true) {
    output.push(TAG_TRUE);
  } else if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Binary payload number is not finite");
    output.push(TAG_NUMBER);
    const bytes = Buffer.allocUnsafe(8);
    bytes.writeDoubleLE(value, 0);
    for (const byte of bytes) output.push(byte);
  } else if (typeof value === "string") {
    output.push(TAG_STRING);
    writeString(output, value, binaryStringIndexes);
  } else if (Array.isArray(value)) {
    output.push(TAG_ARRAY);
    writeVarint(output, value.length);
    for (const child of value) writeValue(output, child, depth + 1, state);
  } else if (isPlainObject(value)) {
    output.push(TAG_OBJECT);
    const keys = Object.keys(value).sort();
    writeVarint(output, keys.length);
    for (const key of keys) {
      writeString(output, key, binaryKeyIndexes);
      writeValue(output, value[key], depth + 1, state);
    }
  } else {
    throw new TypeError("Binary payload contains a non-JSON value");
  }
}

function writeString(output: number[], value: string, indexes: Map<string, number>): void {
  const index = indexes.get(value);
  if (index !== undefined) {
    writeVarint(output, index + 1);
    return;
  }
  const bytes = encodeBinaryUtf8(value);
  if (bytes.byteLength > MAX_BINARY_BYTES) throw new RangeError("Binary payload string is too large");
  writeVarint(output, 0);
  writeVarint(output, bytes.byteLength);
  for (const byte of bytes) output.push(byte);
}

function readValue(raw: Uint8Array, state: { offset: number; count: number }, depth: number): unknown {
  if (depth > MAX_BINARY_DEPTH || ++state.count > MAX_BINARY_NODES) throw new RangeError("Binary payload is too deep");
  const tag = readVarint(raw, state);
  if (tag === TAG_NULL) return null;
  if (tag === TAG_FALSE) return false;
  if (tag === TAG_TRUE) return true;
  if (tag === TAG_NUMBER) {
    if (state.offset + 8 > raw.byteLength) throw new TypeError("Truncated binary-v1 number");
    const value = Buffer.from(raw.subarray(state.offset, state.offset + 8)).readDoubleLE(0);
    state.offset += 8;
    if (!Number.isFinite(value)) throw new TypeError("Binary payload number is not finite");
    return value;
  }
  if (tag === TAG_STRING) return readString(raw, state, FRAME_BINARY_STRINGS);
  if (tag === TAG_ARRAY) {
    const count = readCount(raw, state);
    const value: unknown[] = [];
    for (let index = 0; index < count; index++) value.push(readValue(raw, state, depth + 1));
    return value;
  }
  if (tag === TAG_OBJECT) {
    const count = readCount(raw, state);
    const value: Record<string, unknown> = Object.create(null);
    for (let index = 0; index < count; index++) {
      const key = readString(raw, state, FRAME_BINARY_KEYS);
      if (Object.hasOwn(value, key)) throw new TypeError("Duplicate binary-v1 object key");
      value[key] = readValue(raw, state, depth + 1);
    }
    return value;
  }
  throw new TypeError("Unknown binary-v1 value tag");
}

function readString(raw: Uint8Array, state: { offset: number; count: number }, dictionary: readonly string[]): string {
  const token = readVarint(raw, state);
  if (token > 0) {
    const value = dictionary[token - 1];
    if (value === undefined) throw new TypeError("Unknown binary-v1 dictionary string");
    return value;
  }
  const length = readVarint(raw, state);
  if (length > MAX_BINARY_BYTES || state.offset + length > raw.byteLength)
    throw new TypeError("Truncated binary-v1 string");
  const value = decodeBinaryUtf8(raw.subarray(state.offset, state.offset + length));
  state.offset += length;
  return value;
}

function readCount(raw: Uint8Array, state: { offset: number; count: number }): number {
  const count = readVarint(raw, state);
  if (count > MAX_BINARY_NODES) throw new RangeError("Binary payload has too many values");
  return count;
}

function readVarint(raw: Uint8Array, state: { offset: number }): number {
  let value = 0;
  let multiplier = 1;
  for (let index = 0; index < 8; index++) {
    const byte = raw[state.offset++];
    if (byte === undefined) throw new TypeError("Truncated binary-v1 integer");
    value += (byte & 127) * multiplier;
    if (!Number.isSafeInteger(value)) throw new TypeError("Invalid binary-v1 integer");
    if (byte < 128) return value;
    multiplier *= 128;
  }
  throw new TypeError("Invalid binary-v1 integer");
}

function writeVarint(output: number[], value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("Invalid binary-v1 integer");
  do {
    const byte = value % 128;
    value = Math.floor(value / 128);
    output.push(byte | (value > 0 ? 128 : 0));
  } while (value > 0);
}

function continuation(bytes: Uint8Array, index: number): number {
  const byte = bytes[index];
  if (byte === undefined || (byte & 0xc0) !== 0x80) throw new TypeError("Invalid binary-v1 UTF-8 string");
  return byte & 0x3f;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertBinaryVocabulary(): void {
  if (binaryVocabularyVerified) return;
  const actual = createHash("sha256")
    .update(JSON.stringify([FRAME_BINARY_KEYS, FRAME_BINARY_STRINGS]))
    .digest("hex");
  if (actual !== BINARY_V1_VOCABULARY_SHA256) {
    throw new Error(
      `binary-v1 vocabulary changed (expected ${BINARY_V1_VOCABULARY_SHA256}, got ${actual}); assign a new wire version`
    );
  }
  binaryVocabularyVerified = true;
}
