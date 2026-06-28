import { isNotFoundError } from "../server/atlas.js";
import type { Scenario, ScenarioContext } from "../server/scenario.js";
import { isoNow, numberInput, point } from "./helpers.js";

const multiClientSync: Scenario = {
  id: "multi-client-sync",
  name: "Multi-client sync",
  summary: "Runs multiple SDK sync clients and checks whether they converge after writes.",
  acceptsJson: false,
  inputFields: [
    { key: "clientCount", label: "Client count", type: "number", defaultValue: 2, min: 1, max: 8, step: 1 },
    { key: "writes", label: "Writes", type: "number", defaultValue: 3, min: 1, max: 20, step: 1 },
    { key: "settleMs", label: "Settle ms", type: "number", defaultValue: 500, min: 0, max: 10000, step: 50 }
  ],
  async run(ctx, input) {
    const clientCount = numberInput(input, "clientCount");
    const writes = numberInput(input, "writes");
    const settleMs = numberInput(input, "settleMs");
    const readers = Array.from({ length: clientCount }, () => ctx.newClient({ sync: "all", pollIntervalMs: 500 }));
    for (const [index, client] of readers.entries()) {
      await client.sync.start();
      ctx.log(`Sync client ${index + 1} started`, client.sync.status());
    }

    const ids: string[] = [];
    for (let index = 0; index < writes; index++) {
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
      ctx.log(`Writer created ${id}`);
    }

    for (const [readerIndex, reader] of readers.entries()) {
      const seen = await waitForResources(ctx, reader, ids, Math.max(settleMs, 1000));
      const status = reader.sync.status();
      ctx.assert(`Client ${readerIndex + 1} saw writer resources`, seen === ids.length, `${seen}/${ids.length} resources visible`);
      ctx.assert(`Client ${readerIndex + 1} sync running`, status.running, status.running ? "running" : "stopped");
      ctx.assert(`Client ${readerIndex + 1} sync healthy`, status.healthy, status.healthy ? "healthy" : "degraded or recovering");
    }
  }
};

export default multiClientSync;

async function waitForResources(ctx: ScenarioContext, reader: ScenarioContext["client"], ids: string[], timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let seen = await visibleCount(reader, ids);
  while (seen < ids.length && Date.now() < deadline) {
    await ctx.wait(Math.min(250, Math.max(1, deadline - Date.now())));
    seen = await visibleCount(reader, ids);
  }
  return seen;
}

async function visibleCount(reader: ScenarioContext["client"], ids: string[]): Promise<number> {
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
