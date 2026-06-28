import { isNotFoundError } from "../server/atlas.js";
import type { Scenario, ScenarioContext } from "../server/scenario.js";
import { isoNow, numberInput, point } from "./helpers.js";

const SYNC_POLL_INTERVAL_MS = 500;

const multiClientSync: Scenario = {
  id: "multi-client-sync",
  name: "Multi-client sync",
  summary: "Runs multiple SDK sync clients and checks whether they converge after writes.",
  acceptsJson: false,
  inputFields: [
    { key: "clientCount", label: "Client count", type: "number", defaultValue: 2, min: 1, max: 8, step: 1 },
    { key: "writes", label: "Writes", type: "number", defaultValue: 3, min: 1, max: 20, step: 1 },
    { key: "settleMs", label: "Settle ms", type: "number", defaultValue: 1000, min: SYNC_POLL_INTERVAL_MS, max: 10000, step: 50 }
  ],
  async run(ctx, input) {
    const clientCount = numberInput(input, "clientCount");
    const writes = numberInput(input, "writes");
    const settleMs = numberInput(input, "settleMs");
    const readers: ScenarioContext["client"][] = [];
    try {
      for (let index = 0; index < clientCount; index++) {
        if (ctx.signal.aborted) throw new Error("Simulation cancelled");
        const client = ctx.newClient({ sync: "all", pollIntervalMs: SYNC_POLL_INTERVAL_MS });
        readers.push(client);
        await client.sync.start();
        ctx.log(`Sync client ${index + 1} started`, client.sync.status());
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
      const settleDeadline = Date.now() + settleMs;
      for (const [readerIndex, reader] of readers.entries()) {
        const seen = await waitForResources(ctx, reader, ids, settleDeadline);
        const readerSnapshot = await snapshotVersions(reader, ids);
        const status = reader.sync.status();
        ctx.assert(`Client ${readerIndex + 1} saw writer resources`, seen === ids.length, `${seen}/${ids.length} resources visible`);
        ctx.assert(
          `Client ${readerIndex + 1} matched writer versions`,
          snapshotsMatch(readerSnapshot, writerSnapshot),
          `${readerSnapshot.length}/${writerSnapshot.length} versions matched`
        );
        ctx.assert(`Client ${readerIndex + 1} sync running`, status.running, status.running ? "running" : "stopped");
        ctx.assert(`Client ${readerIndex + 1} sync healthy`, status.healthy, status.healthy ? "healthy" : "degraded or recovering");
      }
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
  let seen = await visibleCount(reader, ids);
  while (seen < ids.length && Date.now() < deadline) {
    await ctx.wait(Math.min(250, Math.max(1, deadline - Date.now())));
    seen = await visibleCount(reader, ids);
  }
  return seen;
}

async function snapshotVersions(reader: ScenarioContext["client"], ids: string[]): Promise<Array<[string, number]>> {
  const snapshot: Array<[string, number]> = [];
  for (const id of ids) {
    try {
      const entity = await reader.entities.get(id);
      snapshot.push([entity.entity_id, entity.metadata.version]);
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
    }
  }
  return snapshot;
}

function snapshotsMatch(left: Array<[string, number]>, right: Array<[string, number]>): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function visibleCount(reader: ScenarioContext["client"], ids: string[]): Promise<number> {
  reader.sync.status();
  let seen = 0;
  for (const id of ids) {
    try {
      const entity = await reader.entities.get(id);
      if (entity.entity_id === id) seen += 1;
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
      // Missing resources are expected while sync is still converging.
    }
  }
  return seen;
}
