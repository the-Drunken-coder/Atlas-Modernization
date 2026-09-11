import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assertPluginCompatible,
  fetchBounded,
  type PluginCatalogRelease,
  type PluginReleaseCandidate,
  parsePluginRelease,
  parsePluginTrustConfiguration,
  selectPluginRelease,
  verifyCatalog
} from "../src/plugin-distribution.js";

const pluginId = "building_scan";
const releaseUrl = (version: string): string =>
  `https://github.com/the-Drunken-coder/Atlas-Modernization/releases/download/atlas-plugin-${pluginId}-v${version}/${pluginId}-${version}.atlas-plugin`;
const image = (digest: string): string => `ghcr.io/the-drunken-coder/atlas-building-scan@sha256:${digest}`;

function releaseDocument(version = "0.2.0"): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      schema: 1,
      plugin_id: pluginId,
      version,
      display_name: "Building Scan",
      lifecycle: "query_only",
      image: image("a".repeat(64)),
      core_to_plugin_protocol_major: 1,
      plugin_to_source_gateway_protocol_major: 1,
      atlas_protocol_revision: null,
      interactions: ["map_area"],
      source_connector: null
    })
  );
}

function catalogDocument(
  sequence: number,
  previousCatalogSha256: string | null,
  issuedAt = "2026-09-09T12:00:00Z",
  revoked = false
): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      schema: 1,
      sequence,
      previous_catalog_sha256: previousCatalogSha256,
      issued_at: issuedAt,
      expires_at: "2026-09-20T12:00:00Z",
      key_epoch: 1,
      key_id: "test-key",
      plugins: [
        {
          plugin_id: pluginId,
          releases: [
            {
              version: "0.2.0",
              display_name: "Building Scan",
              document_url: releaseUrl("0.2.0"),
              document_sha256: `sha256:${"b".repeat(64)}`,
              revoked,
              revocation_reason: revoked ? "security issue" : null
            }
          ]
        }
      ]
    })
  );
}

function signedCatalog(bytes: Uint8Array, privateKey: KeyObject): Uint8Array {
  const signature = sign(null, bytes, privateKey).toString("base64");
  return new TextEncoder().encode(JSON.stringify({ algorithm: "ed25519", key_id: "test-key", signature }));
}

function catalogRelease(version: string, revoked = false): PluginCatalogRelease {
  return {
    pluginId,
    version,
    displayName: "Building Scan",
    documentUrl: releaseUrl(version),
    documentSha256: `sha256:${"b".repeat(64)}`,
    revoked,
    revocationReason: revoked ? "withdrawn" : null
  };
}

function candidate(version: string, revoked = false): PluginReleaseCandidate {
  const release = parsePluginRelease(releaseDocument(version));
  return { release, catalog: catalogRelease(version, revoked) };
}

describe("plugin distribution", () => {
  it("parses the release document and retains the exact authenticated bytes", () => {
    const bytes = releaseDocument();
    const release = parsePluginRelease(bytes);

    expect(release.pluginId).toBe(pluginId);
    expect(release.version).toBe("0.2.0");
    expect([...release.bytes]).toEqual([...bytes]);
  });

  it("rejects duplicate keys, BOM, invalid UTF-8, trailing JSON, and unknown fields", () => {
    expect(() => parsePluginRelease(new TextEncoder().encode('{"schema":1,"schema":1}'))).toThrow(/duplicate/i);
    expect(() => parsePluginRelease(new Uint8Array([0xef, 0xbb, 0xbf, ...releaseDocument()]))).toThrow(/byte-order/i);
    expect(() => parsePluginRelease(new Uint8Array([0xc3, 0x28]))).toThrow(/UTF-8/i);
    expect(() =>
      parsePluginRelease(new TextEncoder().encode(`${new TextDecoder().decode(releaseDocument())} {}`))
    ).toThrow(/trailing/i);
    const object = JSON.parse(new TextDecoder().decode(releaseDocument())) as Record<string, unknown>;
    object.unexpected = true;
    expect(() => parsePluginRelease(new TextEncoder().encode(JSON.stringify(object)))).toThrow(/unknown|missing/i);
  });

  it("rejects unstable versions, non-first-party images, secret connector headers, and unsafe mutation retries", () => {
    const prerelease = new TextDecoder().decode(releaseDocument()).replace('"0.2.0"', '"0.2.0-beta.1"');
    expect(() => parsePluginRelease(new TextEncoder().encode(prerelease))).toThrow(/Semantic Version/i);
    const imageObject = JSON.parse(new TextDecoder().decode(releaseDocument())) as Record<string, unknown>;
    imageObject.image = "ghcr.io/elsewhere/image@sha256:" + "a".repeat(64);
    expect(() => parsePluginRelease(new TextEncoder().encode(JSON.stringify(imageObject)))).toThrow(/GHCR/i);
    const connectorObject = JSON.parse(new TextDecoder().decode(releaseDocument())) as Record<string, unknown>;
    connectorObject.source_connector = {
      id: pluginId,
      origin: "https://example.test",
      routes: [
        {
          method: "GET",
          path_prefix: "/",
          allowed_query_names: [],
          allowed_request_headers: [],
          allowed_response_headers: [],
          read_only: true,
          cache: { ttl_ms: 0 },
          retry: { max_retries: 0, statuses: [], failures: [], idempotency_header: "" }
        }
      ],
      secret_headers: { authorization: { environment: "TOKEN" } },
      egress: { allow_private: false, allow_loopback: false, allow_link_local: false },
      limits: {
        timeout_ms: 1000,
        max_request_bytes: 1000,
        max_response_bytes: 1000,
        max_concurrency: 1,
        max_header_count: 1,
        max_header_bytes: 1000
      },
      rate: { requests_per_second: 1 },
      circuit_breaker: { failures: 1, open_ms: 1000 }
    };
    expect(() => parsePluginRelease(new TextEncoder().encode(JSON.stringify(connectorObject)))).toThrow(
      /secret_headers|unknown|missing/i
    );
    (connectorObject.source_connector as { secret_headers: unknown }).secret_headers = {};
    expect(parsePluginRelease(new TextEncoder().encode(JSON.stringify(connectorObject))).sourceConnector?.id).toBe(
      pluginId
    );
    const route = (connectorObject.source_connector as { routes: Array<Record<string, unknown>> }).routes[0]!;
    route.method = "POST";
    route.read_only = false;
    route.retry = {
      max_retries: 1,
      statuses: [503],
      failures: ["upstream_timeout"],
      idempotency_header: "idempotency-key"
    };
    expect(() => parsePluginRelease(new TextEncoder().encode(JSON.stringify(connectorObject)))).toThrow(
      /allowed_request_headers/i
    );
    route.allowed_request_headers = ["idempotency-key"];
    expect(() => parsePluginRelease(new TextEncoder().encode(JSON.stringify(connectorObject)))).not.toThrow();
  });

  it("verifies an Ed25519 catalog and persists exact byte receipts", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const bytes = catalogDocument(1, null);
    const receipt = verifyCatalog(
      bytes,
      signedCatalog(bytes, privateKey),
      { keys: [{ keyId: "test-key", keyEpoch: 1, publicKey }], minimumCheckpoint: { keyEpoch: 1, sequence: 1 } },
      undefined,
      new Date("2026-09-09T12:01:00Z")
    );

    expect(receipt.catalogSha256).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(Buffer.from(receipt.catalogBytesBase64, "base64")).toEqual(Buffer.from(bytes));
    expect(receipt.catalog.plugins[0]?.releases[0]?.documentUrl).toBe(releaseUrl("0.2.0"));
  });

  it("parses trust configuration and fails closed when no signer is configured", () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const { publicKey: secondPublicKey } = generateKeyPairSync("ed25519");
    const secondPem = secondPublicKey.export({ type: "spki", format: "pem" }).toString();
    const configuration = parsePluginTrustConfiguration({
      schema: 1,
      catalog_url: "https://atlas.example/catalog.json",
      keys: [{ key_id: "test-key", key_epoch: 1, public_key_pem: pem, minimum_sequence: 1 }],
      minimum_checkpoint: { key_epoch: 1, sequence: 1 }
    });
    expect(configuration.catalogURL).toBe("https://atlas.example/catalog.json");
    expect(configuration.trust.keys).toHaveLength(1);
    expect(() =>
      parsePluginTrustConfiguration({
        schema: 1,
        catalog_url: "https://atlas.example/catalog.json",
        keys: [
          { key_id: "test-key", key_epoch: 1, public_key_pem: pem, minimum_sequence: 1 },
          { key_id: "test-key", key_epoch: 2, public_key_pem: secondPem, minimum_sequence: 1 }
        ],
        minimum_checkpoint: null
      })
    ).toThrow(/duplicate key/i);
    expect(() =>
      parsePluginTrustConfiguration({
        schema: 1,
        catalog_url: "https://atlas.example/catalog.json",
        keys: [
          { key_id: "test-key", key_epoch: 1, public_key_pem: pem, minimum_sequence: 1 },
          { key_id: "next-key", key_epoch: 1, public_key_pem: secondPem, minimum_sequence: 1 }
        ],
        minimum_checkpoint: null
      })
    ).toThrow(/duplicate epoch/i);
    expect(
      parsePluginTrustConfiguration({
        schema: 1,
        catalog_url: "https://atlas.example/catalog.json",
        keys: [],
        minimum_checkpoint: null
      }).trust.keys
    ).toHaveLength(0);
  });

  it("rejects duplicate catalog plugin, release, and connector route identities", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const trust = { keys: [{ keyId: "test-key", keyEpoch: 1, publicKey }] };
    const base = JSON.parse(new TextDecoder().decode(catalogDocument(1, null))) as {
      plugins: Array<{ plugin_id: string; releases: unknown[] }>;
    };
    base.plugins.push(base.plugins[0]!);
    const duplicatePlugin = new TextEncoder().encode(JSON.stringify(base));
    expect(() =>
      verifyCatalog(
        duplicatePlugin,
        signedCatalog(duplicatePlugin, privateKey),
        trust,
        undefined,
        new Date("2026-09-09T12:01:00Z")
      )
    ).toThrow(/duplicate Plugin/i);

    const releaseBase = JSON.parse(new TextDecoder().decode(catalogDocument(1, null))) as {
      plugins: Array<{ plugin_id: string; releases: unknown[] }>;
    };
    releaseBase.plugins[0]!.releases.push(releaseBase.plugins[0]!.releases[0]);
    const duplicateRelease = new TextEncoder().encode(JSON.stringify(releaseBase));
    expect(() =>
      verifyCatalog(
        duplicateRelease,
        signedCatalog(duplicateRelease, privateKey),
        trust,
        undefined,
        new Date("2026-09-09T12:01:00Z")
      )
    ).toThrow(/duplicate .*version/i);

    const connector = JSON.parse(new TextDecoder().decode(releaseDocument())) as {
      source_connector: Record<string, unknown> | null;
    };
    connector.source_connector = {
      id: pluginId,
      origin: "https://example.test",
      routes: [
        {
          method: "GET",
          path_prefix: "/",
          allowed_query_names: [],
          allowed_request_headers: [],
          allowed_response_headers: [],
          read_only: true,
          cache: { ttl_ms: 0 },
          retry: { max_retries: 0, statuses: [], failures: [], idempotency_header: "" }
        },
        {
          method: "GET",
          path_prefix: "/",
          allowed_query_names: [],
          allowed_request_headers: [],
          allowed_response_headers: [],
          read_only: true,
          cache: { ttl_ms: 0 },
          retry: { max_retries: 0, statuses: [], failures: [], idempotency_header: "" }
        }
      ],
      secret_headers: {},
      egress: { allow_private: false, allow_loopback: false, allow_link_local: false },
      limits: {
        timeout_ms: 1000,
        max_request_bytes: 1000,
        max_response_bytes: 1000,
        max_concurrency: 1,
        max_header_count: 1,
        max_header_bytes: 1000
      },
      rate: { requests_per_second: 1 },
      circuit_breaker: { failures: 1, open_ms: 1000 }
    };
    expect(() => parsePluginRelease(new TextEncoder().encode(JSON.stringify(connector)))).toThrow(/duplicated/i);
  });

  it("enforces signature, checkpoint, chain, timestamp, and expiry rules", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const trust = {
      keys: [{ keyId: "test-key", keyEpoch: 1, publicKey }],
      minimumCheckpoint: { keyEpoch: 1, sequence: 1 }
    };
    const firstBytes = catalogDocument(1, null);
    const first = verifyCatalog(
      firstBytes,
      signedCatalog(firstBytes, privateKey),
      trust,
      undefined,
      new Date("2026-09-09T12:01:00Z")
    );
    const secondBytes = catalogDocument(2, first.catalogSha256, "2026-09-10T12:00:00Z");
    const second = verifyCatalog(
      secondBytes,
      signedCatalog(secondBytes, privateKey),
      trust,
      first,
      new Date("2026-09-10T12:01:00Z")
    );
    expect(second.sequence).toBe(2);
    const skippedBytes = catalogDocument(4, `sha256:${"c".repeat(64)}`, "2026-09-11T12:00:00Z");
    expect(() =>
      verifyCatalog(
        skippedBytes,
        signedCatalog(skippedBytes, privateKey),
        trust,
        first,
        new Date("2026-09-11T12:01:00Z")
      )
    ).not.toThrow();
    expect(() =>
      verifyCatalog(secondBytes, signedCatalog(firstBytes, privateKey), trust, first, new Date("2026-09-10T12:01:00Z"))
    ).toThrow(/signature/i);
    expect(() =>
      verifyCatalog(
        secondBytes,
        signedCatalog(secondBytes, privateKey),
        { ...trust, minimumCheckpoint: { keyEpoch: 1, sequence: 3 } },
        first,
        new Date("2026-09-10T12:01:00Z")
      )
    ).toThrow(/checkpoint/i);
    const brokenChain = catalogDocument(2, `sha256:${"d".repeat(64)}`, "2026-09-10T12:00:00Z");
    expect(() =>
      verifyCatalog(brokenChain, signedCatalog(brokenChain, privateKey), trust, first, new Date("2026-09-10T12:01:00Z"))
    ).toThrow(/chain/i);
    const expired = new TextEncoder().encode(
      new TextDecoder().decode(firstBytes).replace("2026-09-20T12:00:00Z", "2026-09-09T12:00:30Z")
    );
    expect(() =>
      verifyCatalog(expired, signedCatalog(expired, privateKey), trust, undefined, new Date("2026-09-09T12:01:00Z"))
    ).toThrow(/expired/i);
  });

  it("preserves observed releases and one-way revocations across catalog updates", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const trust = {
      keys: [{ keyId: "test-key", keyEpoch: 1, publicKey }],
      minimumCheckpoint: { keyEpoch: 1, sequence: 1 }
    };
    const firstBytes = catalogDocument(1, null, "2026-09-09T12:00:00Z", true);
    const first = verifyCatalog(
      firstBytes,
      signedCatalog(firstBytes, privateKey),
      trust,
      undefined,
      new Date("2026-09-09T12:01:00Z")
    );

    const removed = JSON.parse(
      new TextDecoder().decode(catalogDocument(2, first.catalogSha256, "2026-09-10T12:00:00Z", true))
    ) as { plugins: unknown[] };
    removed.plugins = [];
    const removedBytes = new TextEncoder().encode(JSON.stringify(removed));
    expect(() =>
      verifyCatalog(
        removedBytes,
        signedCatalog(removedBytes, privateKey),
        trust,
        first,
        new Date("2026-09-10T12:01:00Z")
      )
    ).toThrow(/removed/i);

    const unrevokedBytes = catalogDocument(2, first.catalogSha256, "2026-09-10T12:00:00Z", false);
    expect(() =>
      verifyCatalog(
        unrevokedBytes,
        signedCatalog(unrevokedBytes, privateKey),
        trust,
        first,
        new Date("2026-09-10T12:01:00Z")
      )
    ).toThrow(/unrevoked/i);
  });

  it("selects the greatest permitted stable release and remediates revocation", () => {
    expect(
      selectPluginRelease([candidate("0.1.0"), candidate("0.3.0"), candidate("0.2.0")], "0.1.0")?.release.version
    ).toBe("0.3.0");
    expect(
      selectPluginRelease([candidate("0.1.0"), candidate("0.2.0", true)], "0.2.0", { remediateRevoked: true })?.release
        .version
    ).toBe("0.1.0");
    expect(selectPluginRelease([candidate("0.2.0", true)], "0.2.0", { remediateRevoked: true })).toBeUndefined();
  });

  it("checks private protocol and package compatibility", () => {
    const release = parsePluginRelease(releaseDocument());
    expect(() =>
      assertPluginCompatible(release, {
        coreToPluginProtocolMajors: [1],
        pluginToSourceGatewayProtocolMajors: [1],
        atlasProtocolRevision: null,
        supportedPackageSchemaMajors: [1],
        supportedInteractions: ["map_area"]
      })
    ).not.toThrow();
    expect(() =>
      assertPluginCompatible(release, {
        coreToPluginProtocolMajors: [2],
        pluginToSourceGatewayProtocolMajors: [1],
        atlasProtocolRevision: null
      })
    ).toThrow(/Core-to-Plugin/i);
  });

  it("bounds downloads and follows only allowlisted HTTPS redirects", async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (url) => {
      calls.push(String(url));
      if (calls.length === 1)
        return new Response(null, {
          status: 302,
          headers: { location: "https://objects.githubusercontent.com/release?X-Amz-Signature=signed" }
        });
      return new Response("ok", { status: 200 });
    };
    await expect(
      fetchBounded("https://github.com/release", {
        maxBytes: 10,
        allowedHosts: ["github.com", "objects.githubusercontent.com"],
        fetchImpl
      })
    ).resolves.toEqual(new TextEncoder().encode("ok"));
    expect(calls).toEqual([
      "https://github.com/release",
      "https://objects.githubusercontent.com/release?X-Amz-Signature=signed"
    ]);
    await expect(
      fetchBounded("https://github.com/release?unsigned=1", {
        maxBytes: 10,
        allowedHosts: ["github.com"],
        fetchImpl
      })
    ).rejects.toThrow(/allowlisted HTTPS URL/i);
    await expect(
      fetchBounded("https://github.com/release", {
        maxBytes: 1,
        allowedHosts: ["github.com"],
        fetchImpl: async () => new Response("too long")
      })
    ).rejects.toThrow(/size limit/i);
    await expect(
      fetchBounded("https://github.com/release", {
        maxBytes: 10,
        allowedHosts: ["github.com"],
        fetchImpl: async () =>
          new Response(null, { status: 302, headers: { location: "https://evil.example/release" } })
      })
    ).rejects.toThrow(/allowlisted/i);
  });

  it("aborts a stalled request or response body at the overall deadline", async () => {
    let signal: AbortSignal | undefined;
    await expect(
      fetchBounded("https://github.com/release", {
        maxBytes: 10,
        allowedHosts: ["github.com"],
        timeoutMs: 10,
        fetchImpl: async (_url, init) => {
          signal = init?.signal ?? undefined;
          return new Response(
            new ReadableStream<Uint8Array>({
              pull: () => new Promise<void>(() => {})
            }),
            { status: 200 }
          );
        }
      })
    ).rejects.toThrow(/timed out/i);
    expect(signal?.aborted).toBe(true);
  });
});
