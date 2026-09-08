import { createHash } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import {
  BINARY_V1_VOCABULARY_SHA256,
  decodeBinaryPayload,
  decodeBinaryUtf8,
  encodeBinaryPayload,
  encodeBinaryUtf8
} from "./binary-codec.js";
import { decodeJSON, encodeCanonicalJSON } from "./canonical-json.js";
import { compressValue, decompressValue, restoreValue } from "./compression-methods.js";
import { LINK_PROTOCOL_REVISION } from "./contract.js";
import { FRAME_DICTIONARY } from "./generated/radio-contract.generated.js";
import { encodeCompressedMessage } from "./message-codec.js";
import { type LinkMessageType, type LinkNode, MAX_LINK_FRAGMENTS, type MessagePriority } from "./types.js";

export const MESHTASTIC_APPLICATION_PAYLOAD_BYTES = 233;
export const MAX_LINK_MESSAGE_BYTES = 128 * 1024;
export type FrameEncoding =
  | "canonical-json"
  | "deflate-v1"
  | "deflate-v2"
  | "deflate-v3"
  | "binary-v1"
  | "message-v1"
  | "message-v2";
const DEFLATE_V1_MARKER = 0xa2;
const DEFLATE_V2_MARKER = 0xa3;
const DEFLATE_V3_MARKER = 0xa4;
const BINARY_V1_MARKER = 0xa5;
const MESSAGE_V1_MARKER = 0xa6;
const METHOD_FRAME_MARKER = 0xa7;
export const DEFLATE_V2_DICTIONARY_SHA256 = "fde4dbf9d274d7e52e4231bd7950a6e1d28752d6bd67d89be418622a72744f3d";
export const DEFLATE_V3_DICTIONARY_SHA256 = DEFLATE_V2_DICTIONARY_SHA256;
export { BINARY_V1_VOCABULARY_SHA256 };

const dictionary = Buffer.from(FRAME_DICTIONARY);
const compressedPrefix = Buffer.concat([
  Buffer.from([DEFLATE_V1_MARKER]),
  createHash("sha256").update(dictionary).digest().subarray(0, 8)
]);
const deflateV2Prefix = Buffer.from([DEFLATE_V2_MARKER]);
const deflateV3Prefix = Buffer.from([DEFLATE_V3_MARKER]);
let pinnedDictionaryVerified = false;

export type ReceiptIdentity = {
  operation_id: string;
  message_id: string;
};

export type LinkFrame = {
  revision: typeof LINK_PROTOCOL_REVISION;
  message_type: LinkMessageType;
  source: LinkNode;
  destination?: LinkNode;
  source_generation: number;
  service_session: string;
  source_sequence: number;
  operation_id: string;
  message_id: string;
  receipt?: ReceiptIdentity;
  priority: MessagePriority;
  chunk_index: number;
  chunk_count: number;
  payload: Uint8Array;
};

export type FrameIdentity = Omit<LinkFrame, "chunk_index" | "chunk_count" | "payload">;

type CompactFrame = {
  v: number;
  k: MessageTypeCode;
  s: string;
  d?: string;
  g: number;
  x: string;
  q: number;
  o: string;
  m: string;
  y: PriorityCode;
  i: number;
  n: number;
  p: string;
  receipt?: ReceiptIdentity;
};

type MessageTypeCode = "s" | "t" | "p" | "q" | "r" | "o" | "u" | "b" | "c";
type PriorityCode = "s" | "t" | "q" | "l" | "r" | "o";

const MESSAGE_TYPE_CODES: Record<LinkMessageType, MessageTypeCode> = {
  state: "s",
  task_delivery: "t",
  task_report: "p",
  data_request: "q",
  data_response: "r",
  resource_operation: "o",
  subscription: "u",
  object_content: "b",
  control: "c"
};

const PRIORITY_CODES: Record<MessagePriority, PriorityCode> = {
  safety: "s",
  task: "t",
  request: "q",
  live_state: "l",
  resource: "r",
  object_content: "o"
};

export function fragmentPayload(
  payload: Uint8Array,
  identity: FrameIdentity,
  maxFrameBytes = MESHTASTIC_APPLICATION_PAYLOAD_BYTES,
  encoding: FrameEncoding = "canonical-json"
): Uint8Array[] {
  if (payload.byteLength === 0) throw new TypeError("Link payload must not be empty");
  if (payload.byteLength > MAX_LINK_MESSAGE_BYTES) throw new RangeError("Link payload exceeds 128 KiB");
  if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 64) throw new RangeError("maxFrameBytes is too small");
  validateReceipt(identity, encoding, 0, 1);

  maxFrameBytes = Math.min(maxFrameBytes, MESHTASTIC_APPLICATION_PAYLOAD_BYTES);
  if (encoding === "message-v1") return fragmentCompressedMessage(payload, identity, maxFrameBytes);
  if (encoding === "message-v2") return fragmentMethodMessage(payload, identity, maxFrameBytes);

  if (encoding !== "canonical-json") {
    const whole = encodeCompactFrame(identity, 0, 1, payload, encoding);
    if (whole.byteLength <= maxFrameBytes) return [whole];
    if (identity.receipt !== undefined) throw new RangeError("Receipt metadata requires a single frame");
  }
  // Frame metadata changes at fragment-count digit boundaries, so encoded size is not monotone.
  for (
    let chunkSize = Math.min(payload.byteLength, maxFrameBytes * (encoding === "canonical-json" ? 1 : 4));
    chunkSize > 0;
    chunkSize--
  ) {
    const count = Math.ceil(payload.byteLength / chunkSize);
    if (count > MAX_LINK_FRAGMENTS || !framesFit(payload, identity, chunkSize, count, maxFrameBytes, encoding))
      continue;
    return framesForChunkSize(payload, identity, chunkSize, encoding);
  }
  throw new RangeError("Link envelope leaves no room for a payload chunk");
}

export function decodeFrame(bytes: Uint8Array): LinkFrame {
  if (bytes.byteLength > MESHTASTIC_APPLICATION_PAYLOAD_BYTES) {
    throw new RangeError("Meshtastic Link frame exceeds 233 bytes");
  }
  const value =
    bytes[0] === DEFLATE_V1_MARKER
      ? decodeCompressedFrame(bytes, "deflate-v1")
      : bytes[0] === DEFLATE_V2_MARKER
        ? decodeCompressedFrame(bytes, "deflate-v2")
        : bytes[0] === DEFLATE_V3_MARKER
          ? decodeCompressedFrame(bytes, "deflate-v3")
          : bytes[0] === BINARY_V1_MARKER
            ? decodeBinaryFrame(bytes)
            : bytes[0] === MESSAGE_V1_MARKER
              ? decodeMessageFrame(bytes)
              : bytes[0] === METHOD_FRAME_MARKER
                ? decodeMethodFrame(bytes)
                : bytes[0] !== undefined && bytes[0] >= 0xa0
                  ? (() => {
                      throw new TypeError("Unknown Link frame encoding marker");
                    })()
                  : decodeJSON(bytes);
  if (!isCompactFrame(value)) throw new TypeError("Invalid Meshtastic Link frame");
  if (
    value.receipt !== undefined &&
    bytes[0] !== DEFLATE_V3_MARKER &&
    bytes[0] !== BINARY_V1_MARKER &&
    bytes[0] !== MESSAGE_V1_MARKER &&
    bytes[0] !== METHOD_FRAME_MARKER
  )
    throw new TypeError("Receipt metadata requires deflate-v3, binary-v1, message-v1, or message-v2");
  const source = decodeNode(value.s);
  const destination = value.d === undefined ? undefined : decodeNode(value.d);
  const payload = Buffer.from(value.p, "base64url");
  if (payload.byteLength === 0) throw new TypeError("Link frame chunk must not be empty");
  return {
    revision: LINK_PROTOCOL_REVISION,
    message_type: decodeMessageType(value.k),
    source,
    ...(destination === undefined ? {} : { destination }),
    source_generation: value.g,
    service_session: value.x,
    source_sequence: value.q,
    operation_id: value.o,
    message_id: value.m,
    ...(value.receipt === undefined ? {} : { receipt: value.receipt }),
    priority: decodePriority(value.y),
    chunk_index: value.i,
    chunk_count: value.n,
    payload
  };
}

function framesForChunkSize(
  payload: Uint8Array,
  identity: FrameIdentity,
  chunkSize: number,
  encoding: FrameEncoding
): Uint8Array[] {
  const count = Math.ceil(payload.byteLength / chunkSize);
  const frames: Uint8Array[] = [];
  for (let index = 0; index < count; index++) {
    const chunk = payload.subarray(index * chunkSize, Math.min((index + 1) * chunkSize, payload.byteLength));
    frames.push(encodeCompactFrame(identity, index, count, chunk, encoding));
  }
  return frames;
}

function framesFit(
  payload: Uint8Array,
  identity: FrameIdentity,
  chunkSize: number,
  count: number,
  maxFrameBytes: number,
  encoding: FrameEncoding
): boolean {
  for (let index = 0; index < count; index++) {
    const chunk = payload.subarray(index * chunkSize, Math.min((index + 1) * chunkSize, payload.byteLength));
    if (encodeCompactFrame(identity, index, count, chunk, encoding).byteLength > maxFrameBytes) return false;
  }
  return true;
}

function encodeCompactFrame(
  identity: FrameIdentity,
  index: number,
  count: number,
  payload: Uint8Array,
  encoding: FrameEncoding
): Uint8Array {
  validateReceipt(identity, encoding, index, count);
  const compact: CompactFrame = {
    v: identity.revision,
    k: MESSAGE_TYPE_CODES[identity.message_type],
    s: encodeNode(identity.source),
    ...(identity.destination === undefined ? {} : { d: encodeNode(identity.destination) }),
    g: identity.source_generation,
    x: identity.service_session,
    q: identity.source_sequence,
    o: identity.operation_id,
    m: identity.message_id,
    y: PRIORITY_CODES[identity.priority],
    i: index,
    n: count,
    p: Buffer.from(payload).toString("base64url")
  };
  if (identity.receipt !== undefined) compact.receipt = identity.receipt;
  if (encoding === "canonical-json") return encodeCanonicalJSON(compact);
  if (encoding === "binary-v1") return encodeAdaptiveBinaryFrame(identity, index, count, payload);
  if (encoding === "message-v1" || encoding === "message-v2")
    return encodeMessageFrame(identity, index, count, payload);
  const fields: number[] = [];
  for (const value of [
    compact.v,
    compact.k.charCodeAt(0),
    compact.y.charCodeAt(0),
    compact.g,
    compact.q,
    compact.i,
    compact.n
  ])
    writeVarint(fields, value);
  for (const value of [compact.s, compact.d ?? "", compact.x, compact.o, compact.m]) {
    const bytes = Buffer.from(value);
    if (bytes.toString("utf8") !== value) throw new TypeError("Link header text must be valid UTF-8");
    if (bytes.length > 65535) throw new RangeError("Link header field is too large");
    writeVarint(fields, bytes.length);
    fields.push(...bytes);
  }
  if (encoding === "deflate-v2") assertDeflateV2Dictionary();
  if (encoding === "deflate-v3") {
    assertDeflateV3Dictionary();
    writeVarint(fields, compact.receipt === undefined ? 0 : 1);
    if (compact.receipt !== undefined) {
      for (const value of [compact.receipt.operation_id, compact.receipt.message_id]) {
        const bytes = Buffer.from(value);
        if (bytes.toString("utf8") !== value) throw new TypeError("Link header text must be valid UTF-8");
        if (bytes.length > 65535) throw new RangeError("Link receipt field is too large");
        writeVarint(fields, bytes.length);
        fields.push(...bytes);
      }
    }
  }
  return Buffer.concat([
    encoding === "deflate-v2" ? deflateV2Prefix : encoding === "deflate-v3" ? deflateV3Prefix : compressedPrefix,
    deflateRawSync(Buffer.concat([Buffer.from(fields), payload]), { dictionary })
  ]);
}

function encodeAdaptiveBinaryFrame(
  identity: FrameIdentity,
  index: number,
  count: number,
  payload: Uint8Array
): Uint8Array {
  const binary = encodeBinaryFrame(identity, index, count, payload);
  if (!legacyHeaderRoundTrips(identity)) return binary;
  const fallback = encodeCompactFrame(
    identity,
    index,
    count,
    payload,
    identity.receipt === undefined ? "deflate-v2" : "deflate-v3"
  );
  return binary.byteLength >= fallback.byteLength ? fallback : binary;
}

function encodeBinaryFrame(identity: FrameIdentity, index: number, count: number, payload: Uint8Array): Uint8Array {
  const binaryPayload = encodeBinaryPayload(payload);
  const fields = encodeBinaryHeader(identity, index, count, binaryPayload === undefined);
  assertDeflateV2Dictionary();
  return Buffer.concat([
    Buffer.from([BINARY_V1_MARKER]),
    deflateRawSync(Buffer.concat([Buffer.from(fields), Buffer.from(binaryPayload ?? payload)]), { dictionary })
  ]);
}

/** Compress a complete message once; fragment its encoded bytes without recompressing the body. */
function fragmentCompressedMessage(payload: Uint8Array, identity: FrameIdentity, maxFrameBytes: number): Uint8Array[] {
  // Keep the common one-packet path fast: joint header/body compression already avoids fragmentation.
  const whole = encodeAdaptiveBinaryFrame(identity, 0, 1, payload);
  if (whole.byteLength <= maxFrameBytes) return [whole];
  const compressed = encodeCompressedMessage(payload);
  const candidate = fragmentEncodedMessage(compressed, identity, maxFrameBytes, "message-v1");
  let baseline: Uint8Array[];
  try {
    baseline = fragmentPayload(payload, identity, maxFrameBytes, "binary-v1");
  } catch (error) {
    if (candidate !== undefined && error instanceof RangeError) return candidate;
    throw error;
  }
  if (
    candidate !== undefined &&
    candidate.length <= baseline.length &&
    candidate.reduce((sum, frame) => sum + frame.byteLength, 0) <
      baseline.reduce((sum, frame) => sum + frame.byteLength, 0)
  )
    return candidate;
  return baseline;
}

/** Compare methods even for one-packet traffic; retain the smaller existing representation. */
function fragmentMethodMessage(payload: Uint8Array, identity: FrameIdentity, maxFrameBytes: number): Uint8Array[] {
  const previousWhole = encodeAdaptiveBinaryFrame(identity, 0, 1, payload);
  const method = compressValue(payload, Buffer.from(encodeBinaryHeader(identity, 0, 1, true)));
  const whole = Buffer.concat([Buffer.from([METHOD_FRAME_MARKER, method.mode]), method.bytes]);
  if (previousWhole.byteLength <= maxFrameBytes)
    return [whole.byteLength < previousWhole.byteLength ? whole : previousWhole];

  let candidate: Uint8Array[] | undefined;
  if (whole.byteLength <= maxFrameBytes) {
    candidate = [whole];
  } else {
    const compressed = compressValue(payload);
    const envelope = Buffer.concat([Buffer.from([0xb3, 1, compressed.mode]), compressed.bytes]);
    if (envelope.byteLength < payload.byteLength)
      candidate = fragmentEncodedMessage(envelope, identity, maxFrameBytes, "message-v2");
  }
  let previous: Uint8Array[];
  try {
    previous = fragmentPayload(payload, identity, maxFrameBytes, "message-v1");
  } catch (error) {
    if (candidate !== undefined && error instanceof RangeError) return candidate;
    throw error;
  }
  if (
    candidate !== undefined &&
    candidate.length <= previous.length &&
    candidate.reduce((sum, frame) => sum + frame.byteLength, 0) <
      previous.reduce((sum, frame) => sum + frame.byteLength, 0)
  )
    return candidate;
  return previous;
}

function fragmentEncodedMessage(
  compressed: Uint8Array | undefined,
  identity: FrameIdentity,
  maxFrameBytes: number,
  encoding: FrameEncoding
): Uint8Array[] | undefined {
  if (compressed !== undefined) {
    try {
      for (let chunkSize = Math.min(compressed.byteLength, maxFrameBytes); chunkSize > 0; chunkSize--) {
        const count = Math.ceil(compressed.byteLength / chunkSize);
        if (identity.receipt !== undefined && count !== 1) break;
        if (count > MAX_LINK_FRAGMENTS || !framesFit(compressed, identity, chunkSize, count, maxFrameBytes, encoding))
          continue;
        return framesForChunkSize(compressed, identity, chunkSize, encoding);
      }
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      // Oversized compact headers may still fit when compressed with the original payload.
    }
  }
  return undefined;
}

function encodeMessageFrame(identity: FrameIdentity, index: number, count: number, payload: Uint8Array): Uint8Array {
  assertDeflateV2Dictionary();
  const header = deflateRawSync(Buffer.from(encodeBinaryHeader(identity, index, count, true)), { dictionary });
  // The header length occupies one byte and the complete frame is at most 233 bytes.
  if (header.byteLength > 255) throw new RangeError("Message-v1 header exceeds its length field");
  return Buffer.concat([Buffer.from([MESSAGE_V1_MARKER, header.byteLength]), header, payload]);
}

function encodeBinaryHeader(identity: FrameIdentity, index: number, count: number, opaque: boolean): number[] {
  const fields: number[] = [];
  for (const value of [
    identity.revision,
    MESSAGE_TYPE_CODES[identity.message_type].charCodeAt(0),
    PRIORITY_CODES[identity.priority].charCodeAt(0),
    identity.source_generation,
    identity.source_sequence,
    index,
    count
  ])
    writeVarint(fields, value);
  for (const value of [
    encodeNode(identity.source),
    identity.destination === undefined ? "" : encodeNode(identity.destination),
    identity.service_session,
    identity.operation_id,
    identity.message_id
  ])
    writeBinaryHeaderString(fields, value);
  writeVarint(fields, (identity.receipt === undefined ? 0 : 1) | (opaque ? 2 : 0));
  if (identity.receipt !== undefined) {
    writeBinaryHeaderString(fields, identity.receipt.operation_id);
    writeBinaryHeaderString(fields, identity.receipt.message_id);
  }
  return fields;
}

function writeBinaryHeaderString(output: number[], value: string): void {
  const bytes = encodeBinaryUtf8(value);
  if (bytes.byteLength > 65535) throw new RangeError("Link binary header field is too large");
  writeVarint(output, bytes.byteLength);
  output.push(...bytes);
}

function encodeNode(node: LinkNode): string {
  if (!node.id.trim() || node.id.includes(":"))
    throw new TypeError("Link node IDs must be non-empty and cannot contain ':'");
  return `${node.role === "asset" ? "a" : "g"}:${node.id}`;
}

function decodeNode(value: string): LinkNode {
  const separator = value.indexOf(":");
  if (separator !== 1) throw new TypeError("Invalid Link node identity");
  const role = value.slice(0, separator);
  const id = value.slice(separator + 1);
  if ((role !== "a" && role !== "g") || !id.trim() || id.includes(":"))
    throw new TypeError("Invalid Link node identity");
  return { role: role === "a" ? "asset" : "gateway", id };
}

function isCompactFrame(value: unknown): value is CompactFrame {
  if (!isRecord(value)) return false;
  const receipt = value.receipt;
  return (
    value.v === LINK_PROTOCOL_REVISION &&
    isMessageType(value.k) &&
    typeof value.s === "string" &&
    (value.d === undefined || typeof value.d === "string") &&
    isNonNegativeInteger(value.g) &&
    isNonEmptyString(value.x) &&
    isNonNegativeInteger(value.q) &&
    isNonEmptyString(value.o) &&
    isNonEmptyString(value.m) &&
    isPriority(value.y) &&
    isNonNegativeInteger(value.i) &&
    Number.isSafeInteger(value.n) &&
    Number(value.n) > 0 &&
    Number(value.n) <= MAX_LINK_FRAGMENTS &&
    Number(value.i) < Number(value.n) &&
    isBase64URL(value.p) &&
    (receipt === undefined ||
      (isReceiptIdentity(receipt) &&
        value.k === MESSAGE_TYPE_CODES.task_report &&
        value.d !== undefined &&
        value.i === 0 &&
        value.n === 1))
  );
}

function isReceiptIdentity(value: unknown): value is ReceiptIdentity {
  return isRecord(value) && isNonEmptyString(value.operation_id) && isNonEmptyString(value.message_id);
}

function isMessageType(value: unknown): value is MessageTypeCode {
  return (
    typeof value === "string" &&
    (["s", "t", "p", "q", "r", "o", "u", "b", "c"] as const).includes(value as MessageTypeCode)
  );
}

function isPriority(value: unknown): value is PriorityCode {
  return typeof value === "string" && (["s", "t", "q", "l", "r", "o"] as const).includes(value as PriorityCode);
}

function decodeMessageType(code: MessageTypeCode): LinkMessageType {
  const entry = Object.entries(MESSAGE_TYPE_CODES).find(([, value]) => value === code);
  if (!entry) throw new TypeError("Invalid message type code");
  return entry[0] as LinkMessageType;
}

function decodePriority(code: PriorityCode): MessagePriority {
  const entry = Object.entries(PRIORITY_CODES).find(([, value]) => value === code);
  if (!entry) throw new TypeError("Invalid priority code");
  return entry[0] as MessagePriority;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isBase64URL(value: unknown): value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  return Buffer.from(value, "base64url").toString("base64url") === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function decodeCompressedFrame(bytes: Uint8Array, encoding: "deflate-v1" | "deflate-v2" | "deflate-v3"): unknown {
  if (encoding === "deflate-v2") assertDeflateV2Dictionary();
  if (encoding === "deflate-v3") assertDeflateV3Dictionary();
  const prefix =
    encoding === "deflate-v2" ? deflateV2Prefix : encoding === "deflate-v3" ? deflateV3Prefix : compressedPrefix;
  if (!Buffer.from(bytes.subarray(0, prefix.length)).equals(prefix))
    throw new TypeError(
      encoding === "deflate-v2"
        ? "Invalid deflate-v2 frame marker"
        : encoding === "deflate-v3"
          ? "Invalid deflate-v3 frame marker"
          : "Unknown compressed frame dictionary"
    );
  const raw = inflateRawSync(bytes.subarray(prefix.length), {
    dictionary,
    maxOutputLength: MAX_LINK_MESSAGE_BYTES + (encoding === "deflate-v3" ? 7 * 65538 + 64 : 5 * 65538 + 56)
  });
  let offset = 0;
  const integer = () => {
    let value = 0;
    let multiplier = 1;
    for (let i = 0; i < 8; i++) {
      const byte = raw[offset++];
      if (byte === undefined) throw new TypeError("Truncated compressed frame");
      value += (byte & 127) * multiplier;
      if (!Number.isSafeInteger(value)) throw new TypeError("Invalid compressed frame integer");
      if (byte < 128) return value;
      multiplier *= 128;
    }
    throw new TypeError("Invalid compressed frame integer");
  };
  const string = () => {
    const length = integer();
    if (length > 65535 || offset + length > raw.length) throw new TypeError("Truncated compressed frame header");
    const value = new TextDecoder("utf-8", { fatal: true }).decode(raw.subarray(offset, offset + length));
    offset += length;
    return value;
  };
  const [v, k, y, g, q, i, n] = Array.from({ length: 7 }, integer);
  const [s, d, x, o, m] = Array.from({ length: 5 }, string);
  const receiptFlag = encoding === "deflate-v3" ? integer() : 0;
  if (receiptFlag !== 0 && receiptFlag !== 1) throw new TypeError("Invalid deflate-v3 receipt flag");
  const receipt = receiptFlag === 1 ? { operation_id: string(), message_id: string() } : undefined;
  if (raw.length - offset > MAX_LINK_MESSAGE_BYTES) throw new RangeError("Link payload exceeds 128 KiB");
  return {
    v,
    k: String.fromCharCode(k ?? 0),
    y: String.fromCharCode(y ?? 0),
    s,
    ...(d === "" ? {} : { d }),
    g,
    x,
    q,
    o,
    m,
    i,
    n,
    ...(receipt === undefined ? {} : { receipt }),
    p: raw.subarray(offset).toString("base64url")
  };
}

function decodeBinaryFrame(bytes: Uint8Array): unknown {
  assertDeflateV2Dictionary();
  if (bytes[0] !== BINARY_V1_MARKER) throw new TypeError("Invalid binary-v1 frame marker");
  const raw = inflateRawSync(bytes.subarray(1), {
    dictionary,
    maxOutputLength: MAX_LINK_MESSAGE_BYTES * 4 + 7 * 65538 + 64
  });
  return decodeBinaryBody(raw);
}

function decodeMessageFrame(bytes: Uint8Array): unknown {
  assertDeflateV2Dictionary();
  const headerLength = bytes[1];
  if (headerLength === undefined || headerLength === 0 || headerLength + 2 >= bytes.byteLength)
    throw new TypeError("Truncated message-v1 frame");
  const decoded: unknown = inflateRawSync(bytes.subarray(2, 2 + headerLength), {
    dictionary,
    maxOutputLength: 7 * 65538 + 64,
    info: true
  });
  if (
    !isRecord(decoded) ||
    !Buffer.isBuffer(decoded.buffer) ||
    !isRecord(decoded.engine) ||
    decoded.engine.bytesWritten !== headerLength
  )
    throw new TypeError("Trailing message-v1 header bytes");
  return decodeBinaryBody(decoded.buffer, bytes.subarray(2 + headerLength));
}

function decodeMethodFrame(bytes: Uint8Array): unknown {
  const mode = bytes[1] ?? -1;
  const raw = decompressValue(mode, bytes.subarray(2), MAX_LINK_MESSAGE_BYTES * 8 + 7 * 65538 + 64);
  const value = decodeBinaryBody(raw, undefined, mode);
  if (!isRecord(value) || value.i !== 0 || value.n !== 1)
    throw new TypeError("Method frame requires one complete payload");
  return value;
}

function decodeBinaryBody(raw: Uint8Array, separatePayload?: Uint8Array, methodMode?: number): unknown {
  let offset = 0;
  const integer = () => {
    let value = 0;
    let multiplier = 1;
    for (let index = 0; index < 8; index++) {
      const byte = raw[offset++];
      if (byte === undefined) throw new TypeError("Truncated binary-v1 frame");
      value += (byte & 127) * multiplier;
      if (!Number.isSafeInteger(value)) throw new TypeError("Invalid binary-v1 frame integer");
      if (byte < 128) return value;
      multiplier *= 128;
    }
    throw new TypeError("Invalid binary-v1 frame integer");
  };
  const string = () => {
    const length = integer();
    if (length > 65535 || offset + length > raw.length) throw new TypeError("Truncated binary-v1 frame header");
    const value = decodeBinaryUtf8(raw.subarray(offset, offset + length));
    offset += length;
    return value;
  };
  const [v, k, y, g, q, i, n] = Array.from({ length: 7 }, integer);
  const [s, d, x, o, m] = Array.from({ length: 5 }, string);
  const receiptFlag = integer();
  if (receiptFlag < 0 || receiptFlag > 3) throw new TypeError("Invalid binary-v1 receipt flag");
  const receipt = (receiptFlag & 1) === 1 ? { operation_id: string(), message_id: string() } : undefined;
  if (separatePayload !== undefined && (offset !== raw.length || (receiptFlag & 2) === 0))
    throw new TypeError("Invalid message-v1 header boundary or payload flag");
  if (separatePayload === undefined && raw.length === offset)
    throw new TypeError("Binary-v1 payload must not be empty");
  if (methodMode !== undefined && (receiptFlag & 2) === 0)
    throw new TypeError("Method frame requires an opaque encoded payload");
  const encodedPayload =
    separatePayload ?? ((receiptFlag & 2) === 2 ? raw.subarray(offset) : decodeBinaryPayload(raw, offset));
  const payload = methodMode === undefined ? encodedPayload : restoreValue(methodMode, encodedPayload);
  if (payload.byteLength > MAX_LINK_MESSAGE_BYTES) throw new RangeError("Link payload exceeds 128 KiB");
  return {
    v,
    k: String.fromCharCode(k ?? 0),
    y: String.fromCharCode(y ?? 0),
    s,
    ...(d === "" ? {} : { d }),
    g,
    x,
    q,
    o,
    m,
    i,
    n,
    ...(receipt === undefined ? {} : { receipt }),
    p: Buffer.from(payload).toString("base64url")
  };
}

function assertDeflateV2Dictionary(): void {
  assertPinnedDictionary("deflate-v2", DEFLATE_V2_DICTIONARY_SHA256);
}

function assertDeflateV3Dictionary(): void {
  assertPinnedDictionary("deflate-v3", DEFLATE_V3_DICTIONARY_SHA256);
}

function assertPinnedDictionary(encoding: "deflate-v2" | "deflate-v3", expected: string): void {
  if (pinnedDictionaryVerified) return;
  const actual = createHash("sha256").update(dictionary).digest("hex");
  if (actual !== expected) {
    throw new Error(`${encoding} dictionary changed (expected ${expected}, got ${actual}); assign a new wire version`);
  }
  pinnedDictionaryVerified = true;
}

function validateReceipt(identity: FrameIdentity, encoding: FrameEncoding, index: number, count: number): void {
  if (identity.receipt === undefined) return;
  if (encoding !== "deflate-v3" && encoding !== "binary-v1" && encoding !== "message-v1" && encoding !== "message-v2")
    throw new TypeError("Receipt metadata requires deflate-v3, binary-v1, message-v1, or message-v2");
  if (identity.message_type !== "task_report" || identity.destination === undefined)
    throw new TypeError("Receipt metadata requires an addressed task_report frame");
  if (index !== 0 || count !== 1) throw new RangeError("Receipt metadata requires a single frame");
  if (!isNonEmptyString(identity.receipt.operation_id) || !isNonEmptyString(identity.receipt.message_id))
    throw new TypeError("Receipt identity fields must be non-empty");
}

function writeVarint(output: number[], value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("Invalid frame integer");
  do {
    const byte = value % 128;
    value = Math.floor(value / 128);
    output.push(byte | (value > 0 ? 128 : 0));
  } while (value > 0);
}

function legacyHeaderRoundTrips(identity: FrameIdentity): boolean {
  const values = [
    encodeNode(identity.source),
    identity.destination === undefined ? "" : encodeNode(identity.destination),
    identity.service_session,
    identity.operation_id,
    identity.message_id,
    ...(identity.receipt === undefined ? [] : [identity.receipt.operation_id, identity.receipt.message_id])
  ];
  return values.every((value) => Buffer.from(value).toString("utf8") === value);
}
