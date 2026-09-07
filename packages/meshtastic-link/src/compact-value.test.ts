import { describe, expect, it } from "vitest";
import { encodeCanonicalJSON } from "./canonical-json.js";
import { decodeCompactValue, encodeCompactValue } from "./compact-value.js";

const goldenPayload = encodeCanonicalJSON({ foo: "bar", foo2: "bar" });
const goldenBytes = Uint8Array.from([
  0x01, 0x09, 0x02, 0x00, 0x03, 0x66, 0x6f, 0x6f, 0x07, 0x00, 0x03, 0x62, 0x61, 0x72, 0x00, 0x04, 0x66, 0x6f, 0x6f,
  0x32, 0x07, 0xda, 0x01
]);

describe("compact value v1", () => {
  it("keeps the frozen versioned golden vector stable", () => {
    expect(encodeCompactValue(goldenPayload)).toEqual(goldenBytes);
    expect(decodeCompactValue(goldenBytes)).toEqual(goldenPayload);
  });

  it("accepts only byte-exact canonical JSON", () => {
    const canonical = encodeCanonicalJSON({ a: 2, b: 1 });
    expect(encodeCompactValue(canonical)).toBeDefined();
    expect(encodeCompactValue(new TextEncoder().encode('{"b":1,"a":2}'))).toBeUndefined();
    expect(encodeCompactValue(new TextEncoder().encode('{"a":1,"a":1}'))).toBeUndefined();
    expect(encodeCompactValue(new TextEncoder().encode("-0"))).toBeUndefined();
  });

  it("returns canonical bytes even when a decoded object arrives in another key order", () => {
    const unsorted = Uint8Array.from([0x01, 0x09, 0x02, 0x00, 0x01, 0x7a, 0x00, 0x00, 0x01, 0x61, 0x00]);
    expect(decodeCompactValue(unsorted)).toEqual(encodeCanonicalJSON({ a: null, z: null }));
  });

  it("uses signed-magnitude integers and exact float32 values before float64 fallback", () => {
    for (const value of [0, 1, -1, 127, 128, -128, Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER]) {
      const payload = encodeCanonicalJSON(value);
      const encoded = encodeCompactValue(payload);
      if (!encoded) throw new Error(`Missing compact encoding for ${value}`);
      expect(decodeCompactValue(encoded)).toEqual(payload);
    }

    const exactFloat32 = encodeCompactValue(encodeCanonicalJSON(1.5));
    const float64Fallback = encodeCompactValue(encodeCanonicalJSON(0.1));
    if (!exactFloat32 || !float64Fallback) throw new Error("Missing floating-point compact encoding");
    expect(exactFloat32[1]).toBe(0x05);
    expect(float64Fallback[1]).toBe(0x06);
  });

  it("reuses pinned dictionaries, packs lowercase UUIDs, and preserves uppercase UUIDs literally", () => {
    const lowercase = "01234567-89ab-cdef-0123-456789abcdef";
    const uppercase = lowercase.toUpperCase();
    const payload = encodeCanonicalJSON({ id: lowercase, type: "task" });
    const encoded = encodeCompactValue(payload);
    const uppercasePayload = encodeCanonicalJSON({ id: uppercase, type: "task" });
    const uppercaseEncoded = encodeCompactValue(uppercasePayload);
    if (!encoded || !uppercaseEncoded) throw new Error("Missing UUID compact encoding");

    expect(decodeCompactValue(encoded)).toEqual(payload);
    expect(decodeCompactValue(uppercaseEncoded)).toEqual(uppercasePayload);
    expect(encoded.byteLength).toBeLessThan(uppercaseEncoded.byteLength);
  });

  it("rejects unknown, truncated, trailing, non-canonical, and unsafe value encodings", () => {
    expect(() => decodeCompactValue(Uint8Array.from([0x02]))).toThrow("version");
    expect(() => decodeCompactValue(Uint8Array.from([0x01]))).toThrow("Truncated");
    expect(() => decodeCompactValue(Uint8Array.from([0x01, 0xff]))).toThrow("Unknown compact value tag");
    expect(() => decodeCompactValue(Uint8Array.from([...goldenBytes, 0x00]))).toThrow("Trailing");
    expect(() => decodeCompactValue(Uint8Array.from([0x01, 0x09, 0x80, 0x00]))).toThrow("Non-canonical");
    expect(() => decodeCompactValue(Uint8Array.from([0x01, 0x04, 0x00]))).toThrow("zero magnitude");
    expect(() => decodeCompactValue(Uint8Array.from([0x01, 0x07, 0xd9, 0x01]))).toThrow("reference");
    expect(() => decodeCompactValue(Uint8Array.from([0x01, 0x09, 0x01, 0xa2, 0x01]))).toThrow();
    expect(() => decodeCompactValue(Uint8Array.from([0x01, 0x05, 0x00, 0x00, 0x80, 0x7f]))).toThrow("not finite");
  });

  it("rejects duplicate keys and safely reconstructs a proto-named key", () => {
    const duplicate = Uint8Array.from([0x01, 0x09, 0x02, 0x00, 0x01, 0x61, 0x00, 0x81, 0x01, 0x00]);
    expect(() => decodeCompactValue(duplicate)).toThrow("Duplicate");

    const payload = encodeCanonicalJSON({ ["__proto__"]: "safe", value: 1 });
    const encoded = encodeCompactValue(payload);
    if (!encoded) throw new Error("Missing proto-key compact encoding");
    expect(decodeCompactValue(encoded)).toEqual(payload);
  });

  it("enforces canonical output, depth, node, and input bounds", () => {
    const tooDeep = [0x01];
    for (let index = 0; index <= 64; index++) tooDeep.push(0x08, 0x01);
    tooDeep.push(0x00);
    expect(() => decodeCompactValue(Uint8Array.from(tooDeep))).toThrow("deep");

    const tooManyNodes = [0x01, 0x08, 0x80, 0x80, 0x04];
    tooManyNodes.push(...new Array(65_536).fill(0x00));
    expect(() => decodeCompactValue(Uint8Array.from(tooManyNodes))).toThrow();

    const tooLargeOutput = [0x01, 0x08, 66, 0x07, 0x00, 0xd0, 0x0f];
    for (let index = 0; index < 2_000; index++) tooLargeOutput.push(0x61);
    for (let index = 1; index < 66; index++) tooLargeOutput.push(0x07, 0xd9, 0x01);
    expect(() => decodeCompactValue(Uint8Array.from(tooLargeOutput))).toThrow("128 KiB");
  });
});
