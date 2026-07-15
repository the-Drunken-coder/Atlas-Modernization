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

  it("fails closed when an error message cannot be read", () => {
    const error = new Error();
    Object.defineProperty(error, "message", {
      get() {
        throw new Error("message getter failed");
      }
    });

    expect(sanitizeConnectionError(error)).toBe("Atlas Core returned an unsafe error message.");
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

  it("fails closed on encoded and double-encoded URL credentials", () => {
    const cases = [
      {
        message: "Atlas request failed: https%3A%2F%2Fuser%3Aencoded-userinfo-secret%40example.test",
        secret: "encoded-userinfo-secret"
      },
      {
        message: "Atlas request failed: https%253A%252F%252Fcore.test%253Fapi_key%253Ddouble-encoded-secret",
        secret: "double-encoded-secret"
      },
      {
        message: `Atlas request failed: ${encodeURIComponent(encodeURIComponent(encodeURIComponent("https://user:triple-encoded-secret@example.test")))}`,
        secret: "triple-encoded-secret"
      }
    ];

    for (const { message, secret } of cases) {
      const sanitized = sanitizeConnectionError(new Error(message));

      expect(sanitized).toBe("Atlas Core returned an unsafe error message.");
      expect(sanitized).not.toContain(secret);
    }
  });

  it("detects encoded URL credentials after malformed percent text", () => {
    const secret = "malformed-prefix-userinfo-secret";
    const sanitized = sanitizeConnectionError(new Error(`Atlas request failed: bad%ZZ https%3A%2F%2Fuser%3A${secret}%40example.test`));

    expect(sanitized).toBe("Atlas Core returned an unsafe error message.");
    expect(sanitized).not.toContain(secret);
  });

  it("redacts credential parameters in URL fragments", () => {
    const sanitized = sanitizeConnectionError(
      new Error("Atlas request failed: https://app.test/callback#access%5Ftoken=fragment-access-secret&id_token=fragment-id-secret&state=visible")
    );

    expect(sanitized).not.toContain("fragment-access-secret");
    expect(sanitized).not.toContain("fragment-id-secret");
    expect(sanitized).toContain("state=visible");
  });

  it("redacts quoted query values and URL passwords containing at-signs", () => {
    const sanitized = sanitizeConnectionError(new Error('Atlas request failed: https://user:pa@ss@example.test?api%5Fkey="top secret"'));

    expect(sanitized).not.toContain("pa@ss");
    expect(sanitized).not.toContain("top secret");
  });

  it("redacts AWS-style query credentials", () => {
    const sanitized = sanitizeConnectionError(
      new Error("Atlas request failed: https://core.test?AWSAccessKeyId=aws-access-key-secret&AWSSecretAccessKey=aws-secret-access-key-secret")
    );

    expect(sanitized).not.toContain("aws-access-key-secret");
    expect(sanitized).not.toContain("aws-secret-access-key-secret");
  });

  it("redacts AWS-style structured credential fields", () => {
    const secrets = {
      accessKeyId: "structured-access-key-secret",
      secretAccessKey: "structured-secret-access-key-secret",
      privateKey: "structured-private-key-secret"
    };
    const sanitized = sanitizeConnectionError(new Error(`Atlas request failed: ${JSON.stringify(secrets)}`));

    expect(sanitized).toContain("[redacted]");
    for (const secret of Object.values(secrets)) {
      expect(sanitized).not.toContain(secret);
    }
  });

  it("handles long non-matching hyphen runs", () => {
    const sanitized = sanitizeConnectionError(new Error(`Atlas request failed: ${"-".repeat(1_900)}`));

    expect(sanitized).toHaveLength(240);
  }, 1_000);

  it("fails closed before truncating long credential-bearing errors", () => {
    const secret = "long-userinfo-secret";
    const sanitized = sanitizeConnectionError(new Error(`Atlas request failed: https://user:${secret}${"a".repeat(2_100)}@example.test`));

    expect(sanitized).toBe("Atlas Core returned an unsafe error message.");
    expect(sanitized).not.toContain(secret);
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

  it("fails closed on escaped structured credential keys", () => {
    const cases = [
      {
        message: String.raw`Atlas request failed: 500: {"api\u005fkey":"escaped-structured-secret","message":"safe context"}`,
        secret: "escaped-structured-secret"
      },
      {
        message: String.raw`Atlas request failed: 500: {"api\u005cu005fkey":"nested-unicode-secret","message":"safe context"}`,
        secret: "nested-unicode-secret"
      },
      {
        message: String.raw`Atlas request failed: 500: {"api\x5fkey":"hex-escaped-secret","message":"safe context"}`,
        secret: "hex-escaped-secret"
      },
      {
        message: String.raw`Atlas request failed: 500: {"api\u0025\u0035\u0066key":"mixed-encoding-secret","message":"safe context"}`,
        secret: "mixed-encoding-secret"
      }
    ];

    for (const { message, secret } of cases) {
      const sanitized = sanitizeConnectionError(new Error(message));

      expect(sanitized).toBe("Atlas Core returned an unsafe error message.");
      expect(sanitized).not.toContain(secret);
    }
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

  it("redacts session-shaped query credentials without matching ordinary words", () => {
    const secrets = ["session-secret", "session-id-secret", "atlas-session-secret"];
    const sanitized = sanitizeConnectionError(
      new Error(`Atlas request failed: https://core.test?session=${secrets[0]}&session_id=${secrets[1]}&atlas_session=${secrets[2]}&sessional=ordinary-value`)
    );

    for (const secret of secrets) expect(sanitized).not.toContain(secret);
    expect(sanitized).toContain("sessional=ordinary-value");
  });

  it("redacts session-shaped structured fields without matching ordinary words", () => {
    const secrets = {
      session: "structured-session-secret",
      session_id: "structured-session-id-secret",
      atlas_session: "structured-atlas-session-secret"
    };
    const sanitized = sanitizeConnectionError(new Error(`Atlas request failed: ${JSON.stringify({ ...secrets, sessional: "ordinary-value" })}`));

    for (const secret of Object.values(secrets)) expect(sanitized).not.toContain(secret);
    expect(sanitized).toContain("ordinary-value");
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

  it("redacts prefixed structured credential fields", () => {
    const sanitized = sanitizeConnectionError(
      new Error('Atlas request failed: {"oauth_token":"oauth-token-secret","x_amz_credential":"amz-credential-secret"}')
    );

    expect(sanitized).not.toContain("oauth-token-secret");
    expect(sanitized).not.toContain("amz-credential-secret");
  });

  it("redacts bracketed structured credential fields", () => {
    const sanitized = sanitizeConnectionError(
      new Error("Atlas request failed: credentials[password]=bracket-password-secret, credentials[api_key]: bracket-api-key-secret")
    );

    expect(sanitized).not.toContain("bracket-password-secret");
    expect(sanitized).not.toContain("bracket-api-key-secret");
  });

  it("redacts every element of sensitive structured collections", () => {
    const sanitized = sanitizeConnectionError(new Error('Atlas request failed: {"api_key":["key-one","key-two"],"requestId":"request-123"}'));

    expect(sanitized).not.toContain("key-one");
    expect(sanitized).not.toContain("key-two");
    expect(sanitized).toContain("requestId");
  });

  it("redacts bracketed collections containing embedded brackets and escapes", () => {
    const cases = [
      {
        message: 'Atlas request failed: {"api_key":["abc]def","second"]}',
        secrets: ["abc]def", "second"]
      },
      {
        message: String.raw`Atlas request failed: {"api_key":["escaped\"]bracket]secret","backslash\\]secret"]}`,
        secrets: ['escaped\\"]bracket]secret', "backslash\\\\]secret"]
      }
    ];

    for (const { message, secrets } of cases) {
      const sanitized = sanitizeConnectionError(new Error(message));

      for (const secret of secrets) {
        expect(sanitized).not.toContain(secret);
      }
      expect(sanitized).toContain("[redacted]");
    }
  });

  it("redacts nested object values in sensitive structured fields", () => {
    const messages = [
      'Atlas request failed: {"api_key":[{"safe":1},{"value":"nested-array-secret"}]}',
      'Atlas request failed: password: {"safe":1,"value":"nested-object-secret"}'
    ];

    for (const message of messages) {
      const sanitized = sanitizeConnectionError(new Error(message));

      expect(sanitized).not.toContain("nested-array-secret");
      expect(sanitized).not.toContain("nested-object-secret");
      expect(sanitized).toContain("[redacted]");
    }
  });

  it("redacts complete cookie header values", () => {
    const headers = ["Cookie: foo=bar; atlas_session=cookie-session-secret; theme=dark", "Set-Cookie: atlas_session=set-cookie-secret; Path=/; HttpOnly"];

    for (const header of headers) {
      const sanitized = sanitizeConnectionError(new Error(`Atlas request failed: ${header}`));

      expect(sanitized).toContain("[redacted]");
      expect(sanitized).not.toContain("foo=bar");
      expect(sanitized).not.toContain("cookie-session-secret");
      expect(sanitized).not.toContain("theme=dark");
      expect(sanitized).not.toContain("set-cookie-secret");
      expect(sanitized).not.toContain("Path=/");
      expect(sanitized).not.toContain("HttpOnly");
    }
  });

  it("redacts coalesced and array cookie header values", () => {
    const headers = [
      'Cookie: ["foo=bar","atlas_session=cookie-array-secret"]',
      'Set-Cookie: ["session=set-cookie-array-secret","theme=dark"]',
      'Cookie: ["foo=bar]suffix","atlas_session=cookie-bracket-secret"]',
      "Cookie: foo=bar, atlas_session=cookie-coalesced-secret",
      "Set-Cookie: session=set-cookie-coalesced-secret, theme=dark"
    ];

    for (const header of headers) {
      const sanitized = sanitizeConnectionError(new Error(`Atlas request failed: ${header}`));

      expect(sanitized).toContain("[redacted]");
      expect(sanitized).not.toContain("cookie-array-secret");
      expect(sanitized).not.toContain("set-cookie-array-secret");
      expect(sanitized).not.toContain("cookie-bracket-secret");
      expect(sanitized).not.toContain("cookie-coalesced-secret");
      expect(sanitized).not.toContain("set-cookie-coalesced-secret");
    }
  });

  it("redacts sensitive components in nested structured keys", () => {
    const sanitized = sanitizeConnectionError(
      new Error("Atlas request failed: headers[authorization]=Basic nested-basic-secret, auth[api_key]=nested-api-key-secret")
    );

    expect(sanitized).not.toContain("Basic nested-basic-secret");
    expect(sanitized).not.toContain("nested-api-key-secret");
    expect(sanitized).toContain("[redacted]");
  });

  it("stops at every JavaScript line separator", () => {
    for (const separator of ["\r", "\u2028", "\u2029"]) {
      expect(sanitizeConnectionError(new Error(`Atlas Core failed${separator}second line secret`))).toBe("Atlas Core failed");
    }
  });

  it("redacts URL userinfo with an empty username", () => {
    const sanitized = sanitizeConnectionError(new Error("Atlas request failed: https://:empty-user-password@core.example"));

    expect(sanitized).not.toContain("empty-user-password");
  });

  it("redacts URL userinfo before hosts with ports", () => {
    const sanitized = sanitizeConnectionError(new Error("Atlas request failed: https://user:port-password@example.test:8443/path"));

    expect(sanitized).not.toContain("user:port-password");
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
