import { describe, expect, it } from "vitest";
import { parseAtlasJSON, stringifyAtlasJSON } from "../src/json.js";

describe("parseAtlasJSON", () => {
  it.each([
    "9007199254740992",
    "9007199254740992.0",
    "18014398509481984",
    "100000000000000000000",
    "9.007199254740992e15"
  ])("accepts the exactly representable integer %s", (serialized) => {
    expect(parseAtlasJSON(serialized)).toBe(Number(serialized));
  });

  it.each([
    "9007199254740993",
    "9007199254740993.0",
    "18014398509481985",
    "99999999999999999999",
    "9.007199254740993e15"
  ])("rejects the lossy integer %s", (serialized) => {
    expect(() => parseAtlasJSON(serialized)).toThrow("integer that JavaScript cannot represent exactly");
  });

  it.each(["0.1", "1e-300"])("preserves the standard fractional-number policy for %s", (serialized) => {
    expect(parseAtlasJSON(serialized)).toBe(JSON.parse(serialized));
  });

  it.each(["1e-4000", "-1e-4000", "1e-400"])("rejects nonzero numbers that underflow to zero: %s", (serialized) => {
    expect(() => parseAtlasJSON(serialized)).toThrow("nonzero number outside the JavaScript range");
  });

  it.each(["0", "-0", "0.0", "0e-4000", "-0.0e-4000"])("preserves zero-valued number %s", (serialized) => {
    expect(parseAtlasJSON(serialized)).toBe(JSON.parse(serialized));
  });
});

describe("stringifyAtlasJSON", () => {
  it("serializes ordinary objects that spoof a Number tag", () => {
    const spoofedNumber = { label: "ordinary", [Symbol.toStringTag]: "Number" };

    expect(stringifyAtlasJSON({ nested: spoofedNumber })).toBe('{"nested":{"label":"ordinary"}}');
  });

  it.each([
    [
      "Symbol.toPrimitive",
      () => {
        const value = new Number(1);
        value[Symbol.toPrimitive] = () => Number.POSITIVE_INFINITY;
        return value;
      }
    ],
    [
      "valueOf",
      () => {
        const value = new Number(1);
        value.valueOf = () => Number.NaN;
        return value;
      }
    ]
  ])("rejects a Number wrapper with non-finite %s coercion", (_name, createValue) => {
    expect(() => stringifyAtlasJSON({ nested: createValue() })).toThrow("number outside the JavaScript range");
  });

  it("emits the same Number-wrapper coercion that it validates", () => {
    const value = new Number(1);
    let coercions = 0;
    value[Symbol.toPrimitive] = () => (++coercions === 1 ? 7 : Number.POSITIVE_INFINITY);

    expect(stringifyAtlasJSON({ nested: value })).toBe('{"nested":7}');
    expect(coercions).toBe(1);
  });

  it.each([2 ** 53, 2 ** 54, 1e20])("serializes exactly representable large integer %s", (value) => {
    expect(stringifyAtlasJSON({ primitive: value, boxed: new Number(value) })).toBe(
      `{"primitive":${value},"boxed":${value}}`
    );
  });
});
