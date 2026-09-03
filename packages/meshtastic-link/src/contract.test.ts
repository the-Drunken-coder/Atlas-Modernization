import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJSON } from "./canonical-json.js";
import {
  ATLAS_RADIO_OPERATIONS,
  deserializeLinkMessage,
  isLinkMessage,
  MAX_OBJECT_CONTENT_BYTES,
  serializeLinkMessage
} from "./contract.js";
import { decodeFrame, type FrameIdentity, fragmentPayload } from "./frame.js";
import { positionPublication } from "./test-fixtures.js";

describe("generated Radio contract", () => {
  it("exposes every current Atlas operation family", () => {
    const operationNames = Object.keys(ATLAS_RADIO_OPERATIONS);
    expect(operationNames).toEqual([...operationNames].sort());
    expect(operationNames).toEqual(
      expect.arrayContaining([
        "entity.get",
        "entity.create",
        "task.get",
        "task.acknowledge",
        "object.get",
        "plugin.invoke_spatial"
      ])
    );
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
      object_id: "object-1",
      content_base64: content.toString("base64"),
      sha256: `sha256:${createHash("sha256").update(content).digest("hex")}`
    } as const;
    expect(isLinkMessage(accepted)).toBe(true);
    expect(
      isLinkMessage({ ...accepted, content_base64: Buffer.alloc(MAX_OBJECT_CONTENT_BYTES + 1).toString("base64") })
    ).toBe(false);
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
