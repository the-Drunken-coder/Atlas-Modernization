import { randomInt } from "node:crypto";

import { FIELDLINK_MAX_MESSAGE_BYTES } from "../frame.js";
import {
  MessageValidationError,
  type MessageDefinition,
} from "./definition.js";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });
const HEADER_LENGTH_BYTES = 2;
const MAX_IDENTIFIER_CHARACTERS = 100;
const MAX_CONTENT_TYPE_CHARACTERS = 100;
let nextExerciseId = randomInt(0x1_0000_0000);

/** Raw Atlas Object bytes with only the metadata needed to identify them. */
export interface ObjectContentMessage {
  readonly type: "object-content";
  readonly object_id: string;
  readonly content_type?: string;
  readonly content: Uint8Array;
}

export const objectContentMessage = {
  id: 6,
  name: "object-content",
  defaultPriority: "bulk",
  examples: [
    {
      type: "object-content",
      object_id: "object-text-1",
      content_type: "text/plain",
      content: textEncoder.encode("Field report"),
    },
    {
      type: "object-content",
      object_id: "object-matrix-1",
      content_type: "application/octet-stream",
      content: Uint8Array.of(0, 1, 2, 3, 255),
    },
  ],
  validate(value: unknown): value is ObjectContentMessage {
    return (
      isRecord(value) &&
      exactKeys(value) &&
      value.type === "object-content" &&
      isIdentifier(value.object_id) &&
      (value.content_type === undefined ||
        (typeof value.content_type === "string" &&
          value.content_type.length > 0 &&
          value.content_type.length <= MAX_CONTENT_TYPE_CHARACTERS)) &&
      value.content instanceof Uint8Array
    );
  },
  encode(message: ObjectContentMessage): Uint8Array {
    if (!this.validate(message)) {
      throw new MessageValidationError("Invalid Object-content message");
    }
    const header = textEncoder.encode(
      JSON.stringify({
        object_id: message.object_id,
        ...(message.content_type === undefined
          ? {}
          : { content_type: message.content_type }),
      }),
    );
    if (header.length > 0xffff) {
      throw new MessageValidationError("Object-content header is too large");
    }
    const encodedLength =
      HEADER_LENGTH_BYTES + header.length + message.content.length;
    if (encodedLength > FIELDLINK_MAX_MESSAGE_BYTES) {
      throw new MessageValidationError(
        `Object-content message exceeds ${FIELDLINK_MAX_MESSAGE_BYTES} encoded bytes`,
      );
    }
    const encoded = new Uint8Array(encodedLength);
    new DataView(encoded.buffer).setUint16(0, header.length, true);
    encoded.set(header, HEADER_LENGTH_BYTES);
    encoded.set(message.content, HEADER_LENGTH_BYTES + header.length);
    return encoded;
  },
  decode(bytes: Uint8Array): ObjectContentMessage {
    if (
      bytes.length < HEADER_LENGTH_BYTES + 2 ||
      bytes.length > FIELDLINK_MAX_MESSAGE_BYTES
    ) {
      throw new MessageValidationError("Invalid Object-content byte length");
    }
    const headerLength = new DataView(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength,
    ).getUint16(0, true);
    if (
      headerLength === 0 ||
      HEADER_LENGTH_BYTES + headerLength > bytes.length
    ) {
      throw new MessageValidationError("Invalid Object-content header length");
    }
    let header: unknown;
    try {
      header = JSON.parse(
        textDecoder.decode(
          bytes.subarray(
            HEADER_LENGTH_BYTES,
            HEADER_LENGTH_BYTES + headerLength,
          ),
        ),
      ) as unknown;
    } catch (error: unknown) {
      throw new MessageValidationError(
        `Object-content header is not valid UTF-8 JSON: ${asErrorMessage(error)}`,
      );
    }
    if (!isHeader(header)) {
      throw new MessageValidationError("Invalid Object-content header");
    }
    const message: ObjectContentMessage = {
      type: "object-content",
      object_id: header.object_id,
      ...(header.content_type === undefined
        ? {}
        : { content_type: header.content_type }),
      content: bytes.slice(HEADER_LENGTH_BYTES + headerLength),
    };
    if (!this.validate(message)) {
      throw new MessageValidationError("Invalid Object-content message");
    }
    return message;
  },
  exercise: {
    defaultPayloadBytes: 1_024,
    maximumPayloadBytes: maximumExerciseContentBytes(),
    payloadPresets: [32, 4_096],
    create(payloadBytes: number): ObjectContentMessage {
      return {
        type: "object-content",
        object_id: takeExerciseId(),
        content_type: "application/octet-stream",
        content: new Uint8Array(payloadBytes).fill(0xa5),
      };
    },
    key(message): string {
      return message.object_id;
    },
    isComplete({ sent, received, side }): boolean {
      return (
        side === "destination" &&
        received.object_id === sent.object_id &&
        received.content_type === sent.content_type &&
        Buffer.from(received.content).equals(sent.content)
      );
    },
  },
} satisfies MessageDefinition<ObjectContentMessage>;

function maximumExerciseContentBytes(): number {
  const header = textEncoder.encode(
    JSON.stringify({
      object_id: "exercise-ffffffff",
      content_type: "application/octet-stream",
    }),
  );
  return FIELDLINK_MAX_MESSAGE_BYTES - HEADER_LENGTH_BYTES - header.length;
}

function exactKeys(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  return (
    keys.every((key) =>
      ["type", "object_id", "content_type", "content"].includes(key),
    ) &&
    ["type", "object_id", "content"].every((key) => Object.hasOwn(value, key))
  );
}

function isHeader(
  value: unknown,
): value is { readonly object_id: string; readonly content_type?: string } {
  return (
    isRecord(value) &&
    Object.keys(value).every((key) =>
      ["object_id", "content_type"].includes(key),
    ) &&
    isIdentifier(value.object_id) &&
    (value.content_type === undefined ||
      (typeof value.content_type === "string" &&
        value.content_type.length > 0 &&
        value.content_type.length <= MAX_CONTENT_TYPE_CHARACTERS))
  );
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_IDENTIFIER_CHARACTERS
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function takeExerciseId(): string {
  const value = nextExerciseId;
  nextExerciseId = (nextExerciseId + 1) % 0x1_0000_0000;
  return `exercise-${value.toString(16).padStart(8, "0")}`;
}

function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
