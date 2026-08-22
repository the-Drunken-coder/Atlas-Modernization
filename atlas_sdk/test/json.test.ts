import { describe, expect, it } from "vitest";
import { stringifyAtlasJSON } from "../src/json.js";

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
});
