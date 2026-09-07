import { decodeJSON, encodeCanonicalJSON } from "./canonical-json.js";
import { deserializeLinkMessage, isLinkMessage, resourceID, serializeLinkMessage } from "./contract.js";
import { MAX_LINK_MESSAGE_BYTES } from "./frame.js";
import type { LinkNode, StatePublication } from "./types.js";

/** Binary-v1 is an inner state payload; the outer Link frame remains message_type=state. */
export const STATE_DELTA_CODEC = "binary-v1" as const;
export const STATE_DELTA_MARKER = 0xb1;
export const STATE_DELTA_BASELINE_INTERVAL_MS = 15_000;

const VERSION = 1;
const DELTA_KIND = 1;
const DEFAULT_MAX_BASELINES = 64;
type ResourceType = "entity" | "task" | "object";
type JSONData = null | boolean | number | string | JSONData[] | { [key: string]: JSONData };

export type StateDeltaIdentity = {
  source: LinkNode;
  source_generation: number;
  service_session: string;
  source_sequence: number;
};

export type StateDeltaOptions = {
  baselineIntervalMs?: number;
  maxResources?: number;
};

export type StateDeltaPatchOperation =
  | { op: "add"; path: string[]; value: JSONData }
  | { op: "remove"; path: string[] }
  | { op: "replace"; path: string[]; value: JSONData };

export type StateDeltaPatch = StateDeltaPatchOperation[];

export type PreparedStateDelta = {
  codec: typeof STATE_DELTA_CODEC;
  /** The normal canonical Link payload. Commit this baseline only after it is sent. */
  fullPayload: Uint8Array;
  /** An optional candidate to compare after framing against fullPayload. */
  deltaPayload?: Uint8Array;
  baselineSourceSequence?: number;
  commitFull: () => void;
};

type SenderBaseline = {
  publication: StatePublication;
  source_sequence: number;
  sentAt: number;
};

type ReceiverBaseline = {
  publication: StatePublication;
  source_sequence: number;
};

type ReceiverScope = {
  latest?: ReceiverBaseline;
  previous?: ReceiverBaseline;
};

/** Creates deltas from the last committed full snapshot, never from another delta. */
export class StateDeltaEncoder {
  private readonly baselines = new Map<string, SenderBaseline>();
  private readonly baselineIntervalMs: number;
  private readonly maxResources: number;

  constructor(options: StateDeltaOptions = {}) {
    this.baselineIntervalMs = positiveInteger(
      options.baselineIntervalMs ?? STATE_DELTA_BASELINE_INTERVAL_MS,
      "baseline interval"
    );
    this.maxResources = positiveInteger(options.maxResources ?? DEFAULT_MAX_BASELINES, "baseline cache limit");
  }

  prepare(publication: StatePublication, identity: StateDeltaIdentity, now = Date.now()): PreparedStateDelta {
    validateIdentity(identity);
    validatePublication(publication);
    if (!Number.isFinite(now)) throw new RangeError("state delta time must be finite");

    const fullPayload = serializeLinkMessage(publication);
    if (fullPayload.byteLength > MAX_LINK_MESSAGE_BYTES) throw new RangeError("state publication exceeds 128 KiB");
    const resourceType = publication.resource_type;
    const resourceIDValue = resourceID(publication);
    const scope = scopeKey(identity, resourceType, resourceIDValue);
    const baseline = this.baselines.get(scope);
    if (
      !baseline ||
      now - baseline.sentAt >= this.baselineIntervalMs ||
      baseline.source_sequence >= identity.source_sequence
    ) {
      return this.fullPreparation(identity, publication, now, fullPayload, scope);
    }

    const patch = diffJSON(asJSONData(baseline.publication), asJSONData(publication));
    const full = this.fullPreparation(identity, publication, now, fullPayload, scope);
    try {
      const deltaPayload = boundedDelta(encodeDelta(resourceType, resourceIDValue, baseline.source_sequence, patch));
      if (deltaPayload === undefined) return full;
      return { ...full, deltaPayload, baselineSourceSequence: baseline.source_sequence };
    } catch {
      // An optional compact envelope must not reject a valid full Protocol publication.
      return full;
    }
  }

  private fullPreparation(
    identity: StateDeltaIdentity,
    publication: StatePublication,
    sentAt: number,
    fullPayload: Uint8Array,
    scope: string
  ): PreparedStateDelta {
    let committed = false;
    const snapshot = structuredClone(publication);
    return {
      codec: STATE_DELTA_CODEC,
      fullPayload,
      commitFull: () => {
        if (committed) return;
        committed = true;
        const previous = this.baselines.get(scope);
        if (previous && previous.source_sequence >= identity.source_sequence) return;
        this.baselines.delete(scope);
        this.baselines.set(scope, {
          publication: snapshot,
          source_sequence: identity.source_sequence,
          sentAt
        });
        while (this.baselines.size > this.maxResources) {
          const oldest = this.baselines.keys().next().value as string | undefined;
          if (oldest === undefined) return;
          this.baselines.delete(oldest);
        }
      }
    };
  }
}

/** Decodes binary-v1 deltas and remembers normal canonical full state payloads. */
export class StateDeltaDecoder {
  private readonly baselines = new Map<string, ReceiverScope>();
  private readonly maxResources: number;

  constructor(options: Pick<StateDeltaOptions, "maxResources"> = {}) {
    this.maxResources = positiveInteger(options.maxResources ?? DEFAULT_MAX_BASELINES, "baseline cache limit");
  }

  /** Returns undefined for non-state payloads, malformed deltas, or a missing baseline. */
  decode(payload: Uint8Array, identity: StateDeltaIdentity): StatePublication | undefined {
    try {
      if (payload.byteLength === 0 || payload.byteLength > MAX_LINK_MESSAGE_BYTES) return undefined;
      validateIdentity(identity);
      if (isStateDeltaPayload(payload)) return this.decodeDelta(payload, identity);
      const message = deserializeLinkMessage(payload);
      if (!isStatePublication(message)) return undefined;
      this.rememberFull(message, identity);
      return structuredClone(message);
    } catch {
      return undefined;
    }
  }

  private decodeDelta(payload: Uint8Array, identity: StateDeltaIdentity): StatePublication | undefined {
    const reader = new BinaryReader(payload);
    if (reader.readByte() !== STATE_DELTA_MARKER || reader.readByte() !== VERSION) return undefined;
    const kind = reader.readByte();
    const resourceType = decodeResourceType(reader.readByte());
    const resourceIDValue = reader.readUTF8();
    const baselineSourceSequence = reader.readUnsignedVarint();
    const patchBytes = reader.readRemaining();
    if (
      kind !== DELTA_KIND ||
      resourceType === undefined ||
      resourceIDValue === undefined ||
      baselineSourceSequence === undefined ||
      baselineSourceSequence >= identity.source_sequence
    ) {
      return undefined;
    }
    const scope = this.baselines.get(scopeKey(identity, resourceType, resourceIDValue));
    const baseline = [scope?.latest, scope?.previous].find(
      (candidate) => candidate?.source_sequence === baselineSourceSequence
    );
    if (!baseline) return undefined;
    const patch = decodeJSON(patchBytes);
    if (!isPatch(patch)) return undefined;
    const result = applyPatch(asJSONData(baseline.publication), patch);
    if (result === undefined || !isStatePublicationForIdentity(result, resourceType, resourceIDValue)) return undefined;
    const reconstructed = serializeLinkMessage(result);
    return reconstructed.byteLength <= MAX_LINK_MESSAGE_BYTES ? structuredClone(result) : undefined;
  }

  private rememberFull(publication: StatePublication, identity: StateDeltaIdentity): void {
    const key = scopeKey(identity, publication.resource_type, resourceID(publication));
    const incoming = { publication: structuredClone(publication), source_sequence: identity.source_sequence };
    const scope = this.baselines.get(key);
    if (scope?.latest && identity.source_sequence <= scope.latest.source_sequence) {
      if (scope.previous === undefined || identity.source_sequence > scope.previous.source_sequence)
        scope.previous = incoming;
      return;
    }
    this.baselines.delete(key);
    this.baselines.set(key, {
      latest: incoming,
      ...(scope?.latest === undefined ? {} : { previous: scope.latest })
    });
    while (this.baselines.size > this.maxResources) {
      const oldest = this.baselines.keys().next().value as string | undefined;
      if (oldest === undefined) return;
      this.baselines.delete(oldest);
    }
  }
}

export function isStateDeltaPayload(payload: Uint8Array): boolean {
  return payload.byteLength > 0 && payload[0] === STATE_DELTA_MARKER;
}

function encodeDelta(
  resourceType: ResourceType,
  resourceIDValue: string,
  baselineSourceSequence: number,
  patch: StateDeltaPatch
): Uint8Array {
  return concat([
    Uint8Array.of(STATE_DELTA_MARKER, VERSION, DELTA_KIND, resourceCode(resourceType)),
    lengthPrefixedUTF8(resourceIDValue),
    encodeUnsignedVarint(baselineSourceSequence),
    encodeCanonicalJSON(patch)
  ]);
}

function boundedDelta(payload: Uint8Array): Uint8Array | undefined {
  return payload.byteLength <= MAX_LINK_MESSAGE_BYTES ? payload : undefined;
}

function validateIdentity(identity: StateDeltaIdentity): void {
  if (
    !identity.source ||
    (identity.source.role !== "asset" && identity.source.role !== "gateway") ||
    !nonEmpty(identity.source.id) ||
    !Number.isSafeInteger(identity.source_generation) ||
    identity.source_generation < 0 ||
    !nonEmpty(identity.service_session) ||
    !Number.isSafeInteger(identity.source_sequence) ||
    identity.source_sequence < 0
  ) {
    throw new TypeError("state delta identity is invalid");
  }
}

function validatePublication(publication: StatePublication): void {
  if (!isStatePublication(publication) || !isJSONData(publication)) throw new TypeError("state publication is invalid");
}

function isStatePublication(value: unknown): value is StatePublication {
  return isLinkMessage(value) && value.type === "state";
}

function isStatePublicationForIdentity(
  value: unknown,
  resourceType: ResourceType,
  resourceIDValue: string
): value is StatePublication {
  return isStatePublication(value) && value.resource_type === resourceType && resourceID(value) === resourceIDValue;
}

function resourceCode(resourceType: ResourceType): number {
  if (resourceType === "entity") return 1;
  if (resourceType === "task") return 2;
  return 3;
}

function decodeResourceType(value: number | undefined): ResourceType | undefined {
  if (value === 1) return "entity";
  if (value === 2) return "task";
  if (value === 3) return "object";
  return undefined;
}

function scopeKey(
  identity: StateDeltaIdentity,
  resourceType: ResourceType,
  resourceIDValue: string,
  baselineSourceSequence?: number
): string {
  return JSON.stringify([
    identity.source.role,
    identity.source.id,
    identity.source_generation,
    identity.service_session,
    resourceType,
    resourceIDValue,
    ...(baselineSourceSequence === undefined ? [] : [baselineSourceSequence])
  ]);
}

function lengthPrefixedUTF8(value: string): Uint8Array {
  const bytes = new TextEncoder().encode(value);
  if (new TextDecoder("utf-8", { fatal: true }).decode(bytes) !== value) throw new TypeError("invalid UTF-8 string");
  return concat([encodeUnsignedVarint(bytes.byteLength), bytes]);
}

function encodeUnsignedVarint(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("state delta integer is invalid");
  const bytes: number[] = [];
  let remaining = BigInt(value);
  do {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining !== 0n) byte |= 0x80;
    bytes.push(byte);
  } while (remaining !== 0n);
  return Uint8Array.from(bytes);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

class BinaryReader {
  private offset = 0;

  constructor(private readonly payload: Uint8Array) {}

  readByte(): number | undefined {
    if (this.offset >= this.payload.byteLength) return undefined;
    return this.payload[this.offset++];
  }

  readUnsignedVarint(): number | undefined {
    let value = 0n;
    for (let index = 0; index < 8; index++) {
      const byte = this.readByte();
      if (byte === undefined) return undefined;
      value |= BigInt(byte & 0x7f) << BigInt(index * 7);
      if ((byte & 0x80) === 0) return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : undefined;
    }
    return undefined;
  }

  readBytes(length: number): Uint8Array | undefined {
    if (!Number.isSafeInteger(length) || length < 0 || length > this.payload.byteLength - this.offset) return undefined;
    const result = this.payload.slice(this.offset, this.offset + length);
    this.offset += length;
    return result;
  }

  readUTF8(): string | undefined {
    const length = this.readUnsignedVarint();
    const bytes = length === undefined ? undefined : this.readBytes(length);
    if (bytes === undefined) return undefined;
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return undefined;
    }
  }

  readRemaining(): Uint8Array {
    return this.payload.slice(this.offset);
  }
}

function asJSONData(value: unknown): JSONData {
  if (!isJSONData(value)) throw new TypeError("state delta value must be JSON data");
  return value;
}

function isJSONData(value: unknown, seen = new Set<object>()): value is JSONData {
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  const valid = Array.isArray(value)
    ? value.every((child) => isJSONData(child, seen))
    : (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) &&
      Object.keys(value).every((key) => isJSONData((value as Record<string, unknown>)[key], seen));
  seen.delete(value);
  return valid;
}

function diffJSON(left: JSONData, right: JSONData, path: string[] = []): StateDeltaPatch {
  if (left === right) return [];
  if (Array.isArray(left) && Array.isArray(right)) {
    const operations: StateDeltaPatch = [];
    const sharedLength = Math.min(left.length, right.length);
    for (let index = 0; index < sharedLength; index++) {
      operations.push(...diffJSON(left[index]!, right[index]!, [...path, String(index)]));
    }
    for (let index = left.length - 1; index >= right.length; index--)
      operations.push({ op: "remove", path: [...path, String(index)] });
    for (let index = left.length; index < right.length; index++)
      operations.push({ op: "add", path: [...path, String(index)], value: right[index]! });
    return operations;
  }
  if (isJSONObject(left) && isJSONObject(right)) {
    const operations: StateDeltaPatch = [];
    for (const key of Object.keys(left).sort())
      if (!Object.hasOwn(right, key)) operations.push({ op: "remove", path: [...path, key] });
    for (const key of Object.keys(right).sort()) {
      if (!Object.hasOwn(left, key)) operations.push({ op: "add", path: [...path, key], value: right[key]! });
      else operations.push(...diffJSON(left[key]!, right[key]!, [...path, key]));
    }
    return operations;
  }
  return [{ op: "replace", path, value: right }];
}

function isJSONObject(value: JSONData): value is { [key: string]: JSONData } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPatch(value: unknown): value is StateDeltaPatch {
  return (
    Array.isArray(value) &&
    value.every((operation) => {
      if (
        !isRecord(operation) ||
        !Array.isArray(operation.path) ||
        !operation.path.every((part) => typeof part === "string")
      )
        return false;
      if (operation.op === "remove") return Object.keys(operation).every((key) => key === "op" || key === "path");
      return (
        (operation.op === "add" || operation.op === "replace") &&
        Object.keys(operation).every((key) => key === "op" || key === "path" || key === "value") &&
        Object.hasOwn(operation, "value") &&
        isJSONData(operation.value)
      );
    })
  );
}

function applyPatch(document: JSONData, patch: StateDeltaPatch): JSONData | undefined {
  let result = structuredClone(document) as JSONData;
  for (const operation of patch) {
    if (operation.path.length === 0) {
      if (operation.op === "remove") return undefined;
      result = structuredClone(operation.value) as JSONData;
      continue;
    }
    const parent = pathValue(result, operation.path.slice(0, -1));
    const segment = operation.path.at(-1)!;
    if (Array.isArray(parent)) {
      const index = arrayIndex(segment);
      if (index === undefined) return undefined;
      if (operation.op === "add") {
        if (index > parent.length) return undefined;
        parent.splice(index, 0, structuredClone(operation.value) as JSONData);
      } else {
        if (index >= parent.length) return undefined;
        if (operation.op === "remove") parent.splice(index, 1);
        else parent[index] = structuredClone(operation.value) as JSONData;
      }
    } else if (parent !== undefined && isJSONObject(parent)) {
      if (operation.op === "remove") {
        if (!Object.hasOwn(parent, segment)) return undefined;
        delete parent[segment];
      } else if (operation.op === "replace" && !Object.hasOwn(parent, segment)) {
        return undefined;
      } else {
        Object.defineProperty(parent, segment, {
          value: structuredClone(operation.value),
          enumerable: true,
          configurable: true,
          writable: true
        });
      }
    } else {
      return undefined;
    }
  }
  return result;
}

function pathValue(root: JSONData, path: string[]): JSONData | undefined {
  let current: JSONData = root;
  for (const segment of path) {
    if (Array.isArray(current)) {
      const index = arrayIndex(segment);
      if (index === undefined || index >= current.length) return undefined;
      current = current[index]!;
    } else if (isJSONObject(current) && Object.hasOwn(current, segment)) {
      current = current[segment]!;
    } else {
      return undefined;
    }
  }
  return current;
}

function arrayIndex(value: string): number | undefined {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) return undefined;
  const index = Number(value);
  return Number.isSafeInteger(index) ? index : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
  return value;
}
