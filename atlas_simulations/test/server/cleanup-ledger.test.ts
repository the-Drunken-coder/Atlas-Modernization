import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CleanupLedger, type CleanupLedgerRecord } from "../../src/server/cleanup-ledger.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("CleanupLedger", () => {
  it("round-trips records through atomic owner-only run files without secrets", () => {
    const directory = temporaryLedgerDirectory();
    const ledger = new CleanupLedger(directory);
    const run = record();
    const filePath = path.join(directory, `${run.runId}.json`);

    ledger.save(run);

    expect(lstatSync(directory).mode & 0o777).toBe(0o700);
    expect(lstatSync(filePath).mode & 0o777).toBe(0o600);
    expect(readdirSync(directory)).toEqual([path.basename(filePath)]);
    const raw = readFileSync(filePath, "utf8");
    expect(raw).not.toContain("apiKey");
    expect(raw).not.toContain("inputs");
    expect(new CleanupLedger(directory).load()).toEqual([run]);

    ledger.remove(run.runId);
    expect(existsSync(filePath)).toBe(false);
  });

  it("preserves records saved by separate ledger instances", () => {
    const directory = temporaryLedgerDirectory();
    const first = new CleanupLedger(directory);
    const second = new CleanupLedger(directory);
    const firstRun = record("sim-ledger-one");
    const secondRun = record("sim-ledger-two");

    first.save(firstRun);
    second.save(secondRun);

    expect(new CleanupLedger(directory).load()).toEqual([firstRun, secondRun]);
  });

  it("tightens permissions on an existing ledger before recovery", () => {
    const directory = temporaryLedgerDirectory();
    const run = record();
    const filePath = path.join(directory, `${run.runId}.json`);
    mkdirSync(directory, { recursive: true, mode: 0o777 });
    writeFileSync(filePath, JSON.stringify({ version: 1, run }), { mode: 0o666 });
    chmodSync(directory, 0o777);
    chmodSync(filePath, 0o666);

    expect(new CleanupLedger(directory).load()).toEqual([run]);
    expect(lstatSync(directory).mode & 0o777).toBe(0o700);
    expect(lstatSync(filePath).mode & 0o777).toBe(0o600);
  });

  it("rejects duplicate and non-run-owned cleanup resources", () => {
    const ledger = new CleanupLedger(temporaryLedgerDirectory());
    const run = record();

    expect(() => ledger.save({ ...run, resources: [{ type: "entity", id: "external-entity" }] })).toThrow("outside its run ID prefix");
    expect(() => ledger.save({ ...run, resources: [run.resources[0]!, run.resources[0]!] })).toThrow("duplicate resources");
    expect(ledger.load()).toEqual([]);
  });

  it("rejects attacker-chosen run IDs and loopback targets", () => {
    const ledger = new CleanupLedger(temporaryLedgerDirectory());
    const run = record();

    expect(() => ledger.save({ ...run, runId: "external", resources: [{ type: "entity", id: "external-entity" }] })).toThrow("invalid run record");
    expect(() => ledger.save({ ...run, target: { ...run.target, baseUrl: "https://localhost:8443" } })).toThrow("invalid run record");
    expect(ledger.load()).toEqual([]);
  });

  it("rejects resource histories beyond the RunStore cleanup limit", () => {
    const ledger = new CleanupLedger(temporaryLedgerDirectory());
    const run = record();
    const resources = Array.from({ length: 1_002 }, (_, index) => ({
      type: "entity" as const,
      id: `${run.runId}-asset-${index}`
    }));

    expect(() => ledger.save({ ...run, resources })).toThrow("contains too many resources");
  });

  it("fails closed for malformed schemas and symlinked ledger files", () => {
    const malformedDirectory = temporaryLedgerDirectory();
    mkdirSync(malformedDirectory, { recursive: true });
    writeFileSync(path.join(malformedDirectory, `${record().runId}.json`), JSON.stringify({ version: 1, run: { unexpected: true } }));

    expect(() => new CleanupLedger(malformedDirectory).load()).toThrow("invalid run record");

    const symlinkDirectory = temporaryLedgerDirectory();
    mkdirSync(symlinkDirectory, { recursive: true });
    const targetPath = path.join(path.dirname(symlinkDirectory), "target");
    writeFileSync(targetPath, JSON.stringify({ version: 1, run: record() }));
    const symlinkPath = path.join(symlinkDirectory, `${record().runId}.json`);
    symlinkSync(targetPath, symlinkPath);

    expect(() => new CleanupLedger(symlinkDirectory).load()).toThrow("regular file");
  });

  it("rejects symlinked ledger directories", () => {
    const directory = temporaryLedgerDirectory();
    const target = path.join(path.dirname(directory), "real-runs");
    mkdirSync(target, { recursive: true });
    symlinkSync(target, directory);

    expect(() => new CleanupLedger(directory).load()).toThrow("real directory");
  });

  it("requires every JSON filename to match its record run ID", () => {
    const directory = temporaryLedgerDirectory();
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, "sim-ledger-file.json"), JSON.stringify({ version: 1, run: record("sim-ledger-other") }));

    expect(() => new CleanupLedger(directory).load()).toThrow("filename does not match");
  });
});

function record(runId = "sim-ledger-test"): CleanupLedgerRecord {
  return {
    runId,
    scenarioId: "moving-assets",
    scenarioName: "Moving assets",
    startedAt: "2026-07-10T12:00:00.000Z",
    target: {
      id: "deployed",
      label: "Deployed Core",
      baseUrl: "https://atlas.example.test"
    },
    resources: [{ type: "entity", id: `${runId}-asset` }]
  };
}

function temporaryLedgerDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "atlas-simulations-ledger-"));
  temporaryDirectories.push(directory);
  return path.join(directory, "state", "runs");
}
