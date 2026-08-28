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
const MAX_IDENTIFIER_CHARACTERS = 100;
const MAX_CACHED_REQUESTS = 64;
let nextExerciseRequestId = randomInt(0x1_0000_0000);

/** Broad Task state synchronization and explicit Atlas lifecycle actions. */
export type TaskMessage =
  | {
      readonly type: "task";
      readonly kind: "state";
      readonly task: JsonObject;
    }
  | {
      readonly type: "task";
      readonly kind: "request";
      readonly operation: "sync";
      readonly request_id: string;
      readonly asset_id: string;
      readonly runtime_id: string;
    }
  | {
      readonly type: "task";
      readonly kind: "request";
      readonly operation: "acknowledge" | "start";
      readonly request_id: string;
      readonly asset_id: string;
      readonly task_id: string;
      readonly runtime_id: string;
    }
  | {
      readonly type: "task";
      readonly kind: "request";
      readonly operation: "progress";
      readonly request_id: string;
      readonly asset_id: string;
      readonly task_id: string;
      readonly runtime_id: string;
      readonly body: { readonly progress: number };
    }
  | {
      readonly type: "task";
      readonly kind: "request";
      readonly operation: "complete";
      readonly request_id: string;
      readonly asset_id: string;
      readonly task_id: string;
      readonly runtime_id: string;
      readonly body?: { readonly output?: JsonValue };
    }
  | {
      readonly type: "task";
      readonly kind: "request";
      readonly operation: "fail";
      readonly request_id: string;
      readonly asset_id: string;
      readonly task_id: string;
      readonly runtime_id: string;
      readonly body: {
        readonly failure: {
          readonly code: string;
          readonly message: string;
        };
      };
    }
  | {
      readonly type: "task";
      readonly kind: "response";
      readonly request_id: string;
      readonly status: number;
      readonly body?: JsonValue;
    };

export type TaskRequest = Extract<TaskMessage, { kind: "request" }>;
export type TaskResponse = Extract<TaskMessage, { kind: "response" }>;
export type TaskState = Extract<TaskMessage, { kind: "state" }>;

export interface TaskRequestExecutor {
  execute(request: TaskRequest, signal?: AbortSignal): Promise<TaskResponse>;
}

const exerciseEnvelopeBytes = textEncoder.encode(
  JSON.stringify({
    type: "task",
    kind: "response",
    request_id: "exercise-00000000",
    status: 200,
    body: "",
  } satisfies TaskMessage),
).length;

export const taskMessage = {
  id: 4,
  name: "task",
  defaultPriority: "high",
  examples: [
    {
      type: "task",
      kind: "state",
      task: {
        task_id: "task-1",
        asset_id: "asset-1",
        command: "survey.search",
        input: {},
        status: "pending",
        metadata: { version: 1 },
      },
    },
    {
      type: "task",
      kind: "request",
      operation: "sync",
      request_id: "req-sync-tasks",
      asset_id: "asset-1",
      runtime_id: "runtime-1",
    },
    {
      type: "task",
      kind: "request",
      operation: "acknowledge",
      request_id: "req-acknowledge-task",
      asset_id: "asset-1",
      task_id: "task-1",
      runtime_id: "runtime-1",
    },
    {
      type: "task",
      kind: "request",
      operation: "progress",
      request_id: "req-progress-task",
      asset_id: "asset-1",
      task_id: "task-1",
      runtime_id: "runtime-1",
      body: { progress: 0.5 },
    },
    {
      type: "task",
      kind: "request",
      operation: "complete",
      request_id: "req-complete-task",
      asset_id: "asset-1",
      task_id: "task-1",
      runtime_id: "runtime-1",
      body: { output: { objects: ["object-1"] } },
    },
    {
      type: "task",
      kind: "request",
      operation: "fail",
      request_id: "req-fail-task",
      asset_id: "asset-1",
      task_id: "task-1",
      runtime_id: "runtime-1",
      body: {
        failure: { code: "execution_failed", message: "camera unavailable" },
      },
    },
    {
      type: "task",
      kind: "response",
      request_id: "req-acknowledge-task",
      status: 200,
      body: { task_id: "task-1", status: "acknowledged" },
    },
  ],
  validate(value: unknown): value is TaskMessage {
    if (!isPlainRecord(value) || value.type !== "task") {
      return false;
    }
    if (value.kind === "state") {
      return hasShape(value, ["type", "kind", "task"]) && isTask(value.task);
    }
    if (value.kind === "response") {
      return isResponse(value);
    }
    if (
      value.kind !== "request" ||
      !isRequestId(value.request_id) ||
      typeof value.operation !== "string"
    ) {
      return false;
    }
    switch (value.operation) {
      case "sync":
        return (
          hasShape(value, [
            "type",
            "kind",
            "operation",
            "request_id",
            "asset_id",
            "runtime_id",
          ]) &&
          isIdentifier(value.asset_id) &&
          isIdentifier(value.runtime_id)
        );
      case "acknowledge":
      case "start":
        return isLifecycleBase(value, false);
      case "progress":
        return (
          isLifecycleBase(value, true) &&
          isPlainRecord(value.body) &&
          hasShape(value.body, ["progress"]) &&
          isFiniteNumber(value.body.progress) &&
          value.body.progress >= 0 &&
          value.body.progress <= 1
        );
      case "complete":
        return (
          isLifecycleBase(value, Object.hasOwn(value, "body")) &&
          (!Object.hasOwn(value, "body") ||
            (isPlainRecord(value.body) &&
              hasShape(value.body, [], ["output"]) &&
              (!Object.hasOwn(value.body, "output") ||
                isJsonValue(value.body.output))))
        );
      case "fail":
        return (
          isLifecycleBase(value, true) &&
          isPlainRecord(value.body) &&
          hasShape(value.body, ["failure"]) &&
          isPlainRecord(value.body.failure) &&
          hasShape(value.body.failure, ["code", "message"]) &&
          isIdentifier(value.body.failure.code) &&
          typeof value.body.failure.message === "string"
        );
      default:
        return false;
    }
  },
  encode(message: TaskMessage): Uint8Array {
    if (!this.validate(message)) {
      throw new MessageValidationError("Invalid Task message");
    }
    const encoded = textEncoder.encode(JSON.stringify(message));
    if (encoded.length > FIELDLINK_MAX_MESSAGE_BYTES) {
      throw new MessageValidationError(
        `Task message exceeds ${FIELDLINK_MAX_MESSAGE_BYTES} encoded bytes`,
      );
    }
    return encoded;
  },
  decode(bytes: Uint8Array): TaskMessage {
    if (bytes.length === 0 || bytes.length > FIELDLINK_MAX_MESSAGE_BYTES) {
      throw new MessageValidationError(
        `Task message must be 1 to ${FIELDLINK_MAX_MESSAGE_BYTES} bytes`,
      );
    }
    let value: unknown;
    try {
      value = JSON.parse(textDecoder.decode(bytes)) as unknown;
    } catch (error: unknown) {
      throw new MessageValidationError(
        `Task message is not valid UTF-8 JSON: ${asErrorMessage(error)}`,
      );
    }
    if (!this.validate(value)) {
      throw new MessageValidationError("Invalid Task message");
    }
    return value;
  },
  exercise: {
    defaultPayloadBytes: 32,
    maximumPayloadBytes: FIELDLINK_MAX_MESSAGE_BYTES - exerciseEnvelopeBytes,
    payloadPresets: [32, 4096],
    create(payloadBytes: number): TaskMessage {
      return {
        type: "task",
        kind: "response",
        request_id: takeExerciseRequestId(),
        status: 200,
        body: "x".repeat(payloadBytes),
      };
    },
    key(message): string {
      if (message.kind !== "state") {
        return message.request_id;
      }
      const taskId = message.task.task_id;
      return typeof taskId === "string" ? taskId : "";
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
        JSON.stringify(received) === JSON.stringify(sent)
      );
    },
  },
} satisfies MessageDefinition<TaskMessage>;

/** Executes Task requests from one preflight-approved radio. */
export function attachTaskRequestHandler(
  node: Pick<FieldLinkNode, "onMessage" | "send">,
  executor: TaskRequestExecutor,
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
      readonly response: Promise<TaskResponse>;
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
      message.type !== "task" ||
      message.kind !== "request"
    ) {
      return;
    }
    const key = `${received.source}:${message.request_id}`;
    const encodedRequest = JSON.stringify(message);
    const previous = cached.get(key);
    let response: Promise<TaskResponse> | undefined;
    if (previous !== undefined) {
      response =
        previous.encodedRequest === encodedRequest
          ? previous.response
          : Promise.resolve(conflict(message.request_id));
    } else {
      if (cached.size >= MAX_CACHED_REQUESTS) {
        const settled = [...cached].find(([cachedKey]) =>
          settledKeys.has(cachedKey),
        );
        if (settled === undefined) {
          response = Promise.resolve({
            type: "task",
            kind: "response",
            request_id: message.request_id,
            status: 503,
            body: { error: "Task request handler is at capacity" },
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
            type: "task" as const,
            kind: "response" as const,
            request_id: message.request_id,
            status: 500,
            body: { error: "Atlas Task request failed" },
          }))
          .finally(() => settledKeys.add(key));
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
    ownedController.abort(new Error("Task request handler disposed"));
    await Promise.allSettled(active);
  };
}

function isLifecycleBase(
  value: Record<string, unknown>,
  hasBody: boolean,
): boolean {
  return (
    hasShape(
      value,
      [
        "type",
        "kind",
        "operation",
        "request_id",
        "asset_id",
        "task_id",
        "runtime_id",
        ...(hasBody ? (["body"] as const) : []),
      ],
      hasBody ? [] : ["body"],
    ) &&
    (hasBody || !Object.hasOwn(value, "body")) &&
    isIdentifier(value.asset_id) &&
    isIdentifier(value.task_id) &&
    isIdentifier(value.runtime_id)
  );
}

function isTask(value: unknown): value is JsonObject {
  return (
    isPlainRecord(value) &&
    isJsonValue(value) &&
    isIdentifier(value.task_id) &&
    isIdentifier(value.asset_id) &&
    typeof value.status === "string" &&
    value.status.length > 0
  );
}

function isResponse(value: Record<string, unknown>): boolean {
  return (
    hasShape(value, ["type", "kind", "request_id", "status"], ["body"]) &&
    isRequestId(value.request_id) &&
    Number.isInteger(value.status) &&
    typeof value.status === "number" &&
    value.status >= 100 &&
    value.status <= 599 &&
    (!Object.hasOwn(value, "body") || isJsonValue(value.body))
  );
}

function conflict(requestId: string): TaskResponse {
  return {
    type: "task",
    kind: "response",
    request_id: requestId,
    status: 409,
    body: { error: "request_id was already used for different JSON" },
  };
}

function isActive(signal: AbortSignal): boolean {
  return !signal.aborted;
}

function hasShape(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function isRequestId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    textEncoder.encode(value).length <= MAX_REQUEST_ID_BYTES
  );
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_IDENTIFIER_CHARACTERS
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function takeExerciseRequestId(): string {
  const value = nextExerciseRequestId;
  nextExerciseRequestId = (nextExerciseRequestId + 1) % 0x1_0000_0000;
  return `exercise-${value.toString(16).padStart(8, "0")}`;
}

function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
