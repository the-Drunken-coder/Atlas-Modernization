import { decodeJSON, encodeCanonicalJSON } from "./canonical-json.js";
import { LINK_PROTOCOL_REVISION } from "./contract.js";
import type { LinkMessageType, LinkNode, MessagePriority } from "./types.js";

export const MESHTASTIC_APPLICATION_PAYLOAD_BYTES = 233;
export const MAX_LINK_MESSAGE_BYTES = 128 * 1024;
const MAX_FRAGMENTS = 4096;

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
  maxFrameBytes = MESHTASTIC_APPLICATION_PAYLOAD_BYTES
): Uint8Array[] {
  if (payload.byteLength === 0) throw new TypeError("Link payload must not be empty");
  if (payload.byteLength > MAX_LINK_MESSAGE_BYTES) throw new RangeError("Link payload exceeds 128 KiB");
  if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 64) throw new RangeError("maxFrameBytes is too small");

  // Frame metadata changes at fragment-count digit boundaries, so encoded size is not monotone.
  for (let chunkSize = Math.min(payload.byteLength, maxFrameBytes); chunkSize > 0; chunkSize--) {
    const count = Math.ceil(payload.byteLength / chunkSize);
    if (count > MAX_FRAGMENTS || !framesFit(payload, identity, chunkSize, count, maxFrameBytes)) continue;
    return framesForChunkSize(payload, identity, chunkSize);
  }
  throw new RangeError("Link envelope leaves no room for a payload chunk");
}

export function decodeFrame(bytes: Uint8Array): LinkFrame {
  if (bytes.byteLength > MESHTASTIC_APPLICATION_PAYLOAD_BYTES) {
    throw new RangeError("Meshtastic Link frame exceeds 233 bytes");
  }
  const value = decodeJSON(bytes);
  if (!isCompactFrame(value)) throw new TypeError("Invalid Meshtastic Link frame");
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
    priority: decodePriority(value.y),
    chunk_index: value.i,
    chunk_count: value.n,
    payload
  };
}

function framesForChunkSize(payload: Uint8Array, identity: FrameIdentity, chunkSize: number): Uint8Array[] {
  const count = Math.ceil(payload.byteLength / chunkSize);
  const frames: Uint8Array[] = [];
  for (let index = 0; index < count; index++) {
    const chunk = payload.subarray(index * chunkSize, Math.min((index + 1) * chunkSize, payload.byteLength));
    frames.push(encodeCompactFrame(identity, index, count, chunk));
  }
  return frames;
}

function framesFit(
  payload: Uint8Array,
  identity: FrameIdentity,
  chunkSize: number,
  count: number,
  maxFrameBytes: number
): boolean {
  for (let index = 0; index < count; index++) {
    const chunk = payload.subarray(index * chunkSize, Math.min((index + 1) * chunkSize, payload.byteLength));
    if (encodeCompactFrame(identity, index, count, chunk).byteLength > maxFrameBytes) return false;
  }
  return true;
}

function encodeCompactFrame(identity: FrameIdentity, index: number, count: number, payload: Uint8Array): Uint8Array {
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
  return encodeCanonicalJSON(compact);
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
    Number(value.n) <= MAX_FRAGMENTS &&
    Number(value.i) < Number(value.n) &&
    isBase64URL(value.p)
  );
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
