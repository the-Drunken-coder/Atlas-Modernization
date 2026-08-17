import { describe, expect, it } from "vitest";
import { sanitizeConnectionError } from "./connection-error.js";

describe("sanitizeConnectionError", () => {
  it("uses the Atlas Core fallback", () => {
    expect(sanitizeConnectionError({})).toBe("Atlas Core returned an unsafe error message.");
  });
});
