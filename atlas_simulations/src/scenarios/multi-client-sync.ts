import { isNotFoundError } from "../server/atlas.js";
import type { Scenario, ScenarioContext } from "../server/scenario.js";
import { jsonNumber } from "../shared/types.js";
import { boundedNumberInput, boundedPositiveIntegerInput, deadlineExceeded, isoNow, point, withDeadline } from "./helpers.js";

const SYNC_POLL_INTERVAL_MS = 500;
const MIN_SETTLE_MS = SYNC_POLL_INTERVAL_MS * 3;

const multiClientSync: Scenario = {
  id: "multi-client-sync",
  name: "Multi-client sync",
  summary: "Runs multiple SDK sync clients and checks whether they converge after writes.",
  acceptsJson: false,
  inputFields: [
    { key: "clientCount", label: "Client count", type: "number", defaultValue: jsonNumber(2), min: jsonNumber(1), max: jsonNumber(8), step: jsonNumber(1) },
    { key: "writes", label: "Writes", type: "number", defaultValue: jsonNumber(3), min: jsonNumber(1), max: jsonNumber(20), step: jsonNumber(1) },
    { key: "settleMs", label: "Settle ms", type: "number", defaultValue: jsonNumber(MIN_SETTLE_MS), min: jsonNumber(MIN_SETTLE_MS), max: jsonNumber(10000), step: jsonNumber(50) }
  ],
  async run(ctx, input) {
    const clientCount = boundedPositiveIntegerInput(input, "clientCount", 8);
    const writes = boundedPositiveIntegerInput(input, "writes", 20);
    const settleMs = boundedNumberInput(input, "settleMs", MIN_SETTLE_MS, 10000);
    const readers: Array<{
      client: ScenarioContext["client"];
      seenVersions: Map<string, number>;
      unwatch: () => void;
    }> = [];
    const ids: string[] = [];
    try {
      for (let index = 0; index < clientCount; index++) {
        if (ctx.signal.aborted) throw new Error("Simulation cancelled");
        const client = ctx.newClient({ sync: "all", pollIntervalMs: SYNC_POLL_INTERVAL_MS });
        const seenVersions = new Map<string, number>();
        const unwatch = client.watch({ filter: "type", resource_type: "entity" }, (entity) => {
          if (!entity || !("entity_id" in entity) || typeof entity.entity_id !== "string") return;
          if (ids.includes(entity.entity_id)) seenVersions.set(entity.entity_id, entity.metadata.version);
        });
        readers.push({ client, seenVersions, unwatch });
        await client.sync.start();
        const status = client.sync.status();
        ctx.log(`Sync client ${index + 1} started`, {
          running: status.running,
          healthy: status.healthy,
          degraded: status.degraded,
          lastVersion: jsonNumber(status.lastVersion)
        });
      }

      for (let index = 0; index < writes; index++) {
        if (ctx.signal.aborted) throw new Error("Simulation cancelled");
        const id = ctx.id(`sync-asset-${index + 1}`);
        ids.push(id);
        await ctx.createEntity({
          entity_id: id,
          entity_type: "asset",
          alias: `Sync asset ${index + 1}`,
          subtype: "sync-probe",
          components: {
            telemetry: {
              latitude: 38.87 + index * 0.001,
              longitude: -77.03 - index * 0.001,
              last_update: isoNow()
            },
            geometry: point(-77.03 - index * 0.001, 38.87 + index * 0.001),
            heartbeat: { last_seen: isoNow() },
            status: { value: "sync-probe", last_update: isoNow() },
            custom_simulation: { run_id: ctx.runId, write_index: index + 1 }
          }
        });
        if (ctx.signal.aborted) throw new Error("Simulation cancelled");
        ctx.log(`Writer created ${id}`);
      }

      const writerSnapshot = await snapshotVersions(ctx.client, ids);
      const writerMaxVersion = maxVersion(writerSnapshot);
      const verificationResults = await Promise.allSettled(readers.map(async ({ client, seenVersions }, readerIndex) => {
        const settleDeadline = Date.now() + settleMs;
        const sync = await waitForSyncedResources(ctx, client, seenVersions, ids, writerMaxVersion, settleDeadline);
        const readerSnapshot = snapshotSeenVersions(seenVersions, ids);
        ctx.assert(`Client ${readerIndex + 1} saw writer resources`, sync.seen === ids.length, `${sync.seen}/${ids.length} resources visible via sync`);
        ctx.assert(
          `Client ${readerIndex + 1} matched writer versions`,
          snapshotsMatch(readerSnapshot, writerSnapshot),
          `${readerSnapshot.length}/${writerSnapshot.length} versions matched`
        );
        const status = client.sync.status();
        ctx.assert(`Client ${readerIndex + 1} sync running`, status.running, status.running ? "running" : "stopped");
        ctx.assert(`Client ${readerIndex + 1} sync healthy`, status.healthy, status.healthy ? "healthy" : "degraded or recovering");
      }));
      const rejectedVerification = verificationResults.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (rejectedVerification) throw rejectedVerification.reason;
    } finally {
      for (const reader of readers) {
        reader.unwatch();
      }
    }
  }
};

export default multiClientSync;

async function waitForSyncedResources(
  ctx: ScenarioContext,
  reader: ScenarioContext["client"],
  seenVersions: Map<string, number>,
  ids: string[],
  writerMaxVersion: number,
  deadline: number
): Promise<{ seen: number; lastVersion: number }> {
  let state = syncState(reader, seenVersions, ids);
  while ((state.seen < ids.length || state.lastVersion < writerMaxVersion) && Date.now() < deadline) {
    await ctx.wait(Math.min(250, Math.max(1, deadline - Date.now())));
    state = syncState(reader, seenVersions, ids);
  }
  return state;
}

async function snapshotVersions(reader: ScenarioContext["client"], ids: string[], deadline = Number.POSITIVE_INFINITY): Promise<Array<[string, number]>> {
  const snapshot = await Promise.all(ids.map((id) => readVersion(reader, id, deadline)));
  return snapshot.flatMap((version) => (version ? [version] : []));
}

function snapshotSeenVersions(seenVersions: Map<string, number>, ids: string[]): Array<[string, number]> {
  return ids.flatMap((id) => {
    const version = seenVersions.get(id);
    return version === undefined ? [] : [[id, version]];
  });
}

function snapshotsMatch(left: Array<[string, number]>, right: Array<[string, number]>): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function maxVersion(snapshot: Array<[string, number]>): number {
  return Math.max(0, ...snapshot.map(([, version]) => version));
}

function syncState(reader: ScenarioContext["client"], seenVersions: Map<string, number>, ids: string[]): { seen: number; lastVersion: number } {
  const status = reader.sync.status();
  return {
    seen: ids.filter((id) => seenVersions.has(id)).length,
    lastVersion: status.lastVersion
  };
}

async function readVersion(reader: ScenarioContext["client"], id: string, deadline: number): Promise<[string, number] | undefined> {
  try {
    const entity = await withDeadline(() => reader.entities.get(id), deadline);
    if (deadlineExceeded(entity)) return undefined;
    return entity ? [entity.entity_id, entity.metadata.version] : undefined;
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
    return undefined;
  }
}
