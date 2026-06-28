import type { Scenario } from "../server/scenario.js";
import { isoNow, jsonObject, numberInput, point } from "./helpers.js";

const movingAssets: Scenario = {
  id: "moving-assets",
  name: "Moving assets",
  summary: "Creates assets and updates their telemetry through Atlas check-ins.",
  acceptsJson: true,
  inputFields: [
    { key: "assetCount", label: "Asset count", type: "number", defaultValue: 4, min: 1, max: 25, step: 1 },
    { key: "ticks", label: "Ticks", type: "number", defaultValue: 5, min: 1, max: 100, step: 1 },
    { key: "tickMs", label: "Tick ms", type: "number", defaultValue: 250, min: 0, max: 10000, step: 50 },
    { key: "startLatitude", label: "Start latitude", type: "number", defaultValue: 38.8895, min: -90, max: 89.9265, step: 0.0001 },
    { key: "startLongitude", label: "Start longitude", type: "number", defaultValue: -77.0353, min: -180, max: 179.8728, step: 0.0001 }
  ],
  async run(ctx, input) {
    const assetCount = numberInput(input, "assetCount");
    const ticks = numberInput(input, "ticks");
    const tickMs = numberInput(input, "tickMs");
    const startLatitude = numberInput(input, "startLatitude");
    const startLongitude = numberInput(input, "startLongitude");
    const extra = jsonObject(input);
    const assetIds: string[] = [];

    for (let index = 0; index < assetCount; index++) {
      if (ctx.signal.aborted) throw new Error("Simulation cancelled");
      const id = ctx.id(`asset-${index + 1}`);
      assetIds.push(id);
      await ctx.createEntity({
        entity_id: id,
        entity_type: "asset",
        alias: `Sim asset ${index + 1}`,
        subtype: "simulated",
        components: {
          geometry: point(startLongitude + index * 0.002, startLatitude + index * 0.001),
          telemetry: {
            latitude: startLatitude + index * 0.001,
            longitude: startLongitude + index * 0.002,
            altitude_m: 120 + index * 5,
            speed_m_s: 12,
            heading_deg: 45,
            last_update: isoNow()
          },
          heartbeat: { last_seen: isoNow() },
          communications: { link_state: "connected" },
          status: { value: "moving", last_update: isoNow() },
          health: { battery_percent: Math.max(10, 95 - index * 3) },
          task_catalog: { supported_tasks: ["move", "observe"] },
          custom_simulation: { ...extra, run_id: ctx.runId }
        }
      });
      if (ctx.signal.aborted) throw new Error("Simulation cancelled");
    }
    ctx.log(`Created ${assetIds.length} assets`);

    for (let tick = 0; tick < ticks; tick++) {
      for (const [index, id] of assetIds.entries()) {
        if (ctx.signal.aborted) throw new Error("Simulation cancelled");
        const latitude = startLatitude + index * 0.001 + tick * 0.0005;
        const longitude = startLongitude + index * 0.002 + tick * 0.0008;
        await ctx.client.entities.checkIn(id, {
          status: "moving",
          telemetry: {
            latitude,
            longitude,
            altitude_m: 120 + index * 5,
            speed_m_s: 12 + tick,
            heading_deg: (45 + tick * 7) % 360
          },
          components: {
            heartbeat: { last_seen: isoNow() },
            status: { value: "moving", last_update: isoNow() },
            geometry: point(longitude, latitude)
          }
        });
      }
      ctx.log(`Telemetry tick ${tick + 1}/${ticks}`);
      if (tick < ticks - 1) await ctx.wait(tickMs);
    }

    const persistedAssets = await Promise.all(assetIds.map((id) => ctx.client.entities.get(id)));
    const finalSpeed = 12 + ticks - 1;
    ctx.assert("Assets persisted", persistedAssets.length === assetCount, `${persistedAssets.length}/${assetCount} assets persisted`);
    ctx.assert(
      "Telemetry persisted",
      persistedAssets.every((asset) => (asset.components.telemetry as { speed_m_s?: number } | undefined)?.speed_m_s === finalSpeed),
      `expected final speed ${finalSpeed}`
    );
  }
};

export default movingAssets;
