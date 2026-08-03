import { describe, expect, it } from "vitest";
import { sanitizeErrorMessage } from "../src/index.js";

describe("sanitizeErrorMessage", () => {
  it("removes secrets and terminal controls and bounds untrusted output", () => {
    const unsafe =
      "request failed at https://user:url-password@core.test?api_key=query-secret " +
      'authorization: "Basic basic-secret" Bearer bearer-secret atlas_ak_known-secret \u001b[31m' +
      "x".repeat(400) +
      "\nstack secret";

    const sanitized = sanitizeErrorMessage(new Error(unsafe));

    for (const secret of [
      "user:url-password",
      "query-secret",
      "basic-secret",
      "bearer-secret",
      "atlas_ak_known-secret",
      "stack secret"
    ]) {
      expect(sanitized).not.toContain(secret);
    }
    expect(sanitized).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(sanitized.length).toBeLessThanOrEqual(240);
    expect(sanitized).toContain("[redacted]");
  });
});
