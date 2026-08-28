import { randomInt } from "node:crypto";

import { FIELDLINK_MAX_MESSAGE_BYTES } from "../frame.js";
import {
  MessageValidationError,
  type MessageDefinition,
} from "./definition.js";
import { isJsonValue, type JsonObject } from "./resource.js";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });
const MAX_IDENTIFIER_CHARACTERS = 100;
let nextExerciseId = randomInt(0x1_0000_0000);

export type ObservationResourceType =
  "entity" | "track" | "geofeature" | "object";

/** A state snapshot intended to be collected by every FieldLink listener. */
export interface ObservationMessage {
  readonly type: "observation";
  readonly observation_id: string;
  readonly observed_at: string;
  readonly resource_type: ObservationResourceType;
  readonly resource_id: string;
  readonly body: JsonObject;
}

const exerciseEnvelopeBytes = textEncoder.encode(
  JSON.stringify({
    type: "observation",
    observation_id: "exercise-00000000",
    observed_at: "2026-08-26T12:00:00.000Z",
    resource_type: "track",
    resource_id: "exercise-track",
    body: { payload: "" },
  } satisfies ObservationMessage),
).length;

export const observationMessage = {
  id: 5,
  name: "observation",
  defaultPriority: "normal",
  passivelyObservable: true,
  examples: [
    {
      type: "observation",
      observation_id: "observation-track-1-42",
      observed_at: "2026-08-26T12:00:00.000Z",
      resource_type: "track",
      resource_id: "track-1",
      body: {
        track_id: "track-1",
        latitude: 38.8977,
        longitude: -77.0365,
        heading_deg: 92,
      },
    },
    {
      type: "observation",
      observation_id: "observation-object-1-v3",
      observed_at: "2026-08-26T12:00:01.000Z",
      resource_type: "object",
      resource_id: "object-1",
      body: {
        object_id: "object-1",
        content_type: "application/json",
        size_bytes: 2048,
        metadata: { version: 3 },
      },
    },
  ],
  validate(value: unknown): value is ObservationMessage {
    return (
      isPlainRecord(value) &&
      hasExactKeys(value, [
        "type",
        "observation_id",
        "observed_at",
        "resource_type",
        "resource_id",
        "body",
      ]) &&
      value.type === "observation" &&
      isIdentifier(value.observation_id) &&
      isTimestamp(value.observed_at) &&
      isResourceType(value.resource_type) &&
      isIdentifier(value.resource_id) &&
      isPlainRecord(value.body) &&
      isJsonValue(value.body)
    );
  },
  encode(message: ObservationMessage): Uint8Array {
    if (!this.validate(message)) {
      throw new MessageValidationError("Invalid Observation message");
    }
    const encoded = textEncoder.encode(JSON.stringify(message));
    if (encoded.length > FIELDLINK_MAX_MESSAGE_BYTES) {
      throw new MessageValidationError(
        `Observation message exceeds ${FIELDLINK_MAX_MESSAGE_BYTES} encoded bytes`,
      );
    }
    return encoded;
  },
  decode(bytes: Uint8Array): ObservationMessage {
    if (bytes.length === 0 || bytes.length > FIELDLINK_MAX_MESSAGE_BYTES) {
      throw new MessageValidationError(
        `Observation message must be 1 to ${FIELDLINK_MAX_MESSAGE_BYTES} bytes`,
      );
    }
    let value: unknown;
    try {
      value = JSON.parse(textDecoder.decode(bytes)) as unknown;
    } catch (error: unknown) {
      throw new MessageValidationError(
        `Observation message is not valid UTF-8 JSON: ${asErrorMessage(error)}`,
      );
    }
    if (!this.validate(value)) {
      throw new MessageValidationError("Invalid Observation message");
    }
    return value;
  },
  exercise: {
    defaultPayloadBytes: 32,
    maximumPayloadBytes:
      FIELDLINK_MAX_MESSAGE_BYTES - exerciseEnvelopeBytes - 64,
    payloadPresets: [32, 4096],
    create(payloadBytes: number): ObservationMessage {
      const id = takeExerciseId();
      return {
        type: "observation",
        observation_id: id,
        observed_at: "2026-08-26T12:00:00.000Z",
        resource_type: "track",
        resource_id: id,
        body: { payload: "x".repeat(payloadBytes) },
      };
    },
    key(message): string {
      return message.observation_id;
    },
    isComplete({ sent, received, side }): boolean {
      return (
        side === "destination" &&
        received.observation_id === sent.observation_id &&
        JSON.stringify(received) === JSON.stringify(sent)
      );
    },
  },
} satisfies MessageDefinition<ObservationMessage>;

function isResourceType(value: unknown): value is ObservationResourceType {
  return (
    value === "entity" ||
    value === "track" ||
    value === "geofeature" ||
    value === "object"
  );
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.includes("T") &&
    (value.endsWith("Z") || /[+-]\d{2}:\d{2}$/.test(value)) &&
    Number.isFinite(Date.parse(value))
  );
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_IDENTIFIER_CHARACTERS
  );
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function takeExerciseId(): string {
  const value = nextExerciseId;
  nextExerciseId = (nextExerciseId + 1) % 0x1_0000_0000;
  return `exercise-${value.toString(16).padStart(8, "0")}`;
}

function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
