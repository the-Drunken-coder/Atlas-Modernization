import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import type { JSONValue } from "@the-drunken-coder/atlas-sdk";
import {
  deserializeLinkMessage,
  LINK_PROTOCOL_REVISION,
  messagePriority,
  serializeLinkMessage
} from "../src/contract.js";
import { type ExperimentConfig, parseExperiment } from "../src/experiments/config.js";
import { createGatewayFleetExperiment } from "../src/experiments/fleet.js";
import { runSimulatedExperiment } from "../src/experiments/simulated.js";
import { experimentSourceIdentity } from "../src/experiments/source.js";
import { decodeFrame, type FrameEncoding, type FrameIdentity, fragmentPayload } from "../src/frame.js";
import { decodeMessagePayload } from "../src/message-codec.js";
import { positionPublication } from "../src/test-fixtures.js";
import type { LinkMessage, LinkNode } from "../src/types.js";

const MAX_FRAME_BYTES = 227;
const MESSAGE_V1_MARKER = 0xa6;
const COMMANDS_PER_ASSET = 20;
const [outputPath, seedCountText = "10", requestedCandidate = "message-v2"] = process.argv.slice(2);
const seedCount = Number(seedCountText);
if (
  !outputPath ||
  process.argv.length > 5 ||
  !Number.isSafeInteger(seedCount) ||
  seedCount < 0 ||
  seedCount > 100 ||
  (requestedCandidate !== "message-v1" && requestedCandidate !== "message-v2")
) {
  throw new Error(
    "Usage: tsx scripts/compare-message-compression.ts <new-output.json> [seed-count: 0–100] [message-v1|message-v2]"
  );
}

const candidateEncoding: FrameEncoding = requestedCandidate;
const baselineEncoding: FrameEncoding = candidateEncoding === "message-v2" ? "message-v1" : "binary-v1";
const source = await experimentSourceIdentity();
const fixtureComparison = compareFixtures();
const profiles = [
  { name: "normal", config: createGatewayFleetExperiment() },
  { name: "commands-per-asset", config: createGatewayFleetExperiment({ commandsPerAsset: true }) },
  { name: "rich-telemetry", config: richTelemetryFleet() }
] as const;
const fleetRuns: FleetRun[] = [];
for (const profile of profiles) {
  for (const preset of ["SHORT_FAST", "SHORT_TURBO"] as const) {
    for (let seed = 1; seed <= seedCount; seed++) {
      for (const frame_encoding of [baselineEncoding, candidateEncoding]) {
        const result = await runSimulatedExperiment({ ...profile.config, preset, frame_encoding }, seed);
        const run = summarizeFleetRun(profile.name, preset, seed, frame_encoding, result);
        fleetRuns.push(run);
        console.log(
          JSON.stringify({
            profile: run.profile,
            preset: run.preset,
            seed: run.seed,
            frame_encoding: run.frame_encoding,
            exchanges_complete: run.exchanges_complete,
            state_delivery_rate: run.state_delivery_rate,
            transmissions: run.transmissions,
            airtime_ms: run.modeled_airtime_ms
          })
        );
      }
    }
  }
}

await writeFile(
  outputPath,
  `${JSON.stringify(
    {
      schema_version: 2,
      source,
      scope:
        "Lossless framing comparison over valid Atlas messages and the deterministic modeled fleet. Modeled RF only; no native radios.",
      parameters: {
        max_frame_bytes: MAX_FRAME_BYTES,
        baseline_encoding: baselineEncoding,
        candidate_encoding: candidateEncoding,
        seed_count: seedCount,
        commands_per_asset: COMMANDS_PER_ASSET
      },
      fixtures: fixtureComparison,
      fleet_summary: summarizeFleetRuns(fleetRuns),
      fleet_runs: fleetRuns
    },
    null,
    2
  )}\n`,
  { flag: "wx", mode: 0o600 }
);

type CompressionMeasurement = {
  payload_sha256: string;
  payload_bytes: number;
  frame_count: number;
  framed_bytes: number;
  reassembled_payload_bytes: number;
  decoded_payload_bytes: number;
  encode_elapsed_ms: number;
  decode_verify_elapsed_ms: number;
  markers: string[];
  compression_method: string;
  value_representation: string;
  used_legacy_frame: boolean;
};

type CompressionCase = {
  name: string;
  message: LinkMessage;
  source: LinkNode;
  destination?: LinkNode;
};

type FleetRun = {
  profile: string;
  preset: "SHORT_FAST" | "SHORT_TURBO";
  seed: number;
  frame_encoding: FrameEncoding;
  passed: boolean;
  exchanges_complete: number;
  exchanges_total: number;
  confirmed_messages: number;
  state_scheduled: number;
  state_delivered: number;
  state_delivery_rate: number | null;
  round_trip_ms: number[];
  latency_percentiles_ms: { p50: number | null; p95: number | null; max: number | null };
  transmissions: number;
  transmitted_bytes: number;
  modeled_airtime_ms: number;
  delivered_packets: number;
  lost_packets: number;
  collided_packets: number;
  host_packet_admissions: number;
  host_bytes: number;
  freshness: {
    source: string;
    receiver: string;
    active_publication_window_ms: number;
    drain_window_ms: number | null;
    known_age_window_ms: number;
    time_weighted_age_p50_ms: number | null;
    time_weighted_age_p95_ms: number | null;
    time_weighted_age_max_ms: number | null;
    longest_gap_without_fresher_accepted_sample_ms: number | null;
    unknown_before_initial_sample_ms: number;
  }[];
};

function compareFixtures() {
  return compressionCases().map((fixture) => {
    const before = measureFixture(fixture, baselineEncoding);
    const after = measureFixture(fixture, candidateEncoding);
    if (after.frame_count > before.frame_count || after.framed_bytes > before.framed_bytes)
      throw new Error(`Compression increased wire cost for ${fixture.name}`);
    return {
      name: fixture.name,
      payload_bytes: before.payload_bytes,
      before,
      after,
      savings_bytes: before.framed_bytes - after.framed_bytes,
      savings_percent: (100 * (before.framed_bytes - after.framed_bytes)) / before.framed_bytes
    };
  });
}

function measureFixture(fixture: CompressionCase, encoding: FrameEncoding): CompressionMeasurement {
  const payload = serializeLinkMessage(fixture.message);
  const identity: FrameIdentity = {
    revision: LINK_PROTOCOL_REVISION,
    message_type: fixture.message.type,
    source: fixture.source,
    ...(fixture.destination === undefined ? {} : { destination: fixture.destination }),
    source_generation: 1,
    service_session: "compression-fixtures",
    source_sequence: 1,
    operation_id: `compression-${fixture.name}`,
    message_id: `message-${fixture.name}`,
    priority: messagePriority(fixture.message)
  };
  const encodeStarted = performance.now();
  const frames = fragmentPayload(payload, identity, MAX_FRAME_BYTES, encoding);
  const encodeSamples = [performance.now() - encodeStarted];
  for (let sample = 1; sample < 5; sample++) {
    const repeatStarted = performance.now();
    fragmentPayload(payload, identity, MAX_FRAME_BYTES, encoding);
    encodeSamples.push(performance.now() - repeatStarted);
  }
  const encodeCpuMs = median(encodeSamples);
  const decodeStarted = performance.now();
  const decodedFrames = frames.map(decodeFrame).sort((left, right) => left.chunk_index - right.chunk_index);
  if (
    decodedFrames.length !== frames.length ||
    decodedFrames.some(
      (frame, index) =>
        frame.chunk_index !== index ||
        frame.chunk_count !== frames.length ||
        frame.message_type !== identity.message_type ||
        frame.operation_id !== identity.operation_id
    )
  ) {
    throw new Error(`Incomplete ${encoding} reassembly for ${fixture.name}`);
  }
  const reassembled = Buffer.concat(decodedFrames.map((frame) => Buffer.from(frame.payload)));
  const usedBinaryV1Fallback = !frames.some((frame) => frame[0] === MESSAGE_V1_MARKER || frame[0] === 0xa7);
  const decodedPayload = decodeMessagePayload(reassembled);
  const decodedMessage = deserializeLinkMessage(decodedPayload);
  const canonicalDecoded = serializeLinkMessage(decodedMessage);
  if (!Buffer.from(canonicalDecoded).equals(Buffer.from(payload))) {
    throw new Error(`Canonical message changed after ${encoding} reassembly for ${fixture.name}`);
  }
  const decodeVerifyCpuMs = performance.now() - decodeStarted;
  const mode = frames[0]?.[0] === 0xa7 ? frames[0][1] : reassembled[0] === 0xb3 ? reassembled[2] : undefined;
  return {
    payload_sha256: createHash("sha256").update(payload).digest("hex"),
    payload_bytes: payload.byteLength,
    frame_count: frames.length,
    framed_bytes: frames.reduce((total, frame) => total + frame.byteLength, 0),
    reassembled_payload_bytes: reassembled.byteLength,
    decoded_payload_bytes: decodedPayload.byteLength,
    encode_elapsed_ms: encodeCpuMs,
    decode_verify_elapsed_ms: decodeVerifyCpuMs,
    markers: [...new Set(frames.map((frame) => `0x${(frame[0] ?? 0).toString(16).padStart(2, "0")}`))],
    compression_method:
      mode === undefined ? "previous" : (["deflate-9", "brotli-4", "zstd-9"][Math.floor(mode / 3)] ?? "unknown"),
    value_representation:
      mode === undefined ? "previous" : (["original", "binary-v1", "compact-v1"][mode % 3] ?? "unknown"),
    used_legacy_frame: usedBinaryV1Fallback
  };
}

function compressionCases(): CompressionCase[] {
  const telemetry = positionPublication(1);
  const richEntity = richEntityMessage();
  const smallTask = taskDelivery("task-small", { area: "north" });
  const largeTask = taskDelivery("task-large", {
    route: Array.from({ length: 28 }, (_, index) => ({
      latitude: 42.2 + index / 10_000,
      longitude: -71.8 - index / 10_000,
      radius_m: 15
    })),
    sensor_plan: Array.from({ length: 16 }, (_, index) => ({
      sensor_id: `sensor-${index.toString().padStart(2, "0")}`,
      type: "temperature",
      sample_period_s: 5
    }))
  });
  const smallReport = taskReport("task-small");
  const largeObject = objectContent();
  const incompressibleObject = incompressibleObjectContent();
  return [
    { name: "small-telemetry", message: telemetry, source: asset("asset-a") },
    { name: "small-task", message: smallTask, source: gateway(), destination: asset("asset-a") },
    { name: "small-report", message: smallReport, source: asset("asset-a"), destination: gateway() },
    { name: "large-entity", message: richEntity, source: asset("asset-a") },
    { name: "large-task", message: largeTask, source: gateway(), destination: asset("asset-b") },
    { name: "large-object-content", message: largeObject, source: gateway(), destination: asset("asset-a") },
    {
      name: "large-object-content-incompressible",
      message: incompressibleObject,
      source: gateway(),
      destination: asset("asset-a")
    }
  ];
}

function richEntityMessage(): LinkMessage {
  const base = positionPublication(2);
  return {
    ...base,
    operation_id: "large-entity",
    resource: {
      ...base.resource,
      entity_id: "asset-large",
      components: {
        ...base.resource.components,
        telemetry: {
          altitude_m: 110,
          heading_deg: 82,
          latitude: 42.2,
          longitude: -71.8,
          speed_m_s: 4.5
        },
        sensor_refs: Array.from({ length: 16 }, (_, index) => ({
          sensor_id: `sensor-${index.toString().padStart(2, "0")}`,
          type: "environment",
          horizontal_fov: 90,
          horizontal_orientation: index * 22.5,
          vertical_fov: 45,
          vertical_orientation: index
        })),
        custom_sensor_readings: Array.from({ length: 96 }, (_, index) => ({
          sensor_id: `sensor-${index % 16}`,
          sequence: index,
          temperature_c: 20 + (index % 7) * 0.25,
          humidity_percent: 40 + (index % 11),
          sample_time: "2026-09-05T12:00:00Z"
        }))
      },
      extra: {
        sensor_batch: Array.from({ length: 16 }, (_, index) => ({
          key: `sensor-${index.toString().padStart(2, "0")}`,
          calibration: "factory-default",
          channel: index
        }))
      }
    }
  };
}

function taskDelivery(taskID: string, input: JSONValue): LinkMessage {
  return {
    type: "task_delivery",
    delivery: "assignment",
    task: {
      task_id: taskID,
      asset_id: "asset-a",
      command: "atlas.survey",
      input,
      status: "pending",
      created_at: "2026-09-05T12:00:00Z",
      updated_at: "2026-09-05T12:00:00Z"
    }
  };
}

function taskReport(taskID: string): LinkMessage {
  return {
    type: "task_report",
    task_id: taskID,
    runtime_id: "runtime-asset-a",
    observation_time: "2026-09-05T12:00:05Z",
    action: "complete",
    body: { output: { surveyed: true } }
  };
}

function objectContent(): LinkMessage {
  const content = Buffer.from(
    Array.from(
      { length: 80 },
      (_, index) =>
        `sensor-${index.toString().padStart(2, "0")}|temperature|sample-period=5|calibration=factory-default|value=${20 + index / 10}`
    ).join("\n")
  );
  return {
    type: "object_content",
    request_id: "object-request-large",
    object_id: "object-large",
    content_base64: content.toString("base64"),
    sha256: `sha256:${createHash("sha256").update(content).digest("hex")}`
  };
}

function incompressibleObjectContent(): LinkMessage {
  const blocks = Array.from({ length: 256 }, (_, index) =>
    createHash("sha256").update(`object-content-incompressible:${index}`).digest()
  );
  const content = Buffer.concat(blocks);
  return {
    type: "object_content",
    request_id: "object-request-incompressible",
    object_id: "object-incompressible",
    content_base64: content.toString("base64"),
    sha256: `sha256:${createHash("sha256").update(content).digest("hex")}`
  };
}

function richTelemetryFleet(): ExperimentConfig {
  const base = createGatewayFleetExperiment();
  return parseExperiment({
    ...base,
    name: "gateway-fleet-rich",
    messages: base.messages.map((message) => {
      const state = message.message;
      if (state.type !== "state" || state.deleted === true || state.resource_type !== "entity") return message;
      return {
        ...message,
        message: {
          ...state,
          resource: {
            ...state.resource,
            components: {
              ...state.resource.components,
              custom_sensor_readings: Array.from({ length: 6 }, (_, index) => ({
                sensor_id: `sensor-${index}`,
                sequence: index,
                temperature_c: 20 + (index % 7) * 0.25,
                humidity_percent: 40 + (index % 11),
                sample_time: state.observation_time
              }))
            }
          }
        }
      };
    })
  });
}

function summarizeFleetRun(
  profile: string,
  preset: "SHORT_FAST" | "SHORT_TURBO",
  seed: number,
  frame_encoding: FrameEncoding,
  result: Awaited<ReturnType<typeof runSimulatedExperiment>>
): FleetRun {
  const exchanges = result.outcomes.exchanges;
  const roundTrips = exchanges.flatMap((exchange) =>
    exchange.round_trip_ms === null || !Number.isFinite(exchange.round_trip_ms) ? [] : [exchange.round_trip_ms]
  );
  const stateReceivers = result.outcomes.telemetry.flatMap((telemetry) =>
    telemetry.receivers.map((receiver) => ({ source: telemetry.source, ...receiver }))
  );
  const stateScheduled = stateReceivers.reduce((total, receiver) => total + receiver.scheduled, 0);
  const stateDelivered = stateReceivers.reduce((total, receiver) => total + receiver.delivered, 0);
  return {
    profile,
    preset,
    seed,
    frame_encoding,
    passed: result.passed,
    exchanges_complete: exchanges.filter((exchange) => exchange.completed_within_deadline).length,
    exchanges_total: exchanges.length,
    confirmed_messages: result.outcomes.summary.confirmed_messages,
    state_scheduled: stateScheduled,
    state_delivered: stateDelivered,
    state_delivery_rate: stateScheduled === 0 ? null : stateDelivered / stateScheduled,
    round_trip_ms: roundTrips,
    latency_percentiles_ms: percentiles(roundTrips),
    transmissions: result.network.mesh_transmissions,
    transmitted_bytes: result.network.transmitted_bytes,
    modeled_airtime_ms: result.network.modeled_airtime_ms,
    delivered_packets: result.network.delivered_packets,
    lost_packets: result.network.lost_packets,
    collided_packets: result.network.collided_packets,
    host_packet_admissions: result.outcomes.messages.reduce((total, message) => total + message.packet_admissions, 0),
    host_bytes: result.outcomes.messages.reduce((total, message) => total + message.accepted_packet_bytes, 0),
    freshness: stateReceivers.map((receiver) => ({
      source: receiver.source,
      receiver: receiver.receiver,
      active_publication_window_ms: receiver.active_publication_window_ms,
      drain_window_ms: receiver.drain_window_ms,
      known_age_window_ms: receiver.known_age_window_ms,
      time_weighted_age_p50_ms: receiver.time_weighted_age_p50_ms,
      time_weighted_age_p95_ms: receiver.time_weighted_age_p95_ms,
      time_weighted_age_max_ms: receiver.time_weighted_age_max_ms,
      longest_gap_without_fresher_accepted_sample_ms: receiver.longest_gap_without_fresher_accepted_sample_ms,
      unknown_before_initial_sample_ms: receiver.unknown_before_initial_sample_ms
    }))
  };
}

function summarizeFleetRuns(runs: FleetRun[]) {
  const groups = new Map<string, FleetRun[]>();
  for (const run of runs) {
    const key = `${run.profile}:${run.preset}:${run.frame_encoding}`;
    groups.set(key, [...(groups.get(key) ?? []), run]);
  }
  return [...groups.entries()].map(([key, grouped]) => ({
    key,
    runs: grouped.length,
    exchanges_complete_mean: mean(grouped.map((run) => run.exchanges_complete)),
    state_delivery_rate_mean: mean(
      grouped.flatMap((run) => (run.state_delivery_rate === null ? [] : [run.state_delivery_rate]))
    ),
    latency_pooled_ms: percentiles(grouped.flatMap((run) => run.round_trip_ms)),
    latency_p50_mean_ms: mean(
      grouped.flatMap((run) => (run.latency_percentiles_ms.p50 === null ? [] : [run.latency_percentiles_ms.p50]))
    ),
    latency_p95_mean_ms: mean(
      grouped.flatMap((run) => (run.latency_percentiles_ms.p95 === null ? [] : [run.latency_percentiles_ms.p95]))
    ),
    transmissions_mean: mean(grouped.map((run) => run.transmissions)),
    host_bytes_mean: mean(grouped.map((run) => run.host_bytes)),
    modeled_airtime_mean_ms: mean(grouped.map((run) => run.modeled_airtime_ms))
  }));
}

function percentiles(values: number[]): { p50: number | null; p95: number | null; max: number | null } {
  if (values.length === 0) return { p50: null, p95: null, max: null };
  const sorted = [...values].sort((left, right) => left - right);
  const at = (percentile: number) =>
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * percentile) - 1))] ?? null;
  return { p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] ?? null };
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function mean(values: number[]): number | null {
  return values.length === 0 ? null : values.reduce((total, value) => total + value, 0) / values.length;
}

function asset(id: string): LinkNode {
  return { role: "asset", id };
}

function gateway(): LinkNode {
  return { role: "gateway", id: "gateway" };
}
