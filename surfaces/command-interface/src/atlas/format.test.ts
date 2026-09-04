import { describe, expect, it } from "vitest";
import { formatNumber, formatPercent, formatRelativeTime } from "./format.js";

describe("unavailable inspector values", () => {
  it("uses N/A for absent or invalid values", () => {
    expect(formatRelativeTime(undefined)).toBe("N/A");
    expect(formatRelativeTime("not-a-date")).toBe("N/A");
    expect(formatNumber(undefined)).toBe("N/A");
    expect(formatNumber(Number.NaN)).toBe("N/A");
    expect(formatPercent(undefined)).toBe("N/A");
    expect(formatPercent(Number.POSITIVE_INFINITY)).toBe("N/A");
  });
});
