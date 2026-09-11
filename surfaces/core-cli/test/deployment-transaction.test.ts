import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createOwnerIdentity,
  DeploymentTransactionStore,
  ownerLiveness,
  TransactionRecoveryRequiredError
} from "../src/deployment-transaction.js";

function temporaryDirectory(): string {
  return mkdtempSync(join(tmpdir(), "atlas-transaction-test-"));
}

describe("DeploymentTransactionStore", () => {
  it("publishes the journal only after its candidate directory is complete", () => {
    const root = temporaryDirectory();
    const abandoned = join(root, ".transaction.candidate-crashed");
    mkdirSync(abandoned, { recursive: true });
    const store = DeploymentTransactionStore.begin(root, {
      operation: "start",
      dockerEngineId: "engine-0",
      previousRunning: false,
      desiredRunning: true,
      recovery: { priorBackupIdentity: `sha256:${"a".repeat(64)}`, priorPluginHealthy: false }
    });
    expect(existsSync(join(root, "transaction", "journal.json"))).toBe(true);
    expect(existsSync(abandoned)).toBe(false);
    expect(store.journal.phase).toBe("prepared");
    expect(store.journal.recovery?.priorBackupIdentity).toBe(`sha256:${"a".repeat(64)}`);
    expect(store.journal.recovery?.priorPluginHealthy).toBe(false);
  });

  it("persists a typed journal, restores files, and removes absent-before files", () => {
    const root = temporaryDirectory();
    writeFileSync(join(root, "state.json"), "old state\n", { mode: 0o640 });
    const store = DeploymentTransactionStore.begin(root, {
      operation: "plugin-enable",
      dockerEngineId: "engine-1",
      previousRunning: true,
      desiredRunning: false,
      now: new Date("2026-09-09T12:00:00.000Z")
    });

    expect(store.snapshot("state.json").state).toBe("present");
    store.stage("state.json", "candidate state\n", { mode: 0o640 });
    store.stage("new.json", "candidate file\n");
    store.applyStaged("state.json");
    store.applyStaged("new.json");
    expect(readFileSync(join(root, "state.json"), "utf8")).toBe("candidate state\n");
    expect(existsSync(join(root, "new.json"))).toBe(true);

    store.advance("runtime-changing");
    const reopened = DeploymentTransactionStore.open(root);
    expect(reopened.journal.desiredRunning).toBe(false);
    expect(reopened.journal.previousRunning).toBe(true);
    expect(reopened.journal.phase).toBe("runtime-changing");
    const rollback = reopened.rollback();
    expect(rollback.desiredRunning).toBe(false);
    expect(readFileSync(join(root, "state.json"), "utf8")).toBe("old state\n");
    expect(existsSync(join(root, "new.json"))).toBe(false);
    expect(reopened.journal.phase).toBe("rollback-complete");
    reopened.cleanup();
    expect(existsSync(join(root, "transaction"))).toBe(false);
  });

  it("keeps the journal durable across a reopen and excludes monotonic state", () => {
    const root = temporaryDirectory();
    const store = DeploymentTransactionStore.begin(root, {
      operation: "plugin-install",
      dockerEngineId: "engine-2",
      previousRunning: false,
      desiredRunning: false
    });
    store.stage("plugins/example/installed.json", "{}\n");
    expect(readFileSync(store.stagedPath("plugins/example/installed.json"), "utf8")).toBe("{}\n");
    expect(() => store.snapshot("catalog-state.json")).toThrow(/monotonic state/);
    expect(() => store.snapshot("run-intent.json")).toThrow(/monotonic state/);
    expect(() => store.snapshot("../outside.json")).toThrow(/escapes/);

    const journal = JSON.parse(readFileSync(join(root, "transaction", "journal.json"), "utf8")) as {
      phase: string;
      staged: Record<string, { sha256: string; size: number }>;
    };
    expect(journal.phase).toBe("prepared");
    expect(journal.staged["plugins/example/installed.json"]?.size).toBe(3);
  });

  it("refuses automatic rollback after Core or credential startup boundaries", () => {
    const root = temporaryDirectory();
    const store = DeploymentTransactionStore.begin(root, {
      operation: "core-update",
      dockerEngineId: "engine-3",
      previousRunning: true,
      desiredRunning: true
    });
    store.advance("runtime-changing");
    store.advance("core-started");
    expect(() => store.rollback()).toThrow(TransactionRecoveryRequiredError);
    expect(DeploymentTransactionStore.open(root).journal.phase).toBe("core-started");
  });

  it("restores a paired backup only through the explicit started-phase method", () => {
    const root = temporaryDirectory();
    writeFileSync(join(root, "state.json"), "prior state\n");
    writeFileSync(join(root, "run-intent.json"), '{"desiredRunning":true}\n');
    writeFileSync(join(root, "catalog-state.json"), '{"revision":4}\n');
    const store = DeploymentTransactionStore.begin(root, {
      operation: "core-update",
      dockerEngineId: "engine-paired",
      previousRunning: true,
      desiredRunning: true
    });
    store.stage("state.json", "target state\n");
    store.applyStaged("state.json");
    store.advance("runtime-changing");
    store.advance("core-started");

    expect(() => store.rollback()).toThrow(TransactionRecoveryRequiredError);
    const restored = store.restoreAfterPairedBackup();
    expect(restored.previousRunning).toBe(true);
    expect(readFileSync(join(root, "state.json"), "utf8")).toBe("prior state\n");
    expect(readFileSync(join(root, "run-intent.json"), "utf8")).toBe('{"desiredRunning":true}\n');
    expect(readFileSync(join(root, "catalog-state.json"), "utf8")).toBe('{"revision":4}\n');
    expect(store.journal.phase).toBe("rollback-complete");
  });

  it("detects staged-file tampering before a candidate is applied", () => {
    const root = temporaryDirectory();
    const store = DeploymentTransactionStore.begin(root, {
      operation: "plugin-install",
      dockerEngineId: "engine-staged",
      previousRunning: false,
      desiredRunning: false
    });
    store.stage("plugins/example/installed.json", "original\n");
    writeFileSync(store.stagedPath("plugins/example/installed.json"), "tampered\n");
    expect(() => store.readStaged("plugins/example/installed.json")).toThrow(/hash check/);
  });

  it("rejects symlink targets and reports the current owner as alive", () => {
    const root = temporaryDirectory();
    const external = temporaryDirectory();
    writeFileSync(join(external, "secret.json"), "secret\n");
    symlinkSync(join(external, "secret.json"), join(root, "state.json"));
    const store = DeploymentTransactionStore.begin(root, {
      operation: "plugin-update",
      dockerEngineId: "engine-4",
      previousRunning: false,
      desiredRunning: false
    });
    expect(() => store.snapshot("state.json")).toThrow(/symbolic link/);
    expect(ownerLiveness(createOwnerIdentity("engine-4"))).toBe("alive");
  });
});
