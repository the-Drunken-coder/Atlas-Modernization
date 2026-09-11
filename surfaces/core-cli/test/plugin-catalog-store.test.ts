import { createHash, generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PluginCatalogStore } from "../src/plugin-catalog-store.js";
import { type PluginTrust, parsePluginRelease, parsePluginTrustConfiguration } from "../src/plugin-distribution.js";

const pluginId = "building_scan";
const releaseURLFor = (id: string, version: string): string =>
  `https://github.com/the-Drunken-coder/Atlas-Modernization/releases/download/atlas-plugin-${id}-v${version}/${id}-${version}.atlas-plugin`;
const releaseURL = (version: string): string => releaseURLFor(pluginId, version);
const releaseBytes = (version: string): Uint8Array =>
  new TextEncoder().encode(
    JSON.stringify({
      schema: 1,
      plugin_id: pluginId,
      version,
      display_name: "Building Scan",
      lifecycle: "query_only",
      image: `ghcr.io/the-drunken-coder/atlas-building-scan@sha256:${"a".repeat(64)}`,
      core_to_plugin_protocol_major: 1,
      plugin_to_source_gateway_protocol_major: 1,
      atlas_protocol_revision: null,
      interactions: ["map_area"],
      source_connector: null
    })
  );
function realDigest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function catalogBytes(
  sequence: number,
  previousCatalogSha256: string | null,
  releases: readonly { version: string; documentSha256: string; revoked?: boolean }[],
  issuedAt = "2026-09-01T12:00:00Z",
  expiresAt = "2026-09-20T12:00:00Z",
  keyEpoch = 1,
  keyId = "test-key"
): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      schema: 1,
      sequence,
      previous_catalog_sha256: previousCatalogSha256,
      issued_at: issuedAt,
      expires_at: expiresAt,
      key_epoch: keyEpoch,
      key_id: keyId,
      plugins: [
        {
          plugin_id: pluginId,
          releases: releases.map(({ version, documentSha256, revoked }) => ({
            version,
            display_name: "Building Scan",
            document_url: releaseURL(version),
            document_sha256: documentSha256,
            revoked: revoked ?? false,
            revocation_reason: revoked ? "withdrawn" : null
          }))
        }
      ]
    })
  );
}

function nearMaximumCatalogBytes(sequence: number, previousCatalogSha256: string | null, issuedAt: string): Uint8Array {
  const plugins = Array.from({ length: 7 }, (_, pluginIndex) => {
    const id = `plugin_${pluginIndex}`;
    return {
      plugin_id: id,
      releases: Array.from({ length: 256 }, (_, releaseIndex) => {
        const version = `1.${releaseIndex}.0`;
        return {
          version,
          display_name: `Plugin ${pluginIndex}`,
          document_url: releaseURLFor(id, version),
          document_sha256: `sha256:${"0".repeat(64)}`,
          revoked: true,
          revocation_reason: "x".repeat(2010)
        };
      })
    };
  });
  return new TextEncoder().encode(
    JSON.stringify({
      schema: 1,
      sequence,
      previous_catalog_sha256: previousCatalogSha256,
      issued_at: issuedAt,
      expires_at: "2026-09-20T12:00:00Z",
      key_epoch: 1,
      key_id: "test-key",
      plugins
    })
  );
}

function signatureBytes(bytes: Uint8Array, privateKey: KeyObject, keyId = "test-key"): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      algorithm: "ed25519",
      key_id: keyId,
      signature: sign(null, bytes, privateKey).toString("base64")
    })
  );
}

function trust(
  publicKey: KeyObject,
  minimumCheckpoint: { keyEpoch: number; sequence: number } = { keyEpoch: 1, sequence: 1 }
): PluginTrust {
  return { keys: [{ keyId: "test-key", keyEpoch: 1, publicKey }], minimumCheckpoint };
}

function trustKey(
  publicKey: KeyObject,
  keyId: string,
  keyEpoch: number,
  minimumCheckpoint: { keyEpoch: number; sequence: number } = { keyEpoch, sequence: 1 }
): PluginTrust {
  return { keys: [{ keyId, keyEpoch, publicKey }], minimumCheckpoint };
}

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("PluginCatalogStore", () => {
  it("persists a verified receipt and never falls back to a static catalog", async () => {
    const directory = mkdtempSync(join(tmpdir(), "atlas-catalog-store-"));
    directories.push(directory);
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const first = catalogBytes(1, null, []);
    const calls: string[] = [];
    const store = new PluginCatalogStore({
      configDir: directory,
      catalogURL: "https://catalog.example/catalog.json",
      trust: trust(publicKey),
      fetchImpl: async (url) => {
        calls.push(String(url));
        return new Response(String(url).endsWith(".sig") ? signatureBytes(first, privateKey) : first);
      },
      now: () => new Date("2026-09-02T12:00:00Z")
    });
    const receipt = await store.refresh();
    expect(receipt.sequence).toBe(1);
    expect(calls).toHaveLength(2);
    const state = JSON.parse(readFileSync(join(directory, "catalog-state.json"), "utf8")) as Record<string, unknown>;
    expect(state.catalog_bytes_base64).toBe(Buffer.from(first).toString("base64"));
    expect(state.observed_at).toBe("2026-09-02T12:00:00.000Z");

    const offline = new PluginCatalogStore({
      configDir: directory,
      catalogURL: "https://catalog.example/catalog.json",
      trust: trust(publicKey),
      fetchImpl: async () => {
        throw new Error("network must not be used by read");
      },
      now: () => new Date("2026-09-03T12:00:00Z")
    });
    expect(offline.read().catalogSha256).toBe(receipt.catalogSha256);
    await expect(offline.candidates("missing_plugin")).resolves.toEqual([]);
  });

  it.each(["network", "signature"])(
    "uses only an unexpired verified cache after a %s refresh failure",
    async (failure) => {
      const directory = mkdtempSync(join(tmpdir(), "atlas-catalog-store-"));
      directories.push(directory);
      const { publicKey, privateKey } = generateKeyPairSync("ed25519");
      const first = catalogBytes(1, null, []);
      let offline = false;
      let now = new Date("2026-09-02T12:00:00Z");
      const store = new PluginCatalogStore({
        configDir: directory,
        catalogURL: "https://catalog.example/catalog.json",
        trust: trust(publicKey),
        fetchImpl: async (url) => {
          if (offline && failure === "network") throw new Error("catalog unavailable");
          if (String(url).endsWith(".sig")) return new Response(offline ? "{}" : signatureBytes(first, privateKey));
          return new Response(first);
        },
        now: () => now
      });
      const accepted = await store.refresh();
      offline = true;
      await expect(store.refresh()).rejects.toThrow();
      expect((await store.refresh({ allowCachedOnFailure: true })).catalogSha256).toBe(accepted.catalogSha256);
      now = new Date("2026-09-21T12:00:00Z");
      await expect(store.refresh({ allowCachedOnFailure: true })).rejects.toThrow();
      expect(() => store.read()).toThrow(/expired/);
      rmSync(join(directory, "catalog-state.json"));
      await expect(store.refresh({ allowCachedOnFailure: true })).rejects.toThrow();
    }
  );

  it("inspects without writing a stale receipt over a later refresh", async () => {
    const directory = mkdtempSync(join(tmpdir(), "atlas-catalog-store-"));
    directories.push(directory);
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const first = catalogBytes(1, null, []);
    let current = first;
    let now = new Date("2026-09-02T12:00:00Z");
    const store = new PluginCatalogStore({
      configDir: directory,
      catalogURL: "https://catalog.example/catalog.json",
      trust: trust(publicKey),
      fetchImpl: async (url) =>
        new Response(String(url).endsWith(".sig") ? signatureBytes(current, privateKey) : current),
      now: () => now
    });
    await store.refresh();
    const stateBeforeInspect = readFileSync(join(directory, "catalog-state.json"));
    now = new Date("2026-09-03T12:00:00Z");
    const stale = store.inspect();
    expect(stale.sequence).toBe(1);
    expect(readFileSync(join(directory, "catalog-state.json"))).toEqual(stateBeforeInspect);

    current = catalogBytes(2, stale.catalogSha256, [], "2026-09-03T12:00:01Z");
    await store.refresh();
    expect(store.inspect().sequence).toBe(2);
    const state = JSON.parse(readFileSync(join(directory, "catalog-state.json"), "utf8")) as Record<string, unknown>;
    expect(state.sequence).toBe(2);
  });

  it("keeps the accepted high-water mark when a later refresh is invalid", async () => {
    const directory = mkdtempSync(join(tmpdir(), "atlas-catalog-store-"));
    directories.push(directory);
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const first = catalogBytes(1, null, []);
    let current = first;
    const fetchImpl: typeof fetch = async (url) =>
      new Response(String(url).endsWith(".sig") ? signatureBytes(current, privateKey) : current);
    const store = new PluginCatalogStore({
      configDir: directory,
      catalogURL: "https://catalog.example/catalog.json",
      trust: trust(publicKey),
      fetchImpl,
      now: () => new Date("2026-09-02T12:00:00Z")
    });
    const firstReceipt = await store.refresh();
    const second = catalogBytes(2, firstReceipt.catalogSha256, [], "2026-09-02T12:00:00Z");
    current = second;
    await store.refresh();
    const acceptedHash = store.read().catalogSha256;
    current = catalogBytes(2, firstReceipt.catalogSha256, [], "2026-09-03T12:00:00Z");
    await expect(store.refresh()).rejects.toThrow(/sequence|different|older|issue time/i);
    expect(store.read().catalogSha256).toBe(acceptedHash);
  });

  it("uses an authenticated old receipt as refresh history after the checkpoint advances", async () => {
    const directory = mkdtempSync(join(tmpdir(), "atlas-catalog-store-"));
    directories.push(directory);
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const first = catalogBytes(1, null, []);
    let current = first;
    const initial = new PluginCatalogStore({
      configDir: directory,
      catalogURL: "https://catalog.example/catalog.json",
      trust: trust(publicKey),
      fetchImpl: async (url) =>
        new Response(String(url).endsWith(".sig") ? signatureBytes(current, privateKey) : current),
      now: () => new Date("2026-09-02T12:00:00Z")
    });
    const firstReceipt = await initial.refresh();
    const upgradedTrust = trust(publicKey, { keyEpoch: 1, sequence: 2 });
    const upgraded = new PluginCatalogStore({
      configDir: directory,
      catalogURL: "https://catalog.example/catalog.json",
      trust: upgradedTrust,
      fetchImpl: async (url) =>
        new Response(String(url).endsWith(".sig") ? signatureBytes(current, privateKey) : current),
      now: () => new Date("2026-09-02T12:00:00Z")
    });
    expect(() => upgraded.read()).toThrow(/checkpoint/i);

    current = catalogBytes(2, firstReceipt.catalogSha256, [], "2026-09-02T12:00:01Z");
    await expect(upgraded.refresh()).resolves.toMatchObject({ sequence: 2 });
    expect(upgraded.read().sequence).toBe(2);

    const statePath = join(directory, "catalog-state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
    state.catalog_bytes_base64 = Buffer.from("tampered catalog bytes").toString("base64");
    writeFileSync(statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    expect(() => upgraded.read()).toThrow(/signature|receipt|invalid JSON/i);
  });

  it("refreshes through a retired signing key with a newer trusted epoch", async () => {
    const directory = mkdtempSync(join(tmpdir(), "atlas-catalog-store-"));
    directories.push(directory);
    const oldKeys = generateKeyPairSync("ed25519");
    const nextKeys = generateKeyPairSync("ed25519");
    const oldCatalog = catalogBytes(1, null, []);
    const oldStore = new PluginCatalogStore({
      configDir: directory,
      catalogURL: "https://catalog.example/catalog.json",
      trust: trust(oldKeys.publicKey),
      fetchImpl: async (url) =>
        new Response(String(url).endsWith(".sig") ? signatureBytes(oldCatalog, oldKeys.privateKey) : oldCatalog),
      now: () => new Date("2026-09-02T12:00:00Z")
    });
    const oldReceipt = await oldStore.refresh();
    const nextCatalog = catalogBytes(
      1,
      oldReceipt.catalogSha256,
      [],
      "2026-09-03T12:00:00Z",
      "2026-09-20T12:00:00Z",
      2,
      "next-key"
    );
    const calls: string[] = [];
    const upgraded = new PluginCatalogStore({
      configDir: directory,
      catalogURL: "https://catalog.example/catalog.json",
      trust: trustKey(nextKeys.publicKey, "next-key", 2),
      fetchImpl: async (url) => {
        calls.push(String(url));
        return new Response(
          String(url).endsWith(".sig") ? signatureBytes(nextCatalog, nextKeys.privateKey, "next-key") : nextCatalog
        );
      },
      now: () => new Date("2026-09-03T12:01:00Z")
    });

    await expect(upgraded.refresh()).resolves.toMatchObject({ keyEpoch: 2, keyId: "next-key", sequence: 1 });
    expect(calls).toEqual(["https://catalog.example/catalog.json", "https://catalog.example/catalog.json.sig"]);
    expect(upgraded.read()).toMatchObject({ keyEpoch: 2, keyId: "next-key", sequence: 1 });
  });

  it("never accepts a retired-key catalog while recovering a retired receipt", async () => {
    const directory = mkdtempSync(join(tmpdir(), "atlas-catalog-store-"));
    directories.push(directory);
    const oldKeys = generateKeyPairSync("ed25519");
    const nextKeys = generateKeyPairSync("ed25519");
    const oldCatalog = catalogBytes(1, null, []);
    const oldStore = new PluginCatalogStore({
      configDir: directory,
      catalogURL: "https://catalog.example/catalog.json",
      trust: trust(oldKeys.publicKey),
      fetchImpl: async (url) =>
        new Response(String(url).endsWith(".sig") ? signatureBytes(oldCatalog, oldKeys.privateKey) : oldCatalog),
      now: () => new Date("2026-09-02T12:00:00Z")
    });
    await oldStore.refresh();
    const upgraded = new PluginCatalogStore({
      configDir: directory,
      catalogURL: "https://catalog.example/catalog.json",
      trust: trustKey(nextKeys.publicKey, "next-key", 2),
      fetchImpl: async (url) =>
        new Response(String(url).endsWith(".sig") ? signatureBytes(oldCatalog, oldKeys.privateKey) : oldCatalog),
      now: () => new Date("2026-09-03T12:00:00Z")
    });

    await expect(upgraded.refresh()).rejects.toThrow(/signing key|trusted/i);
    expect(() => upgraded.read()).toThrow(/signing key|trusted/i);
  });

  it("rejects a trusted lower-epoch catalog while replacing a retired receipt", async () => {
    const directory = mkdtempSync(join(tmpdir(), "atlas-catalog-store-"));
    directories.push(directory);
    const retiredKeys = generateKeyPairSync("ed25519");
    const legacyKeys = generateKeyPairSync("ed25519");
    const nextKeys = generateKeyPairSync("ed25519");
    const retiredCatalog = catalogBytes(
      1,
      `sha256:${"0".repeat(64)}`,
      [],
      "2026-09-01T12:00:00Z",
      "2026-09-20T12:00:00Z",
      2,
      "retired-key"
    );
    const oldStore = new PluginCatalogStore({
      configDir: directory,
      catalogURL: "https://catalog.example/catalog.json",
      trust: trustKey(retiredKeys.publicKey, "retired-key", 2),
      fetchImpl: async (url) =>
        new Response(
          String(url).endsWith(".sig")
            ? signatureBytes(retiredCatalog, retiredKeys.privateKey, "retired-key")
            : retiredCatalog
        ),
      now: () => new Date("2026-09-02T12:00:00Z")
    });
    await oldStore.refresh();
    const lowerEpochCatalog = catalogBytes(
      1,
      null,
      [],
      "2026-09-03T12:00:00Z",
      "2026-09-20T12:00:00Z",
      1,
      "legacy-key"
    );
    const upgraded = new PluginCatalogStore({
      configDir: directory,
      catalogURL: "https://catalog.example/catalog.json",
      trust: {
        keys: [
          { keyId: "legacy-key", keyEpoch: 1, publicKey: legacyKeys.publicKey },
          { keyId: "next-key", keyEpoch: 3, publicKey: nextKeys.publicKey }
        ],
        minimumCheckpoint: { keyEpoch: 1, sequence: 1 }
      },
      fetchImpl: async (url) =>
        new Response(
          String(url).endsWith(".sig")
            ? signatureBytes(lowerEpochCatalog, legacyKeys.privateKey, "legacy-key")
            : lowerEpochCatalog
        ),
      now: () => new Date("2026-09-03T12:01:00Z")
    });

    await expect(upgraded.refresh()).rejects.toThrow(/newer signing-key epoch/i);
  });

  it("fetches newest-first release documents and verifies their exact hashes and metadata", async () => {
    const directory = mkdtempSync(join(tmpdir(), "atlas-catalog-store-"));
    directories.push(directory);
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const oldBytes = releaseBytes("0.1.0");
    const newBytes = releaseBytes("0.2.0");
    const first = catalogBytes(1, null, [
      { version: "0.1.0", documentSha256: realDigest(oldBytes) },
      { version: "0.2.0", documentSha256: realDigest(newBytes) }
    ]);
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (url) => {
      const text = String(url);
      calls.push(text);
      if (text.endsWith(".sig")) return new Response(signatureBytes(first, privateKey));
      if (text === releaseURL("0.2.0")) return new Response(newBytes);
      if (text === releaseURL("0.1.0")) return new Response(oldBytes);
      return new Response(first);
    };
    const store = new PluginCatalogStore({
      configDir: directory,
      catalogURL: "https://catalog.example/catalog.json",
      trust: trust(publicKey),
      fetchImpl,
      now: () => new Date("2026-09-02T12:00:00Z")
    });
    await store.refresh();
    const candidates = await store.candidates(pluginId);
    expect(candidates.map((candidate) => candidate.release.version)).toEqual(["0.2.0", "0.1.0"]);
    expect(calls.slice(-2)).toEqual([releaseURL("0.2.0"), releaseURL("0.1.0")]);

    const mismatch = new PluginCatalogStore({
      configDir: directory,
      catalogURL: "https://catalog.example/catalog.json",
      trust: trust(publicKey),
      fetchImpl: async (url) =>
        String(url).includes("0.2.0.atlas-plugin") ? new Response(oldBytes) : new Response(first)
    });
    await expect(mismatch.candidates(pluginId)).rejects.toThrow(/hash/i);
  });

  it("can stop after the newest compatible release without touching a broken older asset", async () => {
    const directory = mkdtempSync(join(tmpdir(), "atlas-catalog-store-"));
    directories.push(directory);
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const newest = releaseBytes("0.2.0");
    const first = catalogBytes(1, null, [
      { version: "0.1.0", documentSha256: `sha256:${"0".repeat(64)}` },
      { version: "0.2.0", documentSha256: realDigest(newest) }
    ]);
    const calls: string[] = [];
    const store = new PluginCatalogStore({
      configDir: directory,
      catalogURL: "https://catalog.example/catalog.json",
      trust: trust(publicKey),
      fetchImpl: async (url) => {
        const text = String(url);
        calls.push(text);
        if (text.endsWith(".sig")) return new Response(signatureBytes(first, privateKey));
        if (text === releaseURL("0.2.0")) return new Response(newest);
        if (text === releaseURL("0.1.0")) throw new Error("broken historical asset must not be fetched");
        return new Response(first);
      },
      now: () => new Date("2026-09-02T12:00:00Z")
    });
    await store.refresh();
    const candidates = await store.candidates(pluginId, {
      contracts: {
        coreToPluginProtocolMajors: [1],
        pluginToSourceGatewayProtocolMajors: [1],
        atlasProtocolRevision: null
      }
    });
    expect(candidates.map((candidate) => candidate.release.version)).toEqual(["0.2.0"]);
    expect(calls).not.toContain(releaseURL("0.1.0"));
  });

  it("preserves a revoked current release while finding a compatible remediation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "atlas-catalog-store-"));
    directories.push(directory);
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const current = releaseBytes("0.2.0");
    const fallback = releaseBytes("0.1.0");
    const first = catalogBytes(1, null, [
      { version: "0.1.0", documentSha256: realDigest(fallback) },
      { version: "0.2.0", documentSha256: realDigest(current), revoked: true }
    ]);
    const calls: string[] = [];
    const store = new PluginCatalogStore({
      configDir: directory,
      catalogURL: "https://catalog.example/catalog.json",
      trust: trust(publicKey),
      fetchImpl: async (url) => {
        const text = String(url);
        calls.push(text);
        if (text.endsWith(".sig")) return new Response(signatureBytes(first, privateKey));
        if (text === releaseURL("0.2.0")) throw new Error("revoked asset may be gone");
        if (text === releaseURL("0.1.0")) return new Response(fallback);
        return new Response(first);
      },
      now: () => new Date("2026-09-02T12:00:00Z")
    });
    await store.refresh();
    const candidates = await store.candidates(pluginId, {
      currentVersion: "0.2.0",
      currentRelease: parsePluginRelease(current),
      contracts: {
        coreToPluginProtocolMajors: [1],
        pluginToSourceGatewayProtocolMajors: [1],
        atlasProtocolRevision: null
      }
    });
    expect(candidates.map((candidate) => candidate.release.version)).toEqual(["0.2.0", "0.1.0"]);
    expect(candidates[0]?.catalog.revoked).toBe(true);
    expect(calls).not.toContain(releaseURL("0.2.0"));
    expect(calls.at(-1)).toBe(releaseURL("0.1.0"));
  });

  it("uses the highest observed clock value after a rollback", async () => {
    const directory = mkdtempSync(join(tmpdir(), "atlas-catalog-store-"));
    directories.push(directory);
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const first = catalogBytes(1, null, [], "2026-09-01T12:00:00Z", "2026-09-04T12:00:00Z");
    let now = new Date("2026-09-02T12:00:00Z");
    const store = new PluginCatalogStore({
      configDir: directory,
      catalogURL: "https://catalog.example/catalog.json",
      trust: trust(publicKey),
      fetchImpl: async (url) => new Response(String(url).endsWith(".sig") ? signatureBytes(first, privateKey) : first),
      now: () => now
    });
    await store.refresh();
    now = new Date("2026-09-05T12:00:00Z");
    await expect(() => store.read()).toThrow(/expired/i);
    now = new Date("2026-09-02T12:01:00Z");
    await expect(() => store.read()).toThrow(/expired/i);
  });

  it("round-trips a near-maximum catalog receipt and preserves anti-rollback state", async () => {
    const directory = mkdtempSync(join(tmpdir(), "atlas-catalog-store-"));
    directories.push(directory);
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const first = nearMaximumCatalogBytes(1, null, "2026-09-01T12:00:00Z");
    expect(first.byteLength).toBeGreaterThan((4 << 20) - 5000);
    expect(first.byteLength).toBeLessThanOrEqual(4 << 20);
    let current = first;
    const store = new PluginCatalogStore({
      configDir: directory,
      catalogURL: "https://catalog.example/catalog.json",
      trust: trust(publicKey),
      fetchImpl: async (url) =>
        new Response(String(url).endsWith(".sig") ? signatureBytes(current, privateKey) : current),
      now: () => new Date("2026-09-02T12:00:00Z")
    });
    const firstReceipt = await store.refresh();
    expect(store.read().catalogSha256).toBe(firstReceipt.catalogSha256);

    current = nearMaximumCatalogBytes(2, firstReceipt.catalogSha256, "2026-09-02T12:00:00Z");
    const secondReceipt = await store.refresh();
    expect(store.read().catalogSha256).toBe(secondReceipt.catalogSha256);

    current = first;
    await expect(store.refresh()).rejects.toThrow(/older|sequence/i);
    expect(store.read().catalogSha256).toBe(secondReceipt.catalogSha256);
  });

  it("accepts the checked-in trust configuration shape without signer fallback", () => {
    const configuration = parsePluginTrustConfiguration({
      schema: 1,
      catalog_url: "https://catalog.example/catalog.json",
      keys: [],
      minimum_checkpoint: { key_epoch: 1, sequence: 1 }
    });
    expect(configuration.trust.keys).toEqual([]);
  });
});
