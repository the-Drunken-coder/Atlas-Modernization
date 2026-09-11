import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DeploymentTransactionStore } from "../src/deployment-transaction.js";
import {
  type ManagedKeyAction,
  type ManagedPluginCredentialHost,
  ManagedPluginCredentials,
  ManagedPluginKeyRejectedError
} from "../src/host-credentials.js";

const OLD_KEY = "atlas_ak_aaaaaaaaaaaaaaaa.old-secret";
const ENGINE_ID = "test-engine";

type ManagedKeyRecord = {
  id: string;
  name: string;
  apiKey: string;
};

class CredentialHostStub implements ManagedPluginCredentialHost {
  running = true;
  unknownCreate = false;
  failRevokeOnce = false;
  failVerifyOnce = false;
  failRestoreOnce = false;
  rejectOldKeyOnce = false;
  failAuthenticationOnce = false;
  starts = 0;
  startIncludesPlugins: boolean[] = [];
  stops = 0;
  recreated = 0;
  verified = 0;
  restored = 0;
  recreatedKeys: Array<string | undefined> = [];
  authenticated: string[] = [];
  actions: Array<{ action: ManagedKeyAction; value: string }> = [];
  readonly records = new Map<string, ManagedKeyRecord>();
  #nextKey = 0;

  async isRunning(): Promise<boolean> {
    return this.running;
  }

  async startBase(includePluginFragments = false): Promise<void> {
    this.starts += 1;
    this.startIncludesPlugins.push(includePluginFragments);
    this.running = true;
  }

  async stopBase(): Promise<void> {
    this.stops += 1;
    this.running = false;
  }

  async runManagedKeys(action: ManagedKeyAction, value: string): Promise<unknown> {
    this.actions.push({ action, value });
    if (!this.running) throw new Error("Core is stopped");
    if (action === "list") {
      return [...this.records.values()]
        .filter((record) => record.name === value)
        .map(({ apiKey: _apiKey, ...metadata }) => metadata);
    }
    if (action === "revoke") {
      if (this.failRevokeOnce) {
        this.failRevokeOnce = false;
        throw new Error("injected revoke failure");
      }
      for (const [id, record] of this.records) {
        if (record.id === value) this.records.delete(id);
      }
      return { id: value, revoked: true };
    }

    this.#nextKey += 1;
    const id = `atlas_ak_${String(this.#nextKey).padStart(16, "0")}`;
    const record = { id, name: value, apiKey: `${id}.secret-${this.#nextKey}` };
    this.records.set(id, record);
    if (this.unknownCreate) {
      this.unknownCreate = false;
      throw new Error("injected lost create response");
    }
    return { id, name: value, api_key: record.apiKey };
  }

  async authenticateKey(apiKey: string): Promise<void> {
    this.authenticated.push(apiKey);
    if (this.failAuthenticationOnce) {
      this.failAuthenticationOnce = false;
      throw new Error("temporary authentication failure");
    }
    if (this.rejectOldKeyOnce && apiKey === OLD_KEY) {
      this.rejectOldKeyOnce = false;
      throw new ManagedPluginKeyRejectedError();
    }
    if (apiKey !== OLD_KEY && ![...this.records.values()].some((record) => record.apiKey === apiKey)) {
      throw new Error("unknown key");
    }
  }

  async recreateSDKPlugins(apiKey?: string): Promise<void> {
    this.recreated += 1;
    this.recreatedKeys.push(apiKey);
  }

  async verifySDKPlugins(): Promise<void> {
    this.verified += 1;
    if (this.failVerifyOnce) {
      this.failVerifyOnce = false;
      throw new Error("injected verification failure");
    }
  }

  async restoreSDKPlugins(): Promise<void> {
    this.restored += 1;
    if (this.failRestoreOnce) {
      this.failRestoreOnce = false;
      throw new Error("injected restoration failure");
    }
  }

  async withRecovery<T>(operation: () => Promise<T>): Promise<T> {
    return operation();
  }
}

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function setupTransaction(
  operation: "init" | "core-update" | "plugin-key-rotation",
  key = ""
): { configDir: string; transactions: DeploymentTransactionStore } {
  const configDir = mkdtempSync(join(tmpdir(), "atlas-host-credentials-"));
  temporaryDirectories.push(configDir);
  writeFileSync(join(configDir, ".env"), `ATLAS_ADMIN_PASSWORD=admin-secret\nATLAS_PLUGIN_API_KEY=${key}\n`, {
    mode: 0o600
  });
  chmodSync(join(configDir, ".env"), 0o600);
  const transactions = DeploymentTransactionStore.begin(configDir, {
    operation,
    dockerEngineId: ENGINE_ID,
    previousRunning: true,
    desiredRunning: true
  });
  transactions.advance("core-started");
  return { configDir, transactions };
}

describe("ManagedPluginCredentials", () => {
  it("authenticates an existing key without rotating it during Core setup", async () => {
    const { configDir, transactions } = setupTransaction("core-update", OLD_KEY);
    const host = new CredentialHostStub();

    await new ManagedPluginCredentials({
      configDir,
      transactions,
      host,
      dockerEngineId: ENGINE_ID
    }).ensureWithinTransaction();

    expect(host.authenticated).toEqual([OLD_KEY]);
    expect(host.actions).toEqual([]);
    expect(host.recreated).toBe(0);
    expect(transactions.read().staged).toEqual({});
  });

  it("starts a journaled replacement when Core definitively rejects the existing key", async () => {
    const { configDir, transactions } = setupTransaction("core-update", OLD_KEY);
    const host = new CredentialHostStub();
    host.rejectOldKeyOnce = true;

    await new ManagedPluginCredentials({
      configDir,
      transactions,
      host,
      dockerEngineId: ENGINE_ID
    }).ensureWithinTransaction();

    expect(host.actions).toContainEqual({ action: "create", value: expect.stringMatching(/^atlas-plugin-key-/u) });
    expect(host.actions).toContainEqual({ action: "revoke", value: OLD_KEY.split(".")[0] ?? "" });
    expect(readFileSync(join(configDir, ".env"), "utf8")).toContain(
      "ATLAS_PLUGIN_API_KEY=atlas_ak_0000000000000001.secret-1"
    );
    expect(transactions.read().staged).toHaveProperty("credential-intent.json");
  });

  it("leaves a transaction retryable when existing-key authentication is transiently unavailable", async () => {
    const { configDir, transactions } = setupTransaction("core-update", OLD_KEY);
    const host = new CredentialHostStub();
    host.failAuthenticationOnce = true;
    const manager = new ManagedPluginCredentials({ configDir, transactions, host, dockerEngineId: ENGINE_ID });

    await expect(manager.ensureWithinTransaction()).rejects.toThrow("The managed Plugin key was rejected by Core");

    expect(host.actions).toEqual([]);
    expect(transactions.read().staged).toEqual({});
  });

  it("starts a journaled replacement when the stored key is malformed", async () => {
    const { configDir, transactions } = setupTransaction("core-update", "malformed-key");
    const host = new CredentialHostStub();

    await new ManagedPluginCredentials({
      configDir,
      transactions,
      host,
      dockerEngineId: ENGINE_ID
    }).ensureWithinTransaction();

    expect(host.actions).toContainEqual({ action: "create", value: expect.stringMatching(/^atlas-plugin-key-/u) });
    expect(host.actions.some((action) => action.action === "revoke")).toBe(false);
    expect(readFileSync(join(configDir, ".env"), "utf8")).toContain(
      "ATLAS_PLUGIN_API_KEY=atlas_ak_0000000000000001.secret-1"
    );
  });

  it("provisions a key without advancing an init transaction past core-started", async () => {
    const { configDir, transactions } = setupTransaction("init");
    const host = new CredentialHostStub();

    await new ManagedPluginCredentials({
      configDir,
      transactions,
      host,
      dockerEngineId: ENGINE_ID
    }).ensureWithinTransaction();

    expect(transactions.read().phase).toBe("core-started");
    const env = readFileSync(join(configDir, ".env"), "utf8");
    expect(env).toContain("ATLAS_PLUGIN_API_KEY=atlas_ak_0000000000000001.secret-1");
    expect(host.authenticated).toContain("atlas_ak_0000000000000001.secret-1");
    expect(host.recreated).toBe(1);
    expect(host.verified).toBe(1);
    expect(readFileSync(transactions.stagedPath("credential-intent.json"), "utf8")).not.toContain("secret-1");
  });

  it("reconciles an uncertain create response before trying a fresh attempt", async () => {
    const { configDir, transactions } = setupTransaction("init");
    const host = new CredentialHostStub();
    host.unknownCreate = true;
    const manager = new ManagedPluginCredentials({ configDir, transactions, host, dockerEngineId: ENGINE_ID });

    await expect(manager.ensureWithinTransaction()).rejects.toThrow("Core managed-key create failed");
    expect([...host.records.values()]).toHaveLength(1);
    const firstAttempt = host.actions.find((action) => action.action === "create")?.value;
    expect(firstAttempt).toMatch(/^atlas-plugin-key-/u);

    await manager.recover();

    expect([...host.records.values()]).toHaveLength(1);
    expect([...host.records.values()][0]?.id).toBe("atlas_ak_0000000000000002");
    expect(host.actions).toContainEqual({ action: "revoke", value: "atlas_ak_0000000000000001" });
  });

  it("finishes revocation after a crash at the durable-credentials phase", async () => {
    const { configDir, transactions } = setupTransaction("plugin-key-rotation", OLD_KEY);
    const host = new CredentialHostStub();
    host.failRevokeOnce = true;
    const manager = new ManagedPluginCredentials({ configDir, transactions, host, dockerEngineId: ENGINE_ID });

    await expect(manager.recover()).rejects.toThrow("Core could not revoke the previous managed Plugin key");
    expect(transactions.read().phase).toBe("credentials-durable");
    expect(readFileSync(join(configDir, ".env"), "utf8")).toContain(
      "ATLAS_PLUGIN_API_KEY=atlas_ak_0000000000000001.secret-1"
    );

    await manager.recover();

    expect(existsSync(join(configDir, "transaction"))).toBe(false);
    expect(host.actions).toContainEqual({ action: "revoke", value: OLD_KEY.split(".")[0] ?? "" });
  });

  it("rolls back a pre-durable rotation and restores the old SDK runtime", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "atlas-host-credentials-"));
    temporaryDirectories.push(configDir);
    writeFileSync(join(configDir, ".env"), `ATLAS_PLUGIN_API_KEY=${OLD_KEY}\n`, { mode: 0o600 });
    const host = new CredentialHostStub();
    host.failVerifyOnce = true;
    const manager = new ManagedPluginCredentials({ configDir, host, dockerEngineId: ENGINE_ID });

    await expect(manager.rotate()).rejects.toThrow("Managed Plugin key rotation did not complete");

    expect(readFileSync(join(configDir, ".env"), "utf8")).toContain(`ATLAS_PLUGIN_API_KEY=${OLD_KEY}`);
    expect(host.recreatedKeys[0]).toMatch(/^atlas_ak_0000000000000001\.secret-1$/u);
    expect(host.restored).toBe(1);
    expect(host.records).toHaveLength(0);
    expect(host.actions).toContainEqual({ action: "revoke", value: "atlas_ak_0000000000000001" });
    expect(existsSync(join(configDir, "transaction"))).toBe(false);
  });

  it("retains rollback intent when SDK restoration fails and finishes it on recovery", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "atlas-host-credentials-"));
    temporaryDirectories.push(configDir);
    writeFileSync(join(configDir, ".env"), `ATLAS_PLUGIN_API_KEY=${OLD_KEY}\n`, { mode: 0o600 });
    const host = new CredentialHostStub();
    host.failVerifyOnce = true;
    host.failRestoreOnce = true;
    const manager = new ManagedPluginCredentials({ configDir, host, dockerEngineId: ENGINE_ID });

    await expect(manager.rotate()).rejects.toThrow("Managed Plugin key rotation did not complete");

    const transaction = DeploymentTransactionStore.open(configDir);
    expect(transaction.read().phase).toBe("rollback-complete");
    expect(readFileSync(join(configDir, ".env"), "utf8")).toContain(`ATLAS_PLUGIN_API_KEY=${OLD_KEY}`);
    expect(host.records).toHaveLength(0);

    await manager.recover();

    expect(host.restored).toBe(2);
    expect(host.records).toHaveLength(0);
    expect(host.actions).toContainEqual({ action: "revoke", value: "atlas_ak_0000000000000001" });
    expect(existsSync(join(configDir, "transaction"))).toBe(false);
  });

  it("honors an explicit stop intent while rolling back a failed rotation", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "atlas-host-credentials-"));
    temporaryDirectories.push(configDir);
    writeFileSync(join(configDir, ".env"), `ATLAS_PLUGIN_API_KEY=${OLD_KEY}\n`, { mode: 0o600 });
    writeFileSync(join(configDir, "run-intent.json"), JSON.stringify({ desiredRunning: false }), { mode: 0o600 });
    const host = new CredentialHostStub();
    host.failVerifyOnce = true;
    const manager = new ManagedPluginCredentials({ configDir, host, dockerEngineId: ENGINE_ID });

    await expect(manager.rotate()).rejects.toThrow("Managed Plugin key rotation did not complete");

    expect(host.stops).toBe(1);
    expect(host.restored).toBe(0);
    expect(host.running).toBe(false);
    expect(host.records).toHaveLength(0);
    expect(existsSync(join(configDir, "transaction"))).toBe(false);
  });

  it("restores a stopped deployment after standalone rotation", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "atlas-host-credentials-"));
    temporaryDirectories.push(configDir);
    writeFileSync(join(configDir, ".env"), `ATLAS_PLUGIN_API_KEY=${OLD_KEY}\n`, { mode: 0o600 });
    writeFileSync(join(configDir, "run-intent.json"), JSON.stringify({ desiredRunning: false }), { mode: 0o600 });
    const host = new CredentialHostStub();
    host.running = false;

    await new ManagedPluginCredentials({ configDir, host, dockerEngineId: ENGINE_ID }).rotate();

    expect(host.starts).toBe(1);
    expect(host.startIncludesPlugins).toEqual([false]);
    expect(host.stops).toBe(1);
    expect(host.recreated).toBe(0);
    expect(host.verified).toBe(0);
    expect(host.running).toBe(false);
    expect(existsSync(join(configDir, "transaction"))).toBe(false);
  });

  it("does not recreate SDK Plugins while recovering a stopped rotation", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "atlas-host-credentials-"));
    temporaryDirectories.push(configDir);
    writeFileSync(join(configDir, ".env"), `ATLAS_PLUGIN_API_KEY=${OLD_KEY}\n`, { mode: 0o600 });
    const host = new CredentialHostStub();
    host.running = false;
    host.failRevokeOnce = true;
    const manager = new ManagedPluginCredentials({ configDir, host, dockerEngineId: ENGINE_ID });

    await expect(manager.rotate()).rejects.toThrow("Managed Plugin key rotation did not complete");

    expect(host.starts).toBe(1);
    expect(host.startIncludesPlugins).toEqual([false]);
    expect(host.stops).toBe(0);
    expect(host.recreated).toBe(0);
    expect(host.verified).toBe(0);
    expect(DeploymentTransactionStore.open(configDir).read().phase).toBe("credentials-durable");

    await manager.recover();

    expect(host.recreated).toBe(0);
    expect(host.verified).toBe(0);
    expect(host.stops).toBe(1);
    expect(host.running).toBe(false);
    expect(existsSync(join(configDir, "transaction"))).toBe(false);
  });

  it("honors a stopped run intent when recovering a rotation captured as running", async () => {
    const { configDir, transactions } = setupTransaction("plugin-key-rotation", OLD_KEY);
    writeFileSync(join(configDir, "run-intent.json"), JSON.stringify({ schema: 1, desiredRunning: false }), {
      mode: 0o600
    });
    const host = new CredentialHostStub();
    host.running = false;

    await new ManagedPluginCredentials({ configDir, transactions, host, dockerEngineId: ENGINE_ID }).recover();

    expect(host.starts).toBe(1);
    expect(host.startIncludesPlugins).toEqual([true]);
    expect(host.stops).toBe(1);
    expect(host.running).toBe(false);
    expect(existsSync(join(configDir, "transaction"))).toBe(false);
  });
});
