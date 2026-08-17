import { describe, expect, it } from "vitest";
import { sanitizeErrorMessage } from "../src/index.js";

const CONNECTION_FALLBACK = "Atlas Core returned an unsafe error message.";
const sanitizeConnectionError = (cause: unknown) => sanitizeErrorMessage(cause, { fallback: CONNECTION_FALLBACK });

describe("sanitizeErrorMessage", () => {
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

  it("fails closed when an error message is not a string", () => {
    const error = new Error("placeholder");
    Object.defineProperty(error, "message", { value: 42 });

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
    const sanitized = sanitizeConnectionError(
      new Error(`Atlas request failed: bad%ZZ https%3A%2F%2Fuser%3A${secret}%40example.test`)
    );

    expect(sanitized).toBe("Atlas Core returned an unsafe error message.");
    expect(sanitized).not.toContain(secret);
  });

  it("redacts credential parameters in URL fragments", () => {
    const sanitized = sanitizeConnectionError(
      new Error(
        "Atlas request failed: https://app.test/callback#access%5Ftoken=fragment-access-secret&id_token=fragment-id-secret&state=visible"
      )
    );

    expect(sanitized).not.toContain("fragment-access-secret");
    expect(sanitized).not.toContain("fragment-id-secret");
    expect(sanitized).toContain("state=visible");
  });

  it("redacts quoted query values and URL passwords containing at-signs", () => {
    const sanitized = sanitizeConnectionError(
      new Error('Atlas request failed: https://user:pa@ss@example.test?api%5Fkey="top secret"')
    );

    expect(sanitized).not.toContain("pa@ss");
    expect(sanitized).not.toContain("top secret");
    expect(sanitized).toContain("[redacted]");
    expect(sanitized).toContain("Atlas request failed");
  });

  it("redacts AWS-style query credentials", () => {
    const sanitized = sanitizeConnectionError(
      new Error(
        "Atlas request failed: https://core.test?AWSAccessKeyId=aws-access-key-secret&AWSSecretAccessKey=aws-secret-access-key-secret"
      )
    );

    expect(sanitized).not.toContain("aws-access-key-secret");
    expect(sanitized).not.toContain("aws-secret-access-key-secret");
    expect(sanitized).toContain("[redacted]");
    expect(sanitized).toContain("Atlas request failed");
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

  it("redacts space-separated structured credential labels", () => {
    const secrets = ["access-key-label-secret", "session-label-secret"];
    const sanitized = sanitizeConnectionError(
      new Error(
        `Atlas request failed: {"Access Key ID":"${secrets[0]}","Session ID":"${secrets[1]}","message":"safe context"}`
      )
    );

    for (const secret of secrets) expect(sanitized).not.toContain(secret);
    expect(sanitized).toContain("safe context");
  });

  it("normalizes encoded structured credential names and fails closed on invalid encoding", () => {
    const sanitized = sanitizeConnectionError(
      new Error(
        "Atlas request failed: session+id=space-encoded-secret, %73ession_id=percent-encoded-secret, invalid%ZZ=malformed-name-secret"
      )
    );

    expect(sanitized).not.toContain("space-encoded-secret");
    expect(sanitized).not.toContain("percent-encoded-secret");
    expect(sanitized).not.toContain("malformed-name-secret");
    expect(sanitized).toContain("Atlas request failed");
    expect(sanitized).toContain("[redacted]");
  });

  it("redacts structured credential names with suffixes", () => {
    const secrets = ["password-hash-secret", "client-secret-value"];
    const sanitized = sanitizeConnectionError(
      new Error(
        `Atlas request failed: {"password_hash":"${secrets[0]}","client_secret_value":"${secrets[1]}","message":"safe context"}`
      )
    );

    for (const secret of secrets) expect(sanitized).not.toContain(secret);
    expect(sanitized).toContain("safe context");
  });

  it("redacts form-encoded and AWS credential names", () => {
    const secrets = ["plus-api-key-secret", "encoded-client-secret", "aws-access-key-secret"];
    const sanitized = sanitizeConnectionError(
      new Error(
        `Atlas request failed: https://core.test?api+key=${secrets[0]}&client%20secret=${secrets[1]}; {"AWSAccessKeyId":"${secrets[2]}","message":"safe context"}`
      )
    );

    for (const secret of secrets) expect(sanitized).not.toContain(secret);
    expect(sanitized).toContain("safe context");
  });

  it("redacts space-separated compound credential aliases", () => {
    const secrets = ["access-token-secret", "private-key-secret", "x-api-key-secret", "refresh-token-secret"];
    const sanitized = sanitizeConnectionError(
      new Error(
        `Atlas request failed: https://core.test?access+token=${secrets[0]}&private%20key=${secrets[1]}; {"X API Key":"${secrets[2]}","refresh token":"${secrets[3]}","message":"safe context"}`
      )
    );

    for (const secret of secrets) expect(sanitized).not.toContain(secret);
    expect(sanitized).toContain("safe context");
  });

  it("redacts bounded camel-case credential aliases", () => {
    const secrets = ["oauth-token-secret", "atlas-session-secret", "amz-credential-secret"];
    const sanitized = sanitizeConnectionError(
      new Error(
        `Atlas request failed: https://core.test?oauthToken=${secrets[0]}&atlasSession=${secrets[1]}; {"xAmzCredential":"${secrets[2]}","message":"safe context"}`
      )
    );

    for (const secret of secrets) expect(sanitized).not.toContain(secret);
    expect(sanitized).toContain("safe context");
  });

  it("redacts OAuth codes and SAML assertions", () => {
    const secrets = ["structured-oauth-code", "structured-saml-assertion", "query-oauth-code", "query-saml-assertion"];
    const sanitized = sanitizeConnectionError(
      new Error(
        `Atlas request failed: {"oauthCode":"${secrets[0]}","saml_assertion":"${secrets[1]}","requestId":"request-123"} https://core.test?oauth_code=${secrets[2]}&samlAssertion=${secrets[3]}&safe=visible`
      )
    );

    for (const secret of secrets) expect(sanitized).not.toContain(secret);
    expect(sanitized).toContain("request-123");
    expect(sanitized).toContain("safe=visible");
  });

  it("redacts OAuth and SAML wire parameters without hiding ordinary code fields", () => {
    const secrets = ["oauth-code-secret", "saml-response-secret"];

    const sanitized = sanitizeConnectionError(
      new Error(
        `Atlas request failed: {"code":"safe-context"} https://core.test?code=${secrets[0]}&SAMLResponse=${secrets[1]}&safe=visible`
      )
    );

    for (const secret of secrets) expect(sanitized).not.toContain(secret);
    expect(sanitized).toContain('"code":"safe-context"');
    expect(sanitized).toContain("safe=visible");
  });

  it("redacts structured camel-case credential fields", () => {
    const secrets = ["database-password-secret", "client-secret-value", "user-access-token-secret"];
    const sanitized = sanitizeConnectionError(
      new Error(
        `Atlas request failed: {"databasePassword":"${secrets[0]}","clientSecretValue":"${secrets[1]}","userAccessToken":"${secrets[2]}","message":"safe context"}`
      )
    );

    for (const secret of secrets) expect(sanitized).not.toContain(secret);
    expect(sanitized).toContain("[redacted]");
    expect(sanitized).toContain("safe context");
  });

  it("redacts credentials nested inside safe query values", () => {
    const secrets = ["nested-api-key-secret", "quoted-client-secret"];
    const sanitized = sanitizeConnectionError(
      new Error(
        `Atlas request failed: ?redirect=https://other.test/cb?api_key=${secrets[0]}&safe=visible&next="https://other.test/cb?client_secret=${secrets[1]}"`
      )
    );

    for (const secret of secrets) expect(sanitized).not.toContain(secret);
    expect(sanitized).toContain("redirect=https://other.test/cb");
    expect(sanitized).toContain("safe=visible");
  });

  it("redacts complete quoted credential values containing question marks", () => {
    const secrets = ["quoted-prefix-secret", "quoted-suffix-secret"];
    const sanitized = sanitizeConnectionError(
      new Error(`Atlas request failed: ?api_key="${secrets[0]}?${secrets[1]}"&safe=visible`)
    );

    for (const secret of secrets) expect(sanitized).not.toContain(secret);
    expect(sanitized).toContain("[redacted]");
    expect(sanitized).toContain("safe=visible");
  });

  it("redacts complete unquoted credential values containing question marks", () => {
    const secrets = ["unquoted-prefix-secret", "unquoted-suffix-secret"];
    const sanitized = sanitizeConnectionError(
      new Error(`Atlas request failed: ?api_key=${secrets[0]}?${secrets[1]}&safe=visible`)
    );

    for (const secret of secrets) expect(sanitized).not.toContain(secret);
    expect(sanitized).toContain("[redacted]");
    expect(sanitized).toContain("safe=visible");
  });

  it("redacts complete unquoted credential values containing spaces", () => {
    const secrets = ["spaced-prefix-secret", "spaced-suffix-secret"];
    const sanitized = sanitizeConnectionError(
      new Error(`Atlas request failed: ?api_key=${secrets[0]} ${secrets[1]}&safe=visible`)
    );

    for (const secret of secrets) expect(sanitized).not.toContain(secret);
    expect(sanitized).toContain("[redacted]");
    expect(sanitized).toContain("safe=visible");
  });

  it("redacts userinfo in repeatedly escaped URLs", () => {
    const secret = "repeatedly-escaped-password-secret";
    const sanitized = sanitizeConnectionError(
      new Error(String.raw`Atlas request failed: https:\\/\\/escaped-user:${secret}@example.test/path`)
    );

    expect(sanitized).not.toContain("escaped-user");
    expect(sanitized).not.toContain(secret);
    expect(sanitized).toContain("[redacted]@");
    expect(sanitized).toContain("example.test/path");
  });

  it("handles long non-matching hyphen runs", () => {
    const sanitized = sanitizeConnectionError(new Error(`Atlas request failed: ${"-".repeat(1_900)}`));

    expect(sanitized).toHaveLength(240);
  }, 1_000);

  it("handles unterminated quote-heavy sensitive collections", () => {
    const sanitized = sanitizeConnectionError(new Error(`Atlas request failed: api_key: [${'"'.repeat(1_900)}`));

    expect(sanitized).toContain("api_key: [redacted]");
  }, 1_000);

  it("fails closed before truncating long credential-bearing errors", () => {
    const secret = "long-userinfo-secret";
    const sanitized = sanitizeConnectionError(
      new Error(`Atlas request failed: https://user:${secret}${"a".repeat(2_100)}@example.test`)
    );

    expect(sanitized).toBe("Atlas Core returned an unsafe error message.");
    expect(sanitized).not.toContain(secret);
  });

  it("redacts escaped URL userinfo and signature query parameters", () => {
    const sanitized = sanitizeConnectionError(
      new Error(
        String.raw`Atlas request failed: https:\/\/url-user:url-password@example.test?safe=value&api-key=api-key-secret&signature=signature-secret`
      )
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

  it("redacts JSESSIONID and camel-case API-key query aliases", () => {
    const sanitized = sanitizeConnectionError(
      new Error(
        "Atlas request failed: https://core.test?JSESSIONID=query-session-secret&xApiKey=camel-api-secret&xApiKeyboard=ordinary-value;jsessionid=path-session-secret"
      )
    );

    expect(sanitized).not.toContain("query-session-secret");
    expect(sanitized).not.toContain("camel-api-secret");
    expect(sanitized).not.toContain("path-session-secret");
    expect(sanitized).toContain("xApiKeyboard=ordinary-value");
  });

  it("redacts quoted fields in prefixed structured error bodies", () => {
    const sanitized = sanitizeConnectionError(
      new Error(
        'Atlas request failed: 500: {"client_secret":"secret-value","token":"token-value","message":"internal details"}'
      )
    );

    expect(sanitized).not.toContain("secret-value");
    expect(sanitized).not.toContain("token-value");
    expect(sanitized).toContain("internal details");
    expect(sanitized).toContain("[redacted]");
  });

  it("redacts structured fields without an escape prefix", () => {
    const secrets = ["json-password-secret", "plain-password-secret"];
    const sanitized = sanitizeConnectionError(
      new Error(`Atlas request failed: {"password":"${secrets[0]}"}, password: ${secrets[1]}, requestId: request-123`)
    );

    for (const secret of secrets) expect(sanitized).not.toContain(secret);
    expect(sanitized).toContain("request-123");
  });

  it("fails closed on escaped structured credential keys", () => {
    const cases = [
      {
        message: String.raw`Atlas request failed: 500: {"api\u005fkey":"escaped-structured-secret","message":"safe context"}`,
        secret: "escaped-structured-secret"
      },
      {
        message: String.raw`Atlas request failed: 500: {"auth\u{6f}rization":"braced-unicode-secret","message":"safe context"}`,
        secret: "braced-unicode-secret"
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
      new Error(
        `Atlas request failed: https://core.test?session=${secrets[0]}&session_id=${secrets[1]}&atlas_session=${secrets[2]}&sessional=ordinary-value`
      )
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
    const sanitized = sanitizeConnectionError(
      new Error(`Atlas request failed: ${JSON.stringify({ ...secrets, sessional: "ordinary-value" })}`)
    );

    for (const secret of Object.values(secrets)) expect(sanitized).not.toContain(secret);
    expect(sanitized).toContain("ordinary-value");
  });

  it("redacts authorization-shaped structured fields", () => {
    const sanitized = sanitizeConnectionError(
      new Error('Atlas request failed: {"authorization":"Basic dXNlcjpwYXNz","bearer_token":"structured-secret"}')
    );

    expect(sanitized).not.toContain("Basic dXNlcjpwYXNz");
    expect(sanitized).not.toContain("structured-secret");
    expect(sanitized).toContain("[redacted]");
  });

  it("redacts complete comma-delimited Digest authorization values", () => {
    const secrets = ["digest-user-secret", "digest-response-secret"];
    const sanitized = sanitizeConnectionError(
      new Error(
        `Atlas request failed: {"authorization": Digest username="${secrets[0]}", response="${secrets[1]}", algorithm=MD5} requestId=request-123`
      )
    );

    for (const secret of secrets) expect(sanitized).not.toContain(secret);
    expect(sanitized).toContain('"authorization": [redacted]}');
    expect(sanitized).toContain("requestId=request-123");
  });

  it("redacts authorization-shaped query parameters", () => {
    const sanitized = sanitizeConnectionError(
      new Error(
        "Atlas request failed: https://core.test?safe=value&authorization=basic-secret&bearer_token=query-secret"
      )
    );

    expect(sanitized).not.toContain("basic-secret");
    expect(sanitized).not.toContain("query-secret");
    expect(sanitized).toContain("safe=value");
  });

  it("redacts bare bearer fields and query parameters", () => {
    const sanitized = sanitizeConnectionError(
      new Error(
        'Atlas request failed: {"bearer":"structured-bearer-secret"} https://core.test?safe=value&bearer=query-bearer-secret'
      )
    );

    expect(sanitized).not.toContain("structured-bearer-secret");
    expect(sanitized).not.toContain("query-bearer-secret");
    expect(sanitized).toContain("safe=value");
  });

  it("redacts prefixed key query parameters", () => {
    const sanitized = sanitizeConnectionError(
      new Error("Atlas request failed: https://core.test?x-api-key=prefixed-api-key-secret")
    );

    expect(sanitized).not.toContain("prefixed-api-key-secret");
  });

  it("redacts semicolon-delimited credential query parameters", () => {
    const sanitized = sanitizeConnectionError(
      new Error("Atlas request failed: https://core.test?safe=value;api_key=semicolon-secret")
    );

    expect(sanitized).toContain("safe=value");
    expect(sanitized).not.toContain("semicolon-secret");
  });

  it("redacts complete semicolon-bearing credential values", () => {
    const messages = [
      "Atlas request failed: https://core.test?api_key=first-api-secret;second-api-secret&safe=visible",
      "Atlas request failed: https://core.test?password=first-password-secret;second-password-secret;safe=visible",
      "Atlas request failed: password: first-structured-secret;second-structured-secret"
    ];

    for (const message of messages) {
      const sanitized = sanitizeConnectionError(new Error(message));

      for (const secret of [
        "first-api-secret",
        "second-api-secret",
        "first-password-secret",
        "second-password-secret",
        "first-structured-secret",
        "second-structured-secret"
      ]) {
        expect(sanitized).not.toContain(secret);
      }
    }
  });

  it("redacts credential-shaped fields and query parameters", () => {
    const sanitized = sanitizeConnectionError(
      new Error(
        'Atlas request failed: {"credentials":"structured-credential-secret"} https://core.test?X-Amz-Credential=query-credential-secret'
      )
    );

    expect(sanitized).not.toContain("structured-credential-secret");
    expect(sanitized).not.toContain("query-credential-secret");
  });

  it("redacts structured password hashes", () => {
    const sanitized = sanitizeConnectionError(
      new Error('Atlas request failed: {"passwordHash":"password-hash-secret","requestId":"request-123"}')
    );

    expect(sanitized).not.toContain("password-hash-secret");
    expect(sanitized).toContain("requestId");
  });

  it("redacts prefixed camel-case credential names without matching ordinary fields", () => {
    const secrets = [
      "structured-api-secret",
      "structured-access-secret",
      "structured-auth-secret",
      "query-api-secret",
      "query-access-secret",
      "query-auth-secret"
    ];
    const sanitized = sanitizeConnectionError(
      new Error(
        `Atlas request failed: {"stripeApiKeyboard":"safe-field","stripeApiKey":"${secrets[0]}","githubAccessToken":"${secrets[1]}","proxyAuthorization":"Basic ${secrets[2]}"} https://core.test?stripeApiKeyboard=safe-query&stripeApiKey=${secrets[3]}&githubAccessToken=${secrets[4]}&proxyAuthorization=${secrets[5]}`
      )
    );

    for (const secret of secrets) expect(sanitized).not.toContain(secret);
    expect(sanitized).toContain("safe-field");
    expect(sanitized).toContain("safe-query");
  });

  it.each([
    ["stripeapikey", "STRIPEAPIKEY", "stripeapikeyboard"],
    ["stripepassword", "STRIPEPASSWORD", "stripepasswordhint"],
    ["vaultsecret", "VAULTSECRET", "vaultsecretary"],
    ["githubtoken", "GITHUBTOKEN", "githubtokenizer"]
  ])("redacts end-bounded delimiter-free credential alias %s", (lowerName, upperName, ordinaryName) => {
    const secrets = ["field-lower-secret", "field-upper-secret", "query-lower-secret", "query-upper-secret"];
    const sanitized = sanitizeConnectionError(
      new Error(
        `Atlas failed: {"${lowerName}":"${secrets[0]}","${upperName}":"${secrets[1]}","${ordinaryName}":"safe-field"} ?${lowerName}=${secrets[2]}&${upperName}=${secrets[3]}&${ordinaryName}=safe-query`
      )
    );

    for (const secret of secrets) expect(sanitized).not.toContain(secret);
    expect(sanitized).toContain("safe-field");
    expect(sanitized).toContain("safe-query");
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
      new Error(
        "Atlas request failed: credentials[password]=bracket-password-secret, credentials[api_key]: bracket-api-key-secret"
      )
    );

    expect(sanitized).not.toContain("bracket-password-secret");
    expect(sanitized).not.toContain("bracket-api-key-secret");
  });

  it("redacts every element of sensitive structured collections", () => {
    const sanitized = sanitizeConnectionError(
      new Error('Atlas request failed: {"api_key":["key-one","key-two"],"requestId":"request-123"}')
    );

    expect(sanitized).not.toContain("key-one");
    expect(sanitized).not.toContain("key-two");
    expect(sanitized).toContain("requestId");
  });

  it("redacts nested sensitive collections fail closed", () => {
    const sanitized = sanitizeConnectionError(
      new Error('Atlas request failed: {"api_key":[["first-secret"],"second-secret"],"requestId":"request-123"}')
    );

    expect(sanitized).not.toContain("first-secret");
    expect(sanitized).not.toContain("second-secret");
    expect(sanitized).toContain("[redacted]");
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
    const headers = [
      "Cookie: foo=bar; atlas_session=cookie-session-secret; theme=dark",
      "Set-Cookie: atlas_session=set-cookie-secret; Path=/; HttpOnly"
    ];

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
      'Set-Cookie: [["session=nested-cookie-secret"],"theme=dark"]',
      'Cookie: ["foo=bar]suffix","atlas_session=cookie-bracket-secret"]',
      "Cookie: foo=bar, atlas_session=cookie-coalesced-secret",
      "Set-Cookie: session=set-cookie-coalesced-secret, theme=dark"
    ];

    for (const header of headers) {
      const sanitized = sanitizeConnectionError(new Error(`Atlas request failed: ${header}`));

      expect(sanitized).toContain("[redacted]");
      expect(sanitized).not.toContain("cookie-array-secret");
      expect(sanitized).not.toContain("set-cookie-array-secret");
      expect(sanitized).not.toContain("nested-cookie-secret");
      expect(sanitized).not.toContain("cookie-bracket-secret");
      expect(sanitized).not.toContain("cookie-coalesced-secret");
      expect(sanitized).not.toContain("set-cookie-coalesced-secret");
    }
  });

  it("redacts sensitive components in nested structured keys", () => {
    const sanitized = sanitizeConnectionError(
      new Error(
        "Atlas request failed: headers[authorization]=Basic nested-basic-secret, auth[api_key]=nested-api-key-secret"
      )
    );

    expect(sanitized).not.toContain("Basic nested-basic-secret");
    expect(sanitized).not.toContain("nested-api-key-secret");
    expect(sanitized).toContain("[redacted]");
  });

  it("stops at every JavaScript line separator", () => {
    for (const separator of ["\r", "\u2028", "\u2029"]) {
      expect(sanitizeConnectionError(new Error(`Atlas Core failed${separator}second line secret`))).toBe(
        "Atlas Core failed"
      );
    }
  });

  it("redacts URL userinfo with an empty username", () => {
    const sanitized = sanitizeConnectionError(
      new Error("Atlas request failed: https://:empty-user-password@core.example")
    );

    expect(sanitized).not.toContain("empty-user-password");
  });

  it("redacts URL userinfo before hosts with ports", () => {
    const sanitized = sanitizeConnectionError(
      new Error("Atlas request failed: https://user:port-password@example.test:8443/path")
    );

    expect(sanitized).not.toContain("user:port-password");
  });

  it("redacts nested encoded credential query parameters", () => {
    const sanitized = sanitizeConnectionError(
      new Error(
        "Atlas request failed: https://core.test?credentials%5Bpassword%5D=nested-password&auth%5Bapi_key%5D=nested-api-key"
      )
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
    const sanitized = sanitizeConnectionError(
      new Error("Atlas request failed: token: token-value, requestId=request-123")
    );

    expect(sanitized).not.toContain("token-value");
    expect(sanitized).toContain("requestId=request-123");
  });

  it("redacts escaped structured fields", () => {
    const sanitized = sanitizeConnectionError(
      new Error('Atlas request failed: 500: {\\"api_key\\":\\"escaped-secret\\"}')
    );

    expect(sanitized).not.toContain("escaped-secret");
    expect(sanitized).toContain("[redacted]");
  });

  it("redacts escaped quotes inside structured secret values", () => {
    const sanitized = sanitizeConnectionError(
      new Error('Atlas request failed: 500: {"password":"not\\"a-secret-suffix"}')
    );

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
