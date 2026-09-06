import { createHash, randomBytes } from "node:crypto";
import { open, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { canonicalJSON } from "../canonical-json.js";
import { RealClock } from "../clock.js";
import { SharedPicture } from "../picture.js";
import { MeshtasticSerialRadio } from "../radio.js";
import { LinkTransport } from "../transport.js";
import { type ExperimentConfig, labScenario, parseExperiment, record } from "./config.js";
import { FaultRadio } from "./fault-radio.js";
import { LabClient, LabEvidence } from "./lab.js";
import { openLabTCP } from "./tcp.js";
import { ExperimentWorkload } from "./workload.js";

type ExperimentRuntime = {
  transport: LinkTransport;
  radio: FaultRadio;
  device: MeshtasticSerialRadio;
  picture: SharedPicture;
};

/** Own the lab only while stopped; always release radios and restore the saved scenario. */
export async function runLabExperiment(input: ExperimentConfig, signal: AbortSignal = new AbortController().signal) {
  const config = parseExperiment(input);
  const lockPath = join(
    tmpdir(),
    `atlas-meshtastic-lab-${createHash("sha256").update(new URL(config.lab_url).origin).digest("hex").slice(0, 16)}.lock`
  );
  const lock = await open(lockPath, "wx", 0o600).catch((error) => {
    throw new Error(`Cannot reserve Meshtastic Lab; another Atlas run may own it. Lock: ${lockPath}`, { cause: error });
  });
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, config: config.name }));
    return await runReservedExperiment(config, signal);
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

async function runReservedExperiment(config: ExperimentConfig, signal: AbortSignal) {
  const lab = new LabClient(config.lab_url);
  const state = await lab.request("/api/state");
  if (!record(state) || state.state !== "STOPPED")
    throw new Error("Meshtastic Lab must be stopped and exclusively available before an Atlas experiment");
  const previousScenario = await lab.request("/api/scenario");
  const provenance = await lab.request("/api/capabilities");
  if (!record(provenance) || provenance.collisionAvailable !== true || provenance.provenanceAvailable !== true)
    throw new Error("Native collisions and firmware provenance are required");
  const evidence = new LabEvidence(lab);
  const runtimes = new Map<string, ExperimentRuntime>();
  const errors: string[] = [];
  const changes: { scheduled_at_ms: number; applied_at_ms: number; from: string; to: string; enabled: boolean }[] = [];
  let startedAt: number | null = null;
  let ownsLab = false;
  let restored = false;
  let observedThroughMs = -1;
  let completedObservationWindow = false;
  const now = () => (startedAt === null ? -1 : performance.now() - startedAt);
  const workload = new ExperimentWorkload(config, now, (message) => {
    const runtime = runtimes.get(message.source);
    if (!runtime) throw new Error(`Missing source ${message.source}`);
    const destination = config.nodes.find((node) => node.id === message.destination);
    return runtime.transport.submit(message.message, {
      operationID: message.id,
      ...(destination === undefined ? {} : { destination: { role: destination.role, id: destination.id } })
    });
  });
  const clock = new RealClock((error) => errors.push(String(error)));
  const startedUTC = new Date().toISOString();
  try {
    signal.throwIfAborted();
    // Mark ownership before a mutation whose HTTP response could be lost.
    ownsLab = true;
    await lab.request("/api/scenario", "PUT", labScenario(config));
    await lab.request("/api/simulation/start", "POST");
    await lab.waitForState("RUNNING", signal);
    for (const node of config.nodes) {
      signal.throwIfAborted();
      const device = await MeshtasticSerialRadio.openTransport(() => openLabTCP(node.port));
      const radio = new FaultRadio(device, node.id, config.faults, now, config.max_payload_bytes);
      const picture = new SharedPicture(`experiment-${node.id}`);
      const transport = new LinkTransport({
        node: { role: node.role, id: node.id },
        sourceGeneration: 1,
        serviceSession: randomBytes(4).toString("hex"),
        radio,
        picture,
        clock,
        retryJitterMs: config.retry_jitter_ms ?? 0,
        frameEncoding: config.frame_encoding ?? "canonical-json",
        adaptiveRetries: config.adaptive_retries ?? false,
        stateDeltas: config.state_deltas ?? false,
        privateChannel: 0
      });
      runtimes.set(node.id, { transport, radio, device, picture });
      transport.onEvent((event) => {
        if (event.type === "link_error") errors.push(`${node.id}: ${event.reason}`);
        workload.observe(
          node.id,
          event,
          (id) => transport.settleInbound(id, true),
          (id, response) => {
            if (response.message.type !== "task_report" || !response.destination) return undefined;
            const result = transport.settleInboundWithTaskReport(
              id,
              response.message,
              { role: "gateway", id: response.destination },
              response.id
            );
            return result.accepted ? result.report : undefined;
          }
        );
      });
    }
    await delay(config.settle_ms, undefined, { signal });
    await evidence.begin();
    startedAt = performance.now();
    const schedule = [
      ...config.messages.map((message) => ({
        at: message.at_ms,
        execute: async () => {
          workload.submit(message);
        }
      })),
      ...config.link_changes.map((change) => ({
        at: change.at_ms,
        execute: async () => {
          await lab.request("/api/links", "PUT", {
            from: change.from,
            to: change.to,
            enabled: change.enabled,
            rssiDbm: -85,
            snrDb: 8
          });
          changes.push({
            scheduled_at_ms: change.at_ms,
            applied_at_ms: now(),
            from: change.from,
            to: change.to,
            enabled: change.enabled
          });
        }
      }))
    ].sort((a, b) => a.at - b.at);
    let next = 0;
    let nextEvidence = 0;
    while (now() < config.duration_ms) {
      signal.throwIfAborted();
      for (let action = schedule[next]; action && action.at <= now(); action = schedule[next]) {
        await action.execute();
        next++;
      }
      if (now() >= nextEvidence) {
        await evidence.collect();
        const live = await lab.request("/api/state");
        if (!record(live) || live.state !== "RUNNING")
          throw new Error(`Lab stopped during experiment: ${JSON.stringify(live)}`);
        nextEvidence = now() + 1_000;
      }
      await delay(
        Math.max(1, Math.min(50, config.duration_ms - now(), (schedule[next]?.at ?? config.duration_ms) - now())),
        undefined,
        { signal }
      );
    }
    await evidence.collect();
    completedObservationWindow = true;
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  } finally {
    observedThroughMs = now();
    for (const runtime of runtimes.values()) runtime.transport.stop();
    for (const runtime of runtimes.values()) {
      try {
        await runtime.radio.close();
      } catch (error) {
        errors.push(`Radio cleanup: ${String(error)}`);
      }
    }
    if (ownsLab) {
      try {
        await lab.request("/api/simulation/stop", "POST");
        await lab.waitForState("STOPPED");
        await lab.request("/api/scenario", "PUT", previousScenario);
        restored = true;
      } catch (error) {
        errors.push(`Lab restoration: ${String(error)}`);
      }
    }
  }
  const outcomes = workload.results.finish(observedThroughMs);
  const packets = evidence.result();
  const nodes = Object.fromEntries(
    [...runtimes].map(([id, runtime]) => [
      id,
      {
        transport: runtime.transport.metrics(),
        radio_queue: runtime.device.queueMetrics(),
        packet_submissions: [...runtime.radio.sends.values()],
        receive_faults: runtime.radio.observations,
        injected_drop_rate: runtime.radio.observations.incoming_packets
          ? runtime.radio.observations.dropped_packets / runtime.radio.observations.incoming_packets
          : null,
        applied_faults: runtime.radio.applied,
        picture: runtime.picture.snapshot()
      }
    ])
  );
  const injected = [...runtimes.values()].reduce(
    (counts, runtime) => ({
      received_packets: counts.received_packets + runtime.radio.observations.incoming_packets,
      dropped_packets: counts.dropped_packets + runtime.radio.observations.dropped_packets,
      duplicate_packets: counts.duplicate_packets + runtime.radio.observations.duplicate_packets_injected
    }),
    { received_packets: 0, dropped_packets: 0, duplicate_packets: 0 }
  );
  const faultsExercised = config.faults.every((_, index) =>
    [...runtimes.values()].some((runtime) => runtime.radio.applied.some((fault) => fault.rule === index))
  );
  return {
    schema_version: 1,
    kind: "atlas-meshtastic-lab-experiment",
    started_at: startedUTC,
    config,
    config_sha256: createHash("sha256").update(canonicalJSON(config)).digest("hex"),
    provenance,
    scope:
      "Production Atlas Link over laboratory-configured primary channels. Does not test joining, full radio-profile convergence, Core persistence, physical execution, or physical RF range.",
    passed: outcomes.passed && errors.length === 0 && packets.complete && restored && faultsExercised,
    completed_observation_window: completedObservationWindow,
    faults_exercised: faultsExercised,
    injected_faults: {
      ...injected,
      packet_drop_rate: injected.received_packets ? injected.dropped_packets / injected.received_packets : null
    },
    lab_restored: restored,
    errors,
    outcomes,
    nodes,
    link_changes: changes,
    packets
  };
}
