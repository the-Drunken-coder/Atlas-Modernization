import { describe, expect, it } from "vitest";
import { sanitizeConnectionError } from "./connection-error.js";

describe("sanitizeConnectionError", () => {
  it("redacts credentials, sensitive query parameters, and stack text", () => {
    const secret = "atlas_ak_super-secret.value";
    const message = `Atlas request failed: 401: authorization: Bearer ${secret}?api_key=${secret}\n    at sendRequest (client.ts:1:1)`;

    const sanitized = sanitizeConnectionError(new Error(message));

    expect(sanitized).not.toContain(secret);
    expect(sanitized).not.toContain("at sendRequest");
    expect(sanitized).toContain("[redacted]");
  });

  it("redacts client secrets, URL userinfo, and bare bearer tokens", () => {
    const message = "client_secret=client-secret https://user:password@example.com Bearer bearer-secret";
    const sanitized = sanitizeConnectionError(new Error(message));

    expect(sanitized).not.toContain("client-secret");
    expect(sanitized).not.toContain("user:password");
    expect(sanitized).not.toContain("bearer-secret");
    expect(sanitized).toContain("[redacted]");
  });

  it("redacts generic URL userinfo and encoded query parameter names", () => {
    const message =
      "postgres://db-user:db-password@example.test?api%5Fkey=encoded-secret&access%2Dtoken=encoded-token&client%5Fsecret=client-secret&client%2Dsecret=hyphen-secret&id%5Ftoken=id-token&session%2Dtoken=session-token&safe=value";
    const sanitized = sanitizeConnectionError(new Error(message));

    expect(sanitized).not.toContain("db-user:db-password");
    expect(sanitized).not.toContain("encoded-secret");
    expect(sanitized).not.toContain("encoded-token");
    expect(sanitized).not.toContain("client-secret");
    expect(sanitized).not.toContain("hyphen-secret");
    expect(sanitized).not.toContain("id-token");
    expect(sanitized).not.toContain("session-token");
    expect(sanitized).toContain("safe=value");
  });

  it("redacts quoted fields in prefixed structured error bodies", () => {
    const sanitized = sanitizeConnectionError(
      new Error('Atlas request failed: 500: {"client_secret":"secret-value","token":"token-value","message":"internal details"}')
    );

    expect(sanitized).not.toContain("secret-value");
    expect(sanitized).not.toContain("token-value");
    expect(sanitized).toContain("internal details");
    expect(sanitized).toContain("[redacted]");
  });

  it("redacts escaped structured fields", () => {
    const sanitized = sanitizeConnectionError(new Error('Atlas request failed: 500: {\\"api_key\\":\\"escaped-secret\\"}'));

    expect(sanitized).not.toContain("escaped-secret");
    expect(sanitized).toContain("[redacted]");
  });

  it("redacts escaped quotes inside structured secret values", () => {
    const sanitized = sanitizeConnectionError(new Error('Atlas request failed: 500: {"password":"not\\"a-secret-suffix"}'));

    expect(sanitized).not.toContain("a-secret-suffix");
    expect(sanitized).toContain("[redacted]");
  });

  it("does not display structured server bodies", () => {
    expect(sanitizeConnectionError(new Error('{"message":"internal details","api_key":"atlas_ak_secret"}'))).toBe(
      "Atlas Core returned an unsafe error message."
    );
  });

  it("bounds long messages", () => {
    expect(sanitizeConnectionError(new Error("network failure: " + "x".repeat(400)))).toHaveLength(240);
  });
});
