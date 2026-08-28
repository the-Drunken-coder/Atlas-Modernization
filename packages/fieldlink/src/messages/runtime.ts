import { randomInt } from "node:crypto";

import { FIELDLINK_MAX_MESSAGE_BYTES } from "../frame.js";
import type { FieldLinkNode, NodeId, ReceivedMessage } from "../node.js";
import {
  MessageValidationError,
  type MessageDefinition,
} from "./definition.js";
import { isJsonValue, type JsonObject, type JsonValue } from "./resource.js";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });
const MAX_REQUEST_ID_BYTES = 256;
const MAX_ASSET_ID_CHARACTERS = 50;
const MAX_RUNTIME_ID_CHARACTERS = 100;
const MAX_CACHED_REQUESTS = 64;
let nextExerciseRequestId = randomInt(0x1_0000_0000);

/**
 * Runtime carries the Atlas runtime lifecycle without exposing HTTP details.
 * An integrating application validates asset, check-in, and manifest bodies
 * through the Atlas SDK before Core applies them.
 */
export type RuntimeMessage =
  | {
      readonly type: "runtime";
      readonly kind: "request";
      readonly operation: "register";
      readonly request_id: string;
      readonly asset_id: string;
      readonly runtime_id: string;
      readonly asset: JsonObject;
    }
  | {
      readonly type: "runtime";
      readonly kind: "request";
      readonly operation: "ready";
      readonly request_id: string;
      readonly asset_id: string;
      readonly runtime_id: string;
      readonly manifest: readonly JsonValue[];
    }
  | {
      readonly type: "runtime";
      readonly kind: "request";
      readonly operation: "check_in";
      readonly request_id: string;
      readonly asset_id: string;
      readonly runtime_id: string;
      readonly body: RuntimeCheckInBody;
    }
  | {
      readonly type: "runtime";
      readonly kind: "request";
      readonly operation: "stop";
      readonly request_id: string;
      readonly asset_id: string;
      readonly runtime_id: string;
    }
  | {
      readonly type: "runtime";
      readonly kind: "response";
      readonly request_id: string;
      readonly status: number;
      readonly body?: JsonValue;
    };

export type RuntimeRequest = Extract<RuntimeMessage, { kind: "request" }>;
export type RuntimeResponse = Extract<RuntimeMessage, { kind: "response" }>;

/** Atlas Protocol EntityCheckInRequest carried without SDK-only options. */
export interface RuntimeCheckInBody {
  readonly status?: string;
  readonly components?: JsonObject;
  readonly latitude?: number;
  readonly longitude?: number;
  readonly altitude_m?: number;
  readonly speed_m_s?: number;
  readonly heading_deg?: number;
}

export interface RuntimeRequestExecutor {
  execute(
    request: RuntimeRequest,
    signal?: AbortSignal,
  ): Promise<RuntimeResponse>;
}

const exerciseEnvelopeBytes = textEncoder.encode(
  JSON.stringify({
    type: "runtime",
    kind: "response",
    request_id: "exercise-00000000",
    status: 204,
    body: "",
  } satisfies RuntimeMessage),
).length;

export const runtimeMessage = {
  id: 3,
  name: "runtime",
  defaultPriority: "high",
  examples: [
    {
      type: "runtime",
      kind: "request",
      operation: "register",
      request_id: "req-register-runtime",
      asset_id: "asset-1",
      runtime_id: "runtime-7f347e18",
      asset: {
        entity_id: "asset-1",
        entity_type: "asset",
        alias: "Field asset 1",
      },
    },
    {
      type: "runtime",
      kind: "request",
      operation: "ready",
      request_id: "req-ready-runtime",
      asset_id: "asset-1",
      runtime_id: "runtime-7f347e18",
      manifest: [],
    },
    {
      type: "runtime",
      kind: "request",
      operation: "check_in",
      request_id: "req-check-in",
      asset_id: "asset-1",
      runtime_id: "runtime-7f347e18",
      body: { status: "online", latitude: 38.8977, longitude: -77.0365 },
    },
    {
      type: "runtime",
      kind: "request",
      operation: "stop",
      request_id: "req-stop-runtime",
      asset_id: "asset-1",
      runtime_id: "runtime-7f347e18",
    },
    {
      type: "runtime",
      kind: "response",
      request_id: "req-ready-runtime",
      status: 204,
    },
  ],
  validate(value: unknown): value is RuntimeMessage {
    if (!isPlainRecord(value) || value.type !== "runtime") {
      return false;
    }
    if (value.kind === "response") {
      return isResponse(value);
    }
    if (
      value.kind !== "request" ||
      !isRequestId(value.request_id) ||
      !isBoundedIdentifier(value.asset_id, MAX_ASSET_ID_CHARACTERS) ||
      !isBoundedIdentifier(value.runtime_id, MAX_RUNTIME_ID_CHARACTERS)
    ) {
      return false;
    }
    switch (value.operation) {
      case "register":
        return (
          hasShape(value, [
            "type",
            "kind",
            "operation",
            "request_id",
            "asset_id",
            "runtime_id",
            "asset",
          ]) &&
          isJsonObject(value.asset) &&
          value.asset.entity_id === value.asset_id &&
          isBoundedIdentifier(value.asset.entity_type, MAX_ASSET_ID_CHARACTERS)
        );
      case "ready":
        return (
          hasShape(value, [
            "type",
            "kind",
            "operation",
            "request_id",
            "asset_id",
            "runtime_id",
            "manifest",
          ]) &&
          Array.isArray(value.manifest) &&
          isJsonValue(value.manifest)
        );
      case "check_in":
        return (
          hasShape(value, [
            "type",
            "kind",
            "operation",
            "request_id",
            "asset_id",
            "runtime_id",
            "body",
          ]) && isCheckInBody(value.body)
        );
      case "stop":
        return hasShape(value, [
          "type",
          "kind",
          "operation",
          "request_id",
          "asset_id",
          "runtime_id",
        ]);
      default:
        return false;
    }
  },
  encode(message: RuntimeMessage): Uint8Array {
    if (!this.validate(message)) {
      throw new MessageValidationError("Invalid Runtime message");
    }
    const encoded = textEncoder.encode(JSON.stringify(message));
    if (encoded.length > FIELDLINK_MAX_MESSAGE_BYTES) {
      throw new MessageValidationError(
        `Runtime message exceeds ${FIELDLINK_MAX_MESSAGE_BYTES} encoded bytes`,
      );
    }
    return encoded;
  },
  decode(bytes: Uint8Array): RuntimeMessage {
    if (bytes.length === 0 || bytes.length > FIELDLINK_MAX_MESSAGE_BYTES) {
      throw new MessageValidationError(
        `Runtime message must be 1 to ${FIELDLINK_MAX_MESSAGE_BYTES} bytes`,
      );
    }
    let value: unknown;
    try {
      value = JSON.parse(textDecoder.decode(bytes)) as unknown;
    } catch (error: unknown) {
      throw new MessageValidationError(
        `Runtime message is not valid UTF-8 JSON: ${asErrorMessage(error)}`,
      );
    }
    if (!this.validate(value)) {
      throw new MessageValidationError("Invalid Runtime message");
    }
    return value;
  },
  exercise: {
    defaultPayloadBytes: 32,
    maximumPayloadBytes: FIELDLINK_MAX_MESSAGE_BYTES - exerciseEnvelopeBytes,
    payloadPresets: [32, 4096],
    create(payloadBytes: number): RuntimeMessage {
      return {
        type: "runtime",
        kind: "response",
        request_id: takeExerciseRequestId(),
        status: 200,
        body: "x".repeat(payloadBytes),
      };
    },
    key(message): string {
      return message.request_id;
    },
    isComplete({ sent, received, side }): boolean {
      if (sent.kind === "request") {
        return (
          side === "source" &&
          received.kind === "response" &&
          received.request_id === sent.request_id
        );
      }
      return (
        side === "destination" &&
        received.kind === "response" &&
        received.request_id === sent.request_id &&
        received.status === sent.status &&
        received.body === sent.body
      );
    },
  },
} satisfies MessageDefinition<RuntimeMessage>;

/** Executes Runtime requests from one preflight-approved radio. */
export function attachRuntimeRequestHandler(
  node: Pick<FieldLinkNode, "onMessage" | "send">,
  executor: RuntimeRequestExecutor,
  allowedSource: NodeId,
  signal?: AbortSignal,
): () => Promise<void> {
  const ownedController = new AbortController();
  const lifecycleSignal =
    signal === undefined
      ? ownedController.signal
      : AbortSignal.any([ownedController.signal, signal]);
  const cached = new Map<
    string,
    {
      readonly encodedRequest: string;
      readonly response: Promise<RuntimeResponse>;
    }
  >();
  const settledKeys = new Set<string>();
  const active = new Set<Promise<void>>();

  const unsubscribe = node.onMessage((received: ReceivedMessage) => {
    const operation = handle(received);
    active.add(operation);
    void operation.then(
      () => active.delete(operation),
      () => active.delete(operation),
    );
    return operation;
  });

  async function handle(received: ReceivedMessage): Promise<void> {
    const message = received.message;
    if (
      lifecycleSignal.aborted ||
      received.source !== allowedSource ||
      message.type !== "runtime" ||
      message.kind !== "request"
    ) {
      return;
    }

    const key = `${received.source}:${message.request_id}`;
    const encodedRequest = JSON.stringify(message);
    const previous = cached.get(key);
    let response: Promise<RuntimeResponse> | undefined;
    if (previous !== undefined) {
      response =
        previous.encodedRequest === encodedRequest
          ? previous.response
          : Promise.resolve({
              type: "runtime",
              kind: "response",
              request_id: message.request_id,
              status: 409,
              body: { error: "request_id was already used for different JSON" },
            });
    } else {
      if (cached.size >= MAX_CACHED_REQUESTS) {
        const settled = [...cached].find(([cachedKey]) =>
          settledKeys.has(cachedKey),
        );
        if (settled === undefined) {
          response = Promise.resolve({
            type: "runtime",
            kind: "response",
            request_id: message.request_id,
            status: 503,
            body: { error: "Runtime request handler is at capacity" },
          });
        } else {
          cached.delete(settled[0]);
          settledKeys.delete(settled[0]);
        }
      }
      if (response === undefined) {
        response = executor
          .execute(message, lifecycleSignal)
          .catch(() => ({
            type: "runtime" as const,
            kind: "response" as const,
            request_id: message.request_id,
            status: 500,
            body: { error: "Atlas Runtime request failed" },
          }))
          .finally(() => {
            settledKeys.add(key);
          });
        cached.set(key, { encodedRequest, response });
      }
    }

    const resolved = await response;
    if (isActive(lifecycleSignal)) {
      await node.send(resolved, {
        destination: received.source,
        signal: lifecycleSignal,
      });
    }
  }

  return async () => {
    unsubscribe();
    ownedController.abort(new Error("Runtime request handler disposed"));
    await Promise.allSettled(active);
  };
}

function isResponse(value: Record<string, unknown>): boolean {
  return (
    hasShape(value, ["type", "kind", "request_id", "status"], ["body"]) &&
    isRequestId(value.request_id) &&
    typeof value.status === "number" &&
    Number.isInteger(value.status) &&
    value.status >= 100 &&
    value.status <= 599 &&
    (!Object.hasOwn(value, "body") || isJsonValue(value.body))
  );
}

function isJsonObject(value: unknown): value is JsonObject {
  return isPlainRecord(value) && isJsonValue(value);
}

function isCheckInBody(value: unknown): value is RuntimeCheckInBody {
  if (
    !isPlainRecord(value) ||
    !hasShape(
      value,
      [],
      [
        "status",
        "components",
        "latitude",
        "longitude",
        "altitude_m",
        "speed_m_s",
        "heading_deg",
      ],
    )
  ) {
    return false;
  }
  return (
    (!Object.hasOwn(value, "status") ||
      (typeof value.status === "string" && value.status.length > 0)) &&
    (!Object.hasOwn(value, "components") || isJsonObject(value.components)) &&
    (!Object.hasOwn(value, "latitude") ||
      isBoundedNumber(value.latitude, -90, 90, true)) &&
    (!Object.hasOwn(value, "longitude") ||
      isBoundedNumber(value.longitude, -180, 180, true)) &&
    (!Object.hasOwn(value, "altitude_m") || isFiniteNumber(value.altitude_m)) &&
    (!Object.hasOwn(value, "speed_m_s") ||
      isBoundedNumber(value.speed_m_s, 0, Number.POSITIVE_INFINITY, true)) &&
    (!Object.hasOwn(value, "heading_deg") ||
      isBoundedNumber(value.heading_deg, 0, 360, false))
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isBoundedNumber(
  value: unknown,
  minimum: number,
  maximum: number,
  includeMaximum: boolean,
): value is number {
  return (
    isFiniteNumber(value) &&
    value >= minimum &&
    (includeMaximum ? value <= maximum : value < maximum)
  );
}

function isRequestId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    textEncoder.encode(value).length <= MAX_REQUEST_ID_BYTES
  );
}

function isBoundedIdentifier(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Array.from(value).length <= maximum
  );
}

function isActive(signal: AbortSignal): boolean {
  return !signal.aborted;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function hasShape(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const expected = new Set([...required, ...optional]);
  const keys = Reflect.ownKeys(value);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => typeof key === "string" && expected.has(key))
  );
}

function takeExerciseRequestId(): string {
  const value = nextExerciseRequestId;
  nextExerciseRequestId = (nextExerciseRequestId + 1) >>> 0;
  return `exercise-${value.toString(16).padStart(8, "0")}`;
}

function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
