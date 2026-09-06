import { createHash, randomBytes } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { AtlasClient } from "@the-drunken-coder/atlas-sdk";
import { describe, expect, it } from "vitest";
import { canonicalJSON } from "./canonical-json.js";
import {
  ATLAS_RADIO_OPERATIONS,
  deserializeLinkMessage,
  isLinkMessage,
  MAX_OBJECT_CONTENT_BYTES,
  messagePriority,
  serializeLinkMessage
} from "./contract.js";
import {
  DEFLATE_V2_DICTIONARY_SHA256,
  decodeFrame,
  type FrameIdentity,
  fragmentPayload,
  MAX_LINK_MESSAGE_BYTES
} from "./frame.js";
import { FRAME_DICTIONARY } from "./generated/radio-contract.generated.js";
import { positionPublication } from "./test-fixtures.js";

describe("generated Radio contract", () => {
  it.each(["deflate-v1", "deflate-v2", "deflate-v3"] as const)(
    "%s preserves a payload at the supported message-size boundary",
    (encoding) => {
      const payload = new Uint8Array(MAX_LINK_MESSAGE_BYTES);
      const frames = fragmentPayload(payload, frameIdentity(), 233, encoding);
      expect(Buffer.concat(frames.map((frame) => decodeFrame(frame).payload))).toEqual(Buffer.from(payload));
      expect(() => fragmentPayload(new Uint8Array(MAX_LINK_MESSAGE_BYTES + 1), frameIdentity(), 233, encoding)).toThrow(
        "Link payload exceeds 128 KiB"
      );
    }
  );

  it("matches the public Atlas SDK operation surface", () => {
    const client = new AtlasClient({
      baseUrl: "http://127.0.0.1:1",
      sync: false,
      fetch: async () => {
        throw new Error("operation discovery must not make requests");
      }
    });
    const families = {
      entity: client.entities,
      task: client.tasks,
      runtime: client.runtime,
      object: client.objects,
      query: client.queries,
      plugin: client.plugins
    };
    // Local watches and sync/feed lifecycle helpers are not remote operations.
    const operations = Object.entries(families).flatMap(([family, methods]) =>
      Object.keys(methods)
        .filter((method) => method !== "watch")
        .map((method) => `${family}.${method.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}`)
    );
    expect(typeof client.commandCatalog).toBe("function");
    operations.push("command_catalog.get");
    expect(Object.keys(ATLAS_RADIO_OPERATIONS)).toEqual(operations.sort());
  });

  it("serializes Atlas state as deterministic compact JSON", () => {
    const message = positionPublication(1);
    const decoded = deserializeLinkMessage(serializeLinkMessage(message));
    expect(canonicalJSON(decoded)).toBe(canonicalJSON(message));
    expect(new TextDecoder().decode(serializeLinkMessage(message))).not.toContain("\n");
  });

  it("fragments and reconstructs the exact production payload within Meshtastic limits", () => {
    const payload = serializeLinkMessage(positionPublication(1));
    const frames = fragmentPayload(payload, frameIdentity(), 233);
    expect(frames.length).toBeGreaterThan(1);
    expect(frames.every((frame) => frame.byteLength <= 233)).toBe(true);
    const chunks = frames.map(decodeFrame).sort((left, right) => left.chunk_index - right.chunk_index);
    expect(Buffer.concat(chunks.map((frame) => frame.payload))).toEqual(Buffer.from(payload));
  });

  it("round trips compressed Unicode and opaque fragments without changing Atlas semantics", () => {
    for (const payload of [
      serializeLinkMessage(positionPublication(1)),
      randomBytes(2048),
      Buffer.from("🚁 café ".repeat(300))
    ]) {
      const identity = { ...frameIdentity(), source_sequence: Number.MAX_SAFE_INTEGER, operation_id: "café\u0000🚁" };
      const frames = fragmentPayload(payload, identity, 200, "deflate-v1");
      expect(frames.every((frame) => frame.length <= 200)).toBe(true);
      const decoded = frames.map(decodeFrame);
      expect(Buffer.concat(decoded.map((frame) => frame.payload))).toEqual(Buffer.from(payload));
      for (const frame of decoded) expect(frame).toMatchObject(identity);
    }
  });

  it("round trips deflate-v2 fragments out of order without dropping identity fields", () => {
    const payload = randomBytes(2048);
    const identity: FrameIdentity = {
      ...frameIdentity(),
      destination: { role: "gateway", id: "gateway-bravo" },
      source_generation: 7,
      service_session: "session-4f8e",
      source_sequence: 99,
      operation_id: "operation-9",
      message_id: "message-9",
      priority: "task"
    };
    const frames = fragmentPayload(payload, identity, 200, "deflate-v2");
    expect(frames.length).toBeGreaterThan(1);
    expect(frames.every((frame) => frame[0] === 0xa3 && frame.length <= 200)).toBe(true);
    const decoded = [...frames]
      .reverse()
      .map(decodeFrame)
      .sort((left, right) => left.chunk_index - right.chunk_index);
    expect(Buffer.concat(decoded.map((frame) => frame.payload))).toEqual(payload);
    for (const frame of decoded) expect(frame).toMatchObject(identity);
  });

  it("golden round trips a full identity and addressed Task report receipt in deflate-v3", () => {
    // The golden codec vector retains its original payload revision as the current contract evolves.
    const payload = Buffer.from(
      canonicalJSON({
        r: "sha256:0b5b718f08bd7241f3ebc8ab87654d0a180e8cb3ea6dc36dd4377cda6d027108",
        message: {
          type: "task_report",
          action: "complete",
          task_id: "task-1",
          runtime_id: "runtime-alpha",
          observation_time: "2026-09-02T12:00:00Z",
          body: { output: { surveyed: true } }
        }
      })
    );
    const identity: FrameIdentity = {
      ...frameIdentity(),
      message_type: "task_report",
      destination: { role: "gateway", id: "gateway-bravo" },
      source_generation: 7,
      service_session: "session-4f8e",
      source_sequence: 99,
      operation_id: "report-op",
      message_id: "report-msg",
      receipt: { operation_id: "confirmed-control-op", message_id: "inbound-task-message" },
      priority: "task"
    };
    const frame = fragmentPayload(payload, identity, 233, "deflate-v3")[0];
    expect(frame).toEqual(
      Buffer.from(
        "a4632c28614f6660e44db40207946e624e4146227fba553ad0ede58995ba49458965f93cd024a96b926691ca098927ddfc022e282bb7389d51045ef1eb42db07400522997949f9a57929baa018d5859689d5f062d2aa1ad6eab3426eb180db5440396871036415971695a55602139c15305a526b6bb1945c564a46064666ba0696ba06462186465606064014859a13ad601c882f9152a01598a56b088b6b2b9414590b2a5dac94a814e24ab500",
        "hex"
      )
    );
    if (!frame) throw new Error("Missing frame");
    const decoded = decodeFrame(frame);
    expect(decoded).toMatchObject(identity);
    expect(Buffer.from(decoded.payload)).toEqual(Buffer.from(payload));
  });

  it("fragments deflate-v3 reports without receipt metadata", () => {
    const payload = randomBytes(2048);
    const identity: FrameIdentity = {
      ...frameIdentity(),
      message_type: "task_report",
      destination: { role: "gateway", id: "gateway-bravo" }
    };
    const frames = fragmentPayload(payload, identity, 200, "deflate-v3");
    expect(frames.length).toBeGreaterThan(1);
    const decoded = frames.map(decodeFrame);
    expect(decoded.every((frame) => frame.receipt === undefined)).toBe(true);
    expect(Buffer.concat(decoded.map((frame) => frame.payload))).toEqual(payload);
  });

  it("rejects receipt metadata outside addressed single frame Task reports", () => {
    const payload = Buffer.from("report");
    const receipt = { operation_id: "operation-1", message_id: "message-1" };
    expect(() => fragmentPayload(payload, { ...frameIdentity(), receipt }, 233, "deflate-v3")).toThrow(
      "addressed task_report"
    );
    const report = {
      ...frameIdentity(),
      message_type: "task_report" as const,
      destination: { role: "gateway" as const, id: "gateway-bravo" },
      receipt
    };
    expect(() => fragmentPayload(payload, report, 233, "canonical-json")).toThrow("requires deflate-v3");
    expect(() => fragmentPayload(payload, report, 233, "deflate-v2")).toThrow("requires deflate-v3");
    expect(() =>
      fragmentPayload(
        payload,
        { ...report, receipt: { operation_id: " ", message_id: "message-1" } },
        233,
        "deflate-v3"
      )
    ).toThrow("non-empty");
    expect(() => fragmentPayload(randomBytes(1024), report, 233, "deflate-v3")).toThrow("requires a single frame");
  });

  it("rejects malformed deflate-v3 receipt flags, empty references, and oversized references", () => {
    const identity: FrameIdentity = {
      ...frameIdentity(),
      message_type: "task_report",
      destination: { role: "gateway", id: "gateway-bravo" },
      receipt: { operation_id: "operation-1", message_id: "message-1" }
    };
    const frame = fragmentPayload(Buffer.from("report"), identity, 233, "deflate-v3")[0];
    if (!frame) throw new Error("Missing frame");
    expect(() => decodeFrame(mutateV3Receipt(frame, (body, offset) => (body[offset] = 2)))).toThrow("receipt flag");
    expect(() =>
      decodeFrame(
        mutateV3Receipt(frame, (body, offset) => {
          const operationLength = body[offset + 1];
          if (operationLength === undefined) throw new Error("Malformed v3 test frame");
          body[offset + 1] = 0;
          body.copy(body, offset + 2, offset + 2 + operationLength);
        })
      )
    ).toThrow("Invalid Meshtastic Link frame");
    expect(() =>
      fragmentPayload(
        Buffer.from("report"),
        { ...identity, receipt: { operation_id: "x".repeat(65536), message_id: "message-1" } },
        233,
        "deflate-v3"
      )
    ).toThrow("receipt field is too large");
  });

  it("pins and decodes the deflate-v2 dictionary fixture", () => {
    expect(createHash("sha256").update(FRAME_DICTIONARY).digest("hex")).toBe(DEFLATE_V2_DICTIONARY_SHA256);
    const decoded = decodeFrame(
      Buffer.from(
        "a3634cce61646460e44db40207946e624e4146227fba553ad0ede58995ba49458965f9bcd0240991e586170aba969cd0824ed73203d8b2c90700",
        "hex"
      )
    );
    expect(decoded).toMatchObject({
      revision: 1,
      message_type: "control",
      source: { role: "asset", id: "asset-alpha" },
      destination: { role: "gateway", id: "gateway-bravo" },
      source_generation: 1,
      service_session: "session-alpha",
      source_sequence: 1,
      operation_id: "operation-9",
      message_id: "message-9",
      priority: "live_state",
      chunk_index: 0,
      chunk_count: 1
    });
    expect(Buffer.from(decoded.payload)).toEqual(Buffer.from("hello"));
  });

  it("keeps the deflate-v1 body byte-for-byte stable when selecting deflate-v2", () => {
    const payload = Buffer.from("hello");
    const v1 = fragmentPayload(payload, frameIdentity(), 200, "deflate-v1")[0];
    const v2 = fragmentPayload(payload, frameIdentity(), 200, "deflate-v2")[0];
    if (!v1 || !v2) throw new Error("Missing compressed frame");
    expect(v1[0]).toBe(0xa2);
    expect(v2[0]).toBe(0xa3);
    expect(v2.subarray(1)).toEqual(v1.subarray(9));
  });

  it("rejects an unknown dictionary and truncated compressed data", () => {
    const frame = fragmentPayload(Buffer.from("hello"), frameIdentity(), 200, "deflate-v1")[0];
    if (!frame) throw new Error("Missing frame");
    const unknown = Uint8Array.from(frame);
    unknown[1] = (unknown[1] ?? 0) ^ 1;
    expect(() => decodeFrame(unknown)).toThrow("Unknown compressed frame dictionary");
    expect(() => decodeFrame(frame.subarray(0, 10))).toThrow();
    expect(() => decodeFrame(Uint8Array.from([0xa4]))).toThrow();
    expect(() => decodeFrame(Uint8Array.from([0xa3]))).toThrow();
    expect(() => decodeFrame(new Uint8Array(234))).toThrow("exceeds 233 bytes");
  });

  it("finds a feasible fragment size across non-monotone envelope boundaries", () => {
    const frames = fragmentPayload(
      Uint8Array.from({ length: 11 }, (_, index) => index + 1),
      {
        ...frameIdentity(),
        source: { role: "asset", id: "a" },
        service_session: "s",
        operation_id: "oooo",
        message_id: "mmmmmmmmmmmm"
      },
      105
    );
    expect(frames).toHaveLength(6);
    expect(frames.map(decodeFrame).map((frame) => frame.payload.byteLength)).toEqual([2, 2, 2, 2, 2, 1]);
  });

  it("rejects malformed frame identities before transport fencing", () => {
    const invalid = encodeCanonicalFrame({ x: " " });
    expect(() => decodeFrame(invalid)).toThrow("Invalid Meshtastic Link frame");
    const missingSeparator = encodeCanonicalFrame({ s: "ax" });
    expect(() => decodeFrame(missingSeparator)).toThrow("Invalid Link node identity");
  });

  it("enforces the documented 32 KiB Object content limit", () => {
    const content = Buffer.alloc(MAX_OBJECT_CONTENT_BYTES);
    const accepted = {
      type: "object_content",
      request_id: "object-request-1",
      object_id: "object-1",
      content_base64: content.toString("base64"),
      sha256: `sha256:${createHash("sha256").update(content).digest("hex")}`
    } as const;
    expect(isLinkMessage(accepted)).toBe(true);
    expect(isLinkMessage({ ...accepted, request_id: undefined })).toBe(false);
    expect(
      isLinkMessage({ ...accepted, content_base64: Buffer.alloc(MAX_OBJECT_CONTENT_BYTES + 1).toString("base64") })
    ).toBe(false);
  });

  it("does not treat inherited object properties as message or operation names", () => {
    expect(isLinkMessage({ type: "toString" })).toBe(false);
    expect(isLinkMessage({ type: "data_response", request_id: "request", operation: "constructor" })).toBe(false);
  });

  it("prioritizes Task mutations with the Task delivery they control", () => {
    expect(
      messagePriority({
        type: "resource_operation",
        operation: "task.progress",
        target_id: "task-1",
        runtime_id: "runtime-1",
        input: { progress: 0.5 }
      })
    ).toBe("task");
    expect(
      messagePriority({
        type: "resource_operation",
        operation: "task.cancel",
        target_id: "task-1",
        input: { cancellation: { code: "requested", message: "return" } }
      })
    ).toBe("safety");
  });

  it("validates operation-specific inputs and addressing context", () => {
    const unidentifiedFieldState = { ...positionPublication(1) };
    delete unidentifiedFieldState.operation_id;
    expect(isLinkMessage(unidentifiedFieldState)).toBe(false);
    expect(
      isLinkMessage({
        type: "resource_operation",
        operation: "task.progress",
        target_id: "task-1",
        runtime_id: "runtime-1",
        input: { progress: 0.5 }
      })
    ).toBe(true);
    expect(
      isLinkMessage({
        type: "resource_operation",
        operation: "task.progress",
        target_id: "task-1",
        input: { progress: 2 }
      })
    ).toBe(false);
    expect(
      isLinkMessage({
        type: "data_request",
        request_id: "spatial-1",
        operation: "plugin.invoke_spatial",
        plugin_id: "maps",
        plugin_operation_id: "search",
        input: { west: -71.81, south: 42.2, east: -71.8, north: 42.21 }
      })
    ).toBe(true);
    const updated = positionPublication(2);
    expect(
      isLinkMessage({
        type: "data_response",
        request_id: "update-asset-alpha",
        operation: "entity.update",
        output: updated.resource
      })
    ).toBe(true);
  });

  it("rejects enum-shaped arrays and non-RFC3339 observation times", () => {
    const publication = positionPublication(1);
    expect(isLinkMessage({ ...publication, path: ["field"] })).toBe(false);
    expect(isLinkMessage({ ...publication, confirmation: ["awaiting_core"] })).toBe(false);
    expect(isLinkMessage({ ...publication, observation_time: "Jan 1 2024" })).toBe(false);
    expect(isLinkMessage({ ...publication, observation_time: "2024-02-30T12:00:00Z" })).toBe(false);
  });

  it("rejects non-plain objects instead of silently canonicalizing them", () => {
    expect(() => canonicalJSON(new Date("2026-09-02T12:00:00Z"))).toThrow("plain JSON objects");
    expect(() => canonicalJSON(new Map([["key", "value"]]))).toThrow("plain JSON objects");
  });

  it("does not invent Task deletion semantics", () => {
    const publication = {
      type: "state",
      resource_type: "task",
      resource: {
        asset_id: "asset-alpha",
        command: "atlas.survey",
        created_at: "2026-09-02T12:00:00Z",
        input: {},
        status: "pending",
        task_id: "task-1",
        updated_at: "2026-09-02T12:00:00Z"
      },
      observation_time: "2026-09-02T12:00:00Z",
      path: "gateway_feed",
      confirmation: "core_confirmed"
    } as const;
    expect(isLinkMessage(publication)).toBe(true);
    expect(isLinkMessage({ ...publication, deleted: true, atlas_version: 2 })).toBe(false);
  });

  it("carries versioned Entity deletion fences without a stale resource body", () => {
    expect(
      isLinkMessage({
        type: "state",
        resource_type: "entity",
        resource_id: "asset-alpha",
        deleted: true,
        atlas_version: 2,
        observation_time: "2026-09-02T12:00:02Z",
        path: "gateway_feed",
        confirmation: "core_confirmed"
      })
    ).toBe(true);
  });
});

function frameIdentity(): FrameIdentity {
  return {
    revision: 1,
    message_type: "state",
    source: { role: "asset", id: "asset-alpha" },
    source_generation: 1,
    service_session: "session-alpha",
    source_sequence: 1,
    operation_id: "position-1",
    message_id: "message-1",
    priority: "live_state"
  };
}

function encodeCanonicalFrame(overrides: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(
    canonicalJSON({
      v: 1,
      k: "s",
      s: "a:a",
      g: 1,
      x: "session",
      q: 1,
      o: "operation",
      m: "message",
      y: "l",
      i: 0,
      n: 1,
      p: "AQ",
      ...overrides
    })
  );
}

function mutateV3Receipt(frame: Uint8Array, mutate: (body: Buffer, receiptOffset: number) => void): Uint8Array {
  const body = inflateRawSync(frame.subarray(1), { dictionary: Buffer.from(FRAME_DICTIONARY) });
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let multiplier = 1;
    while (true) {
      const byte = body[offset++];
      if (byte === undefined) throw new Error("Malformed v3 test frame");
      value += (byte & 127) * multiplier;
      if (byte < 128) return value;
      multiplier *= 128;
    }
  };
  for (let index = 0; index < 7; index++) readVarint();
  for (let index = 0; index < 5; index++) {
    const length = readVarint();
    offset += length;
  }
  mutate(body, offset);
  return Buffer.concat([Buffer.from([0xa4]), deflateRawSync(body, { dictionary: Buffer.from(FRAME_DICTIONARY) })]);
}
