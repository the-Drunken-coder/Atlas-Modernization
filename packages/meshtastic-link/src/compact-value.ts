import { createHash } from "node:crypto";
import { BINARY_V1_VOCABULARY_SHA256, decodeBinaryUtf8, encodeBinaryUtf8 } from "./binary-codec.js";
import { decodeJSON, encodeCanonicalJSON } from "./canonical-json.js";
import { FRAME_BINARY_KEYS, FRAME_BINARY_STRINGS } from "./generated/radio-contract.generated.js";

const COMPACT_VALUE_VERSION = 1;
const MAX_CANONICAL_BYTES = 128 * 1024;
const MAX_COMPACT_BYTES = MAX_CANONICAL_BYTES * 4;
const MAX_DEPTH = 64;
const MAX_NODES = 65_536;
const MAX_STRING_BYTES = MAX_CANONICAL_BYTES;
const MAX_TABLE_ENTRIES = 32;

const TAG_NULL = 0;
const TAG_FALSE = 1;
const TAG_TRUE = 2;
const TAG_INTEGER_POSITIVE = 3;
const TAG_INTEGER_NEGATIVE = 4;
const TAG_FLOAT32 = 5;
const TAG_FLOAT64 = 6;
const TAG_STRING = 7;
const TAG_ARRAY = 8;
const TAG_OBJECT = 9;

/**
 * Compact value v1 body. The frame codec owns the outer marker.
 *
 *   01 | value
 *   value: one tag, followed by tag-specific data
 *   integer: signed tag plus unsigned-magnitude base-128 integer
 *   float32/float64: little-endian IEEE-754 bytes
 *   string: context-specific varint text token (0 literal, dictionary index + 1,
 *           table reference after the dictionary range, or a UUID token)
 *   array/object: bounded count followed by child values; object keys are text tokens
 *
 * Text references use one per-message table shared by keys and values. New text is
 * inserted in encounter order up to 32 entries. The pinned binary-v1 vocabularies
 * and WTF-8 implementation are reused without changing binary-v1's wire format.
 */

const binaryKeyIndexes = new Map<string, number>(FRAME_BINARY_KEYS.map((key, index) => [key, index]));
const binaryStringIndexes = new Map<string, number>(FRAME_BINARY_STRINGS.map((value, index) => [value, index]));
let vocabularyVerified = false;

export function encodeCompactValue(payload: Uint8Array): Uint8Array | undefined {
  assertVocabulary();
  if (payload.byteLength > MAX_CANONICAL_BYTES) return undefined;

  let value: unknown;
  try {
    value = decodeJSON(payload);
    const canonical = encodeCanonicalJSON(value);
    if (!bytesEqual(canonical, payload)) return undefined;
  } catch {
    return undefined;
  }

  const writer = new Writer();
  try {
    writer.byte(COMPACT_VALUE_VERSION);
    writeValue(writer, value, 0, { count: 0 }, new TextTable());
    return writer.finish();
  } catch {
    return undefined;
  }
}

export function decodeCompactValue(payload: Uint8Array): Uint8Array {
  assertVocabulary();
  if (payload.byteLength > MAX_COMPACT_BYTES) throw new RangeError("Compact value exceeds input bound");

  const reader = new Reader(payload);
  const version = reader.byte();
  if (version !== COMPACT_VALUE_VERSION) throw new TypeError("Unknown compact value version");
  const value = readValue(reader, 0, { count: 0 }, new TextTable(), new CanonicalBudget());
  if (!reader.done()) throw new TypeError("Trailing compact value bytes");

  const canonical = encodeCanonicalJSON(value);
  if (canonical.byteLength > MAX_CANONICAL_BYTES) throw new RangeError("Compact value exceeds 128 KiB");
  return canonical;
}

function writeValue(writer: Writer, value: unknown, depth: number, state: NodeState, table: TextTable): void {
  visit(state, depth);
  if (value === null) {
    writer.byte(TAG_NULL);
    return;
  }
  if (value === false) {
    writer.byte(TAG_FALSE);
    return;
  }
  if (value === true) {
    writer.byte(TAG_TRUE);
    return;
  }
  if (typeof value === "number") {
    writeNumber(writer, value);
    return;
  }
  if (typeof value === "string") {
    writer.byte(TAG_STRING);
    writeText(writer, value, false, table);
    return;
  }
  if (Array.isArray(value)) {
    writer.byte(TAG_ARRAY);
    writer.varint(value.length);
    for (const child of value) writeValue(writer, child, depth + 1, state, table);
    return;
  }
  if (isPlainObject(value)) {
    writer.byte(TAG_OBJECT);
    const keys = Object.keys(value).sort();
    writer.varint(keys.length);
    for (const key of keys) {
      writeText(writer, key, true, table);
      writeValue(writer, value[key], depth + 1, state, table);
    }
    return;
  }
  throw new TypeError("Compact value contains a non-JSON value");
}

function writeNumber(writer: Writer, value: number): void {
  if (!Number.isFinite(value)) throw new TypeError("Compact value number is not finite");
  if (Number.isSafeInteger(value)) {
    if (value < 0) {
      writer.byte(TAG_INTEGER_NEGATIVE);
      writer.varint(-value);
    } else {
      writer.byte(TAG_INTEGER_POSITIVE);
      writer.varint(value);
    }
    return;
  }

  if (Math.fround(value) === value) {
    writer.byte(TAG_FLOAT32);
    writer.float32(value);
    return;
  }
  writer.byte(TAG_FLOAT64);
  writer.float64(value);
}

function writeText(writer: Writer, value: string, key: boolean, table: TextTable): void {
  const reference = table.index(value);
  if (reference !== undefined) {
    const dictionaryLength = key ? FRAME_BINARY_KEYS.length : FRAME_BINARY_STRINGS.length;
    writer.varint(dictionaryLength + 1 + reference);
    return;
  }

  const dictionary = (key ? binaryKeyIndexes : binaryStringIndexes).get(value);
  if (dictionary !== undefined) {
    writer.varint(dictionary + 1);
    table.add(value);
    return;
  }

  const uuid = packUUID(value);
  if (uuid !== undefined) {
    writer.varint(uuidToken(key));
    writer.bytes(uuid);
    table.add(value);
    return;
  }

  const encoded = encodeBinaryUtf8(value);
  if (encoded.byteLength > MAX_STRING_BYTES) throw new RangeError("Compact value string is too large");
  writer.varint(0);
  writer.varint(encoded.byteLength);
  writer.bytes(encoded);
  table.add(value);
}

function readValue(
  reader: Reader,
  depth: number,
  state: NodeState,
  table: TextTable,
  budget: CanonicalBudget
): unknown {
  visit(state, depth);
  const tag = reader.byte();
  if (tag === TAG_NULL) {
    budget.bytes(4);
    return null;
  }
  if (tag === TAG_FALSE) {
    budget.bytes(5);
    return false;
  }
  if (tag === TAG_TRUE) {
    budget.bytes(4);
    return true;
  }
  if (tag === TAG_INTEGER_POSITIVE) {
    const value = reader.varint(Number.MAX_SAFE_INTEGER);
    budget.number(value);
    return value;
  }
  if (tag === TAG_INTEGER_NEGATIVE) {
    const magnitude = reader.varint(Number.MAX_SAFE_INTEGER);
    if (magnitude === 0) throw new TypeError("Negative compact integer has zero magnitude");
    const value = -magnitude;
    budget.number(value);
    return value;
  }
  if (tag === TAG_FLOAT32 || tag === TAG_FLOAT64) {
    const value = tag === TAG_FLOAT32 ? reader.float32() : reader.float64();
    budget.number(value);
    return value;
  }
  if (tag === TAG_STRING) {
    const value = readText(reader, false, table);
    budget.string(value);
    return value;
  }
  if (tag === TAG_ARRAY) {
    budget.bytes(1);
    const count = reader.varint(MAX_NODES);
    const value: unknown[] = [];
    for (let index = 0; index < count; index++) {
      if (index > 0) budget.bytes(1);
      value.push(readValue(reader, depth + 1, state, table, budget));
    }
    budget.bytes(1);
    return value;
  }
  if (tag === TAG_OBJECT) {
    budget.bytes(1);
    const count = reader.varint(MAX_NODES);
    const value: Record<string, unknown> = Object.create(null);
    for (let index = 0; index < count; index++) {
      if (index > 0) budget.bytes(1);
      const key = readText(reader, true, table);
      budget.string(key);
      budget.bytes(1);
      if (Object.hasOwn(value, key)) throw new TypeError("Duplicate compact object key");
      value[key] = readValue(reader, depth + 1, state, table, budget);
    }
    budget.bytes(1);
    return value;
  }
  throw new TypeError("Unknown compact value tag");
}

function readText(reader: Reader, key: boolean, table: TextTable): string {
  const token = reader.varint(uuidToken(key));
  if (token === 0) {
    const length = reader.varint(MAX_STRING_BYTES);
    const value = decodeBinaryUtf8(reader.bytes(length));
    table.add(value);
    return value;
  }

  const vocabulary = key ? FRAME_BINARY_KEYS : FRAME_BINARY_STRINGS;
  if (token <= vocabulary.length) {
    const value = vocabulary[token - 1];
    if (value === undefined) throw new TypeError("Unknown compact dictionary string");
    table.add(value);
    return value;
  }

  const referenceStart = vocabulary.length + 1;
  const uuid = uuidToken(key);
  if (token < uuid) {
    return table.value(token - referenceStart);
  }

  if (token === uuid) {
    const value = uuidString(reader.bytes(16));
    table.add(value);
    return value;
  }
  throw new TypeError("Unknown compact text token");
}

function packUUID(value: string): Uint8Array | undefined {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) return undefined;
  const hex = value.replaceAll("-", "");
  const bytes = new Uint8Array(16);
  for (let index = 0; index < bytes.length; index++)
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

function uuidToken(key: boolean): number {
  const dictionaryLength = key ? FRAME_BINARY_KEYS.length : FRAME_BINARY_STRINGS.length;
  return dictionaryLength + MAX_TABLE_ENTRIES + 1;
}

function uuidString(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function visit(state: NodeState, depth: number): void {
  if (depth > MAX_DEPTH) throw new RangeError("Compact value is too deep");
  if (++state.count > MAX_NODES) throw new RangeError("Compact value has too many values");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index++) if (left[index] !== right[index]) return false;
  return true;
}

function assertVocabulary(): void {
  if (vocabularyVerified) return;
  const actual = createHash("sha256")
    .update(JSON.stringify([FRAME_BINARY_KEYS, FRAME_BINARY_STRINGS]))
    .digest("hex");
  if (actual !== BINARY_V1_VOCABULARY_SHA256) {
    throw new Error(
      `compact value vocabulary changed (expected ${BINARY_V1_VOCABULARY_SHA256}, got ${actual}); assign a new wire version`
    );
  }
  vocabularyVerified = true;
}

type NodeState = { count: number };

class CanonicalBudget {
  private total = 0;

  bytes(value: number): void {
    this.total += value;
    this.assertWithinBound();
  }

  number(value: number): void {
    this.bytes(JSON.stringify(value).length);
  }

  string(value: string): void {
    this.bytes(canonicalJSONStringBytes(value));
  }

  private assertWithinBound(): void {
    if (this.total > MAX_CANONICAL_BYTES) throw new RangeError("Compact value exceeds 128 KiB");
  }
}

class TextTable {
  private readonly values: string[] = [];
  private readonly indexes = new Map<string, number>();

  index(value: string): number | undefined {
    return this.indexes.get(value);
  }

  add(value: string): void {
    if (this.indexes.has(value) || this.values.length >= MAX_TABLE_ENTRIES) return;
    this.indexes.set(value, this.values.length);
    this.values.push(value);
  }

  value(index: number): string {
    const value = this.values[index];
    if (value === undefined) throw new TypeError("Unknown compact text reference");
    return value;
  }
}

class Writer {
  private readonly output: number[] = [];

  byte(value: number): void {
    this.ensure(1);
    this.output.push(value);
  }

  bytes(values: Uint8Array): void {
    this.ensure(values.byteLength);
    for (const value of values) this.output.push(value);
  }

  varint(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("Invalid compact integer");
    do {
      const remainder = value % 128;
      value = Math.floor(value / 128);
      this.byte(remainder | (value > 0 ? 128 : 0));
    } while (value > 0);
  }

  float32(value: number): void {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setFloat32(0, value, true);
    this.bytes(bytes);
  }

  float64(value: number): void {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setFloat64(0, value, true);
    this.bytes(bytes);
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.output);
  }

  private ensure(length: number): void {
    if (this.output.length + length > MAX_COMPACT_BYTES) throw new RangeError("Compact value exceeds input bound");
  }
}

class Reader {
  private position = 0;

  constructor(private readonly input: Uint8Array) {}

  byte(): number {
    const value = this.input[this.position++];
    if (value === undefined) throw new TypeError("Truncated compact value");
    return value;
  }

  bytes(length: number): Uint8Array {
    if (!Number.isSafeInteger(length) || length < 0 || this.position + length > this.input.byteLength) {
      throw new TypeError("Truncated compact value bytes");
    }
    const value = this.input.subarray(this.position, this.position + length);
    this.position += length;
    return value;
  }

  varint(maximum: number): number {
    let value = 0;
    for (let index = 0; index < 8; index++) {
      const byte = this.byte();
      const chunk = byte & 0x7f;
      if (chunk > Math.floor((Number.MAX_SAFE_INTEGER - value) / 128 ** index)) {
        throw new TypeError("Invalid compact integer");
      }
      value += chunk * 128 ** index;
      if ((byte & 0x80) === 0) {
        if (index > 0 && chunk === 0) throw new TypeError("Non-canonical compact integer");
        if (value > maximum) throw new RangeError("Compact integer exceeds bound");
        return value;
      }
    }
    throw new TypeError("Invalid compact integer");
  }

  float32(): number {
    const bytes = this.bytes(4);
    const value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat32(0, true);
    if (!Number.isFinite(value)) throw new TypeError("Compact value number is not finite");
    return value;
  }

  float64(): number {
    const bytes = this.bytes(8);
    const value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat64(0, true);
    if (!Number.isFinite(value)) throw new TypeError("Compact value number is not finite");
    return value;
  }

  done(): boolean {
    return this.position === this.input.byteLength;
  }
}

function canonicalJSONStringBytes(value: string): number {
  let bytes = 2;
  for (let index = 0; index < value.length; index++) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit === 0x22 || codeUnit === 0x5c) {
      bytes += 2;
    } else if (codeUnit === 0x08 || codeUnit === 0x09 || codeUnit === 0x0a || codeUnit === 0x0c || codeUnit === 0x0d) {
      bytes += 2;
    } else if (codeUnit <= 0x1f) {
      bytes += 6;
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += utf8Bytes(0x10000 + ((codeUnit - 0xd800) << 10) + next - 0xdc00);
        index++;
      } else {
        bytes += 6;
      }
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      bytes += 6;
    } else {
      bytes += utf8Bytes(codeUnit);
    }
  }
  return bytes;
}

function utf8Bytes(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}
