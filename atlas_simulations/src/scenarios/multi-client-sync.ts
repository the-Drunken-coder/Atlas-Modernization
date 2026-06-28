import { isNotFoundError } from "../server/atlas.js";
import type { Scenario, ScenarioContext } from "../server/scenario.js";
import { jsonNumber } from "../shared/types.js";
import { isoNow, numberInput, point, positiveIntegerInput } from "./helpers.js";

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
    const clientCount = positiveIntegerInput(input, "clientCount");
    const writes = positiveIntegerInput(input, "writes");
    const settleMs = Math.max(numberInput(input, "settleMs"), MIN_SETTLE_MS);
    const readers: ScenarioContext["client"][] = [];
    try {
      for (let index = 0; index < clientCount; index++) {
        if (ctx.signal.aborted) throw new Error("Simulation cancelled");
        const client = ctx.newClient({ sync: "all", pollIntervalMs: SYNC_POLL_INTERVAL_MS });
        readers.push(client);
        await client.sync.start();
        const status = client.sync.status();
        ctx.log(`Sync client ${index + 1} started`, {
          running: status.running,
          healthy: status.healthy,
          degraded: status.degraded,
          lastVersion: jsonNumber(status.lastVersion)
        });
      }

      const ids: string[] = [];
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
      await Promise.all(readers.map(async (reader, readerIndex) => {
        const settleDeadline = Date.now() + settleMs;
        const seen = await waitForResources(ctx, reader, ids, settleDeadline);
        const readerSnapshot = await snapshotVersions(reader, ids, settleDeadline);
        const status = reader.sync.status();
        ctx.assert(`Client ${readerIndex + 1} saw writer resources`, seen === ids.length, `${seen}/${ids.length} resources visible`);
        ctx.assert(
          `Client ${readerIndex + 1} matched writer versions`,
          snapshotsMatch(readerSnapshot, writerSnapshot),
          `${readerSnapshot.length}/${writerSnapshot.length} versions matched`
        );
        ctx.assert(`Client ${readerIndex + 1} sync running`, status.running, status.running ? "running" : "stopped");
        ctx.assert(`Client ${readerIndex + 1} sync healthy`, status.healthy, status.healthy ? "healthy" : "degraded or recovering");
      }));
    } finally {
      for (const reader of readers) {
        try {
          reader.sync.stop();
        } catch (error) {
          ctx.log(`Failed to stop sync client: ${errorMessage(error)}`);
        }
      }
    }
  }
};

export default multiClientSync;

async function waitForResources(ctx: ScenarioContext, reader: ScenarioContext["client"], ids: string[], deadline: number): Promise<number> {
  let seen = await visibleCount(reader, ids, deadline);
  while (seen < ids.length && Date.now() < deadline) {
    await ctx.wait(Math.min(250, Math.max(1, deadline - Date.now())));
    seen = await visibleCount(reader, ids, deadline);
  }
  return seen;
}

async function snapshotVersions(reader: ScenarioContext["client"], ids: string[], deadline = Number.POSITIVE_INFINITY): Promise<Array<[string, number]>> {
  const snapshot = await Promise.all(ids.map((id) => readVersion(reader, id, deadline)));
  return snapshot.flatMap((version) => (version ? [version] : []));
}

function snapshotsMatch(left: Array<[string, number]>, right: Array<[string, number]>): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function visibleCount(reader: ScenarioContext["client"], ids: string[], deadline: number): Promise<number> {
  reader.sync.status();
  const visible = await Promise.all(ids.map(async (id) => (await readVersion(reader, id, deadline))?.[0] === id));
  return visible.filter(Boolean).length;
}

async function readVersion(reader: ScenarioContext["client"], id: string, deadline: number): Promise<[string, number] | undefined> {
  try {
    const entity = await withDeadline(() => reader.entities.get(id), deadline);
    return entity ? [entity.entity_id, entity.metadata.version] : undefined;
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
    return undefined;
  }
}

async function withDeadline<T>(operation: () => Promise<T>, deadline: number): Promise<T | undefined> {
  if (!Number.isFinite(deadline)) return await operation();
  const remaining = deadline - Date.now();
  if (remaining <= 0) return undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<undefined>((resolve) => {
        timeout = setTimeout(() => resolve(undefined), remaining);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
