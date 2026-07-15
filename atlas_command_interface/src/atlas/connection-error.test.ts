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

  it("redacts a bare bearer token independently", () => {
    const sanitized = sanitizeConnectionError(new Error("Atlas request failed: Bearer bearer-secret"));

    expect(sanitized).not.toContain("bearer-secret");
    expect(sanitized).toContain("Bearer [redacted]");
  });

  it("redacts generic URL userinfo and encoded query parameter names", () => {
    const message =
      "postgres://db-user:db-password@example.test //url-user:url-password@example.test?api%5Fkey=encoded-secret&access%2Dtoken=encoded-token&client%5Fsecret=client-secret&client%2Dsecret=hyphen-secret&id%5Ftoken=id-token&session%2Dtoken=session-token&safe=value";
    const sanitized = sanitizeConnectionError(new Error(message));

    expect(sanitized).not.toContain("db-user:db-password");
    expect(sanitized).not.toContain("url-user:url-password");
    expect(sanitized).not.toContain("encoded-secret");
    expect(sanitized).not.toContain("encoded-token");
    expect(sanitized).not.toContain("client-secret");
    expect(sanitized).not.toContain("hyphen-secret");
    expect(sanitized).not.toContain("id-token");
    expect(sanitized).not.toContain("session-token");
    expect(sanitized).toContain("safe=value");
  });

  it("redacts escaped URL userinfo and signature query parameters", () => {
    const sanitized = sanitizeConnectionError(
      new Error(String.raw`Atlas request failed: https:\/\/url-user:url-password@example.test?safe=value&api-key=api-key-secret&signature=signature-secret`)
    );

    expect(sanitized).not.toContain("url-user:url-password");
    expect(sanitized).not.toContain("api-key-secret");
    expect(sanitized).not.toContain("signature-secret");
    expect(sanitized).toContain("safe=value");
  });

  it("redacts common and malformed credential query names", () => {
    const sanitized = sanitizeConnectionError(
      new Error(
        "Atlas request failed: https://core.test?safe=value&auth_token=auth-secret&key=key-secret&token%ZZ=malformed-secret&api%ZZkey=malformed-api-secret"
      )
    );

    expect(sanitized).toContain("safe=value");
    expect(sanitized).not.toContain("auth-secret");
    expect(sanitized).not.toContain("key-secret");
    expect(sanitized).not.toContain("malformed-secret");
    expect(sanitized).not.toContain("malformed-api-secret");
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

  it("redacts underscored token fields in prefixed structured error bodies", () => {
    const secrets = {
      id_token: "id-token-secret",
      session_token: "session-token-secret",
      client_token: "client-token-secret"
    };
    const sanitized = sanitizeConnectionError(new Error(`Atlas request failed: 500: ${JSON.stringify(secrets)}`));

    expect(sanitized).toContain("[redacted]");
    for (const secret of Object.values(secrets)) {
      expect(sanitized).not.toContain(secret);
    }
  });

  it("redacts authorization-shaped structured fields", () => {
    const sanitized = sanitizeConnectionError(new Error('Atlas request failed: {"authorization":"Basic dXNlcjpwYXNz","bearer_token":"structured-secret"}'));

    expect(sanitized).not.toContain("Basic dXNlcjpwYXNz");
    expect(sanitized).not.toContain("structured-secret");
    expect(sanitized).toContain("[redacted]");
  });

  it("redacts authorization-shaped query parameters", () => {
    const sanitized = sanitizeConnectionError(
      new Error("Atlas request failed: https://core.test?safe=value&authorization=basic-secret&bearer_token=query-secret")
    );

    expect(sanitized).not.toContain("basic-secret");
    expect(sanitized).not.toContain("query-secret");
    expect(sanitized).toContain("safe=value");
  });

  it("redacts prefixed key query parameters", () => {
    const sanitized = sanitizeConnectionError(new Error("Atlas request failed: https://core.test?x-api-key=prefixed-api-key-secret"));

    expect(sanitized).not.toContain("prefixed-api-key-secret");
  });

  it("redacts semicolon-delimited credential query parameters", () => {
    const sanitized = sanitizeConnectionError(new Error("Atlas request failed: https://core.test?safe=value;api_key=semicolon-secret"));

    expect(sanitized).toContain("safe=value");
    expect(sanitized).not.toContain("semicolon-secret");
  });

  it("redacts credential-shaped fields and query parameters", () => {
    const sanitized = sanitizeConnectionError(
      new Error('Atlas request failed: {"credentials":"structured-credential-secret"} https://core.test?X-Amz-Credential=query-credential-secret')
    );

    expect(sanitized).not.toContain("structured-credential-secret");
    expect(sanitized).not.toContain("query-credential-secret");
  });

  it("redacts nested encoded credential query parameters", () => {
    const sanitized = sanitizeConnectionError(
      new Error("Atlas request failed: https://core.test?credentials%5Bpassword%5D=nested-password&auth%5Bapi_key%5D=nested-api-key")
    );

    expect(sanitized).not.toContain("nested-password");
    expect(sanitized).not.toContain("nested-api-key");
  });

  it("redacts compound credential names in fields and query parameters", () => {
    const secrets = {
      csrf_field: "csrf-field-secret",
      db_password: "db-password-secret",
      csrf_query: "csrf-query-secret",
      db_query: "db-query-secret"
    };
    const sanitized = sanitizeConnectionError(
      new Error(
        `Atlas request failed: {"csrf_token":"${secrets.csrf_field}","db_password":"${secrets.db_password}"} https://core.test?safe=value&csrf_token=${secrets.csrf_query}&db_password=${secrets.db_query}`
      )
    );

    expect(sanitized).toContain("safe=value");
    for (const secret of Object.values(secrets)) {
      expect(sanitized).not.toContain(secret);
    }
  });

  it("preserves comma-delimited text after unquoted sensitive fields", () => {
    const sanitized = sanitizeConnectionError(new Error("Atlas request failed: token: token-value, requestId=request-123"));

    expect(sanitized).not.toContain("token-value");
    expect(sanitized).toContain("requestId=request-123");
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
