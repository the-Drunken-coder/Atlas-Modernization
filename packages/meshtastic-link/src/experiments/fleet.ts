import { type ExperimentMessage, parseExperiment } from "./config.js";

/** Five minutes of telemetry and round-robin commands, followed by a 30 s drain. */
export function createGatewayFleetExperiment(
  options: { synchronizedTelemetry?: boolean; commandsPerAsset?: boolean } = {}
) {
  const assets = ["asset-a", "asset-b", "asset-c"];
  const messages: ExperimentMessage[] = [];
  for (let at = 0; at < 300_000; at += 5_000) {
    const timestamp = new Date(Date.parse("2026-09-05T12:00:00Z") + at).toISOString();
    for (const [assetIndex, asset] of assets.entries()) {
      const sampleAt = at + (options.synchronizedTelemetry ? 0 : assetIndex * 1600);
      const sampleTime = new Date(Date.parse("2026-09-05T12:00:00Z") + sampleAt).toISOString();
      const id = `telemetry-${at / 1000}`;
      messages.push({
        id,
        source: asset,
        receivers: ["gateway"],
        at_ms: sampleAt,
        deadline_ms: 30_000,
        expect: "delivered",
        message: {
          type: "state",
          resource_type: "entity",
          observation_time: sampleTime,
          path: "field",
          confirmation: "awaiting_core",
          operation_id: id,
          resource: {
            entity_id: asset,
            alias: asset,
            entity_type: "asset",
            subtype: null,
            components: { geometry: { type: "Point", coordinates: [-71.8 + at / 1e9, 42.2, 100] } },
            metadata: { created_at: "2026-09-05T12:00:00Z", updated_at: sampleTime, version: at / 5000 + 1 }
          }
        }
      });
    }
    if (at % 15_000 !== 0) continue;
    const commandAssets = options.commandsPerAsset ? assets : [assets[(at / 15_000) % assets.length]];
    for (const asset of commandAssets) {
      if (!asset) throw new Error("Missing command destination");
      const suffix = options.commandsPerAsset ? `${at / 1000}-${asset}` : `${at / 1000}`;
      const id = `command-${suffix}`;
      messages.push({
        id,
        source: "gateway",
        destination: asset,
        receivers: [asset],
        at_ms: at,
        deadline_ms: 15_000,
        expect: "delivered",
        message: {
          type: "task_delivery",
          delivery: "assignment",
          task: {
            task_id: id,
            asset_id: asset,
            command: "atlas.survey",
            input: {},
            status: "pending",
            created_at: timestamp,
            updated_at: timestamp
          }
        },
        response: {
          id: `result-${suffix}`,
          deadline_ms: 30_000,
          message: {
            type: "task_report",
            task_id: id,
            runtime_id: `lab-${asset}`,
            observation_time: timestamp,
            action: "complete",
            body: { output: { surveyed: true } }
          }
        }
      });
    }
  }
  return parseExperiment({
    schema_version: 1,
    name: "gateway-fleet",
    lab_url: "http://127.0.0.1:8080",
    preset: "SHORT_FAST",
    topology: "line",
    settle_ms: 2000,
    duration_ms: 330_000,
    max_payload_bytes: 227,
    frame_encoding: "deflate-v1",
    retry_jitter_ms: 1000,
    nodes: [
      { id: "asset-a", role: "asset", port: 45002 },
      { id: "gateway", role: "gateway", port: 45001 },
      { id: "asset-b", role: "asset", port: 45003 },
      { id: "asset-c", role: "asset", port: 45004 }
    ],
    messages,
    faults: [],
    link_changes: []
  });
}
