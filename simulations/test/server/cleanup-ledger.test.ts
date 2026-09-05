import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
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
    writeFileSync(filePath, JSON.stringify({ version: 2, run }), { mode: 0o666 });
    chmodSync(directory, 0o777);
    chmodSync(filePath, 0o666);

    expect(new CleanupLedger(directory).load()).toEqual([run]);
    expect(lstatSync(directory).mode & 0o777).toBe(0o700);
    expect(lstatSync(filePath).mode & 0o777).toBe(0o600);
  });

  it("rejects duplicate and non-run-owned cleanup resources", () => {
    const ledger = new CleanupLedger(temporaryLedgerDirectory());
    const run = record();

    expect(() =>
      ledger.save({ ...run, resources: [{ type: "entity", id: "external-entity", instanceToken: "external" }] })
    ).toThrow("outside its run ID prefix");
    expect(() => ledger.save({ ...run, resources: [run.resources[0]!, run.resources[0]!] })).toThrow(
      "duplicate resources"
    );
    expect(() =>
      ledger.save({
        ...run,
        resources: [
          run.resources[0]!,
          { type: "entity", id: `${run.runId}-asset-2`, instanceToken: run.resources[0]!.instanceToken }
        ]
      })
    ).toThrow("duplicate instance tokens");
    expect(ledger.load()).toEqual([]);
  });

  it("rejects Unicode control and non-printable instance-token characters", () => {
    const ledger = new CleanupLedger(temporaryLedgerDirectory());
    const run = record();

    for (const character of ["\u0085", "\u200b"]) {
      expect(() =>
        ledger.save({
          ...run,
          resources: [{ ...run.resources[0]!, instanceToken: `token${character}value` }]
        })
      ).toThrow("outside its run ID prefix");
    }
    expect(ledger.load()).toEqual([]);
  });

  it("rejects attacker-chosen run IDs and every loopback target form", () => {
    const ledger = new CleanupLedger(temporaryLedgerDirectory());
    const run = record();

    expect(() =>
      ledger.save({
        ...run,
        runId: "external",
        resources: [{ type: "entity", id: "external-entity", instanceToken: "external" }]
      })
    ).toThrow("invalid run record");
    for (const baseUrl of [
      "https://localhost:8443",
      "https://[::ffff:127.0.0.1]:8443",
      "https://[::ffff:7f00:1]:8443"
    ]) {
      expect(() => ledger.save({ ...run, target: { ...run.target, baseUrl } })).toThrow("invalid run record");
    }
    expect(ledger.load()).toEqual([]);
  });

  it("rejects resource histories beyond the RunStore cleanup limit", () => {
    const ledger = new CleanupLedger(temporaryLedgerDirectory());
    const run = record();
    const resources = Array.from({ length: 1_002 }, (_, index) => ({
      type: "entity" as const,
      id: `${run.runId}-asset-${index}`,
      instanceToken: `token-${index}`
    }));

    expect(() => ledger.save({ ...run, resources })).toThrow("contains too many resources");
  });

  it("fails closed for malformed schemas and symlinked ledger files", () => {
    const malformedDirectory = temporaryLedgerDirectory();
    mkdirSync(malformedDirectory, { recursive: true });
    writeFileSync(
      path.join(malformedDirectory, `${record().runId}.json`),
      JSON.stringify({ version: 2, run: { unexpected: true } })
    );

    expect(() => new CleanupLedger(malformedDirectory).load()).toThrow("invalid run record");

    const symlinkDirectory = temporaryLedgerDirectory();
    mkdirSync(symlinkDirectory, { recursive: true });
    const targetPath = path.join(path.dirname(symlinkDirectory), "target");
    writeFileSync(targetPath, JSON.stringify({ version: 2, run: record() }));
    const symlinkPath = path.join(symlinkDirectory, `${record().runId}.json`);
    symlinkSync(targetPath, symlinkPath);

    expect(() => new CleanupLedger(symlinkDirectory).load()).toThrow("regular file");
  });

  it("fails closed for legacy ledgers without instance tokens", () => {
    const directory = temporaryLedgerDirectory();
    mkdirSync(directory, { recursive: true });
    const run = record();
    const legacyRun = { ...run, resources: [{ type: "entity", id: `${run.runId}-asset` }] };
    writeFileSync(path.join(directory, `${run.runId}.json`), JSON.stringify({ version: 1, run: legacyRun }));

    expect(() => new CleanupLedger(directory).load()).toThrow("unsupported schema");
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
    writeFileSync(
      path.join(directory, "sim-ledger-file.json"),
      JSON.stringify({ version: 2, run: record("sim-ledger-other") })
    );

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
    resources: [{ type: "entity", id: `${runId}-asset`, instanceToken: `${runId}-token` }]
  };
}

function temporaryLedgerDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "atlas-simulations-ledger-"));
  temporaryDirectories.push(directory);
  return path.join(directory, "state", "runs");
}
