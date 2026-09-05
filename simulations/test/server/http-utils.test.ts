import { describe, expect, it } from "vitest";
import { hasLoopbackHost } from "../../src/server/http-utils.js";

describe("simulation HTTP host validation", () => {
  it.each([
    ["127.0.0.2:5180", true],
    ["[::ffff:127.0.0.1]:5180", true],
    ["[::ffff:7f00:1]:5180", true],
    ["[::ffff:127.0.0.2]:5180", true],
    ["[::ffff:192.0.2.1]:5180", false],
    ["192.168.0.1:5180", false],
    ["[::ffff:7f00:1", false],
    ["127.0.0.1:not-a-port", false]
  ] as const)("classifies Host %s as loopback=%s", (host, expected) => {
    expect(hasLoopbackHost(host)).toBe(expected);
  });

  it("rejects missing and malformed Host headers", () => {
    expect(hasLoopbackHost(undefined)).toBe(false);
    expect(hasLoopbackHost("not a host")).toBe(false);
  });
});
