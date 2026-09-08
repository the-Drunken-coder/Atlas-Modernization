import { createHash } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { encodeCanonicalJSON } from "./canonical-json.js";
import { deserializeLinkMessage, serializeLinkMessage } from "./contract.js";
import { decodeFrame, type FrameIdentity, fragmentPayload } from "./frame.js";
import { FRAME_DICTIONARY } from "./generated/radio-contract.generated.js";
import { decodeMessagePayload } from "./message-codec.js";
import { positionPublication } from "./test-fixtures.js";

const identity: FrameIdentity = {
  revision: 1,
  message_type: "state",
  source: { role: "asset", id: "alpha-\ud800" },
  source_generation: 2,
  service_session: "session-\udfff",
  source_sequence: 25,
  operation_id: "operation-25",
  message_id: "message-25",
  priority: "live_state"
};
const totalBytes = (frames: Uint8Array[]) => frames.reduce((sum, frame) => sum + frame.byteLength, 0);
const reassemble = (frames: Uint8Array[]) =>
  Buffer.concat(
    frames
      .map(decodeFrame)
      .sort((a, b) => a.chunk_index - b.chunk_index)
      .map((frame) => frame.payload)
  );
const largeData = {
  rows: Array.from({ length: 100 }, (_, index) => ({
    sensor_id: `sensor-${index}`,
    temperature: 20 + index / 10,
    measurement_unit: "degrees Celsius",
    observation_time: "2026-09-06T12:00:00Z",
    description: "The complete sensor observation without omitting any fields"
  }))
};
const largePayload = encodeCanonicalJSON(largeData);

describe("message-v1 framing", () => {
  it("reduces complete wire bytes and fragments by compressing before fragmentation", () => {
    const previous = fragmentPayload(largePayload, identity, 200, "binary-v1");
    const frames = fragmentPayload(largePayload, identity, 200, "message-v1");
    expect(frames.length).toBeGreaterThan(1);
    expect(frames.length).toBeLessThan(previous.length);
    expect(totalBytes(frames)).toBeLessThan(totalBytes(previous));
    expect(frames.every((frame) => frame[0] === 0xa6 && frame.byteLength <= 200)).toBe(true);
    for (const frame of frames.map(decodeFrame)) expect(frame).toMatchObject(identity);
    expect(Buffer.from(decodeMessagePayload(reassemble([...frames].reverse())))).toEqual(Buffer.from(largePayload));
  });

  it.each([214, 226, 227, 231, 233])("never increases framed bytes or count at the %i-byte radio limit", (limit) => {
    for (const payload of [
      serializeLinkMessage(positionPublication(1)),
      largePayload,
      Buffer.concat(Array.from({ length: 16 }, (_, i) => createHash("sha256").update(`incompressible-${i}`).digest()))
    ]) {
      const previous = fragmentPayload(payload, identity, limit, "binary-v1");
      const frames = fragmentPayload(payload, identity, limit, "message-v1");
      expect(frames.every((frame) => frame.byteLength <= limit)).toBe(true);
      expect(frames.length).toBeLessThanOrEqual(previous.length);
      expect(totalBytes(frames)).toBeLessThanOrEqual(totalBytes(previous));
      expect(Buffer.from(decodeMessagePayload(reassemble(frames)))).toEqual(Buffer.from(payload));
    }
  });

  it("reconstructs a complete validated Protocol message", () => {
    const message = positionPublication(1);
    message.resource.components = { custom_readings: largeData };
    const payload = serializeLinkMessage(message);
    const frames = fragmentPayload(payload, identity, 233, "message-v1");
    expect(frames[0]?.[0]).toBe(0xa6);
    expect(deserializeLinkMessage(reassemble(frames))).toEqual(message);
  });

  it("rejects missing payloads, trailing header bytes, and non-opaque header flags", () => {
    const frame = fragmentPayload(largePayload, identity, 200, "message-v1")[0];
    if (!frame || frame[0] !== 0xa6) throw new Error("Expected whole-message frame");
    const length = frame[1]!;
    expect(() => decodeFrame(frame.subarray(0, length + 2))).toThrow("Truncated message-v1");
    const header = inflateRawSync(frame.subarray(2, length + 2), { dictionary: Buffer.from(FRAME_DICTIONARY) });
    const altered = [Buffer.concat([header, Buffer.from([0])]), Buffer.from(header)];
    altered[1]![header.length - 1] = 0;
    for (const bytes of altered) {
      const packed = deflateRawSync(bytes, { dictionary: Buffer.from(FRAME_DICTIONARY) });
      expect(() => decodeFrame(Buffer.concat([Buffer.from([0xa6, packed.length]), packed, Buffer.from([1])]))).toThrow(
        "Invalid message-v1 header boundary or payload flag"
      );
    }
    expect(() =>
      decodeFrame(Buffer.concat([Buffer.from([0xa6, length + 1]), frame.subarray(2, length + 2), Buffer.from([0, 1])]))
    ).toThrow("Trailing message-v1 header bytes");
  });
});
