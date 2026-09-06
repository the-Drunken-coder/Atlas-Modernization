import { createHash } from "node:crypto";
import { VirtualClock } from "../clock.js";
import { SharedPicture } from "../picture.js";
import { SHORT_FAST_MODEM, SimulatedPacketNetwork } from "../simulation.js";
import { LinkTransport } from "../transport.js";
import { type ExperimentConfig, parseExperiment } from "./config.js";
import { FaultRadio } from "./fault-radio.js";
import { ExperimentWorkload } from "./workload.js";

/** Run the same application and schedule with virtual time and the modeled radio medium. */
export async function runSimulatedExperiment(input: ExperimentConfig, seed = 42) {
  const config = parseExperiment(input);
  if (config.link_changes.length) throw new Error("The deterministic experiment runner requires a static topology");
  const start = Date.parse("2026-09-05T12:00:00Z");
  const clock = new VirtualClock(start);
  const now = () => clock.now() - start;
  const network = new SimulatedPacketNetwork({
    seed,
    clock,
    modem:
      config.preset === "SHORT_FAST"
        ? SHORT_FAST_MODEM
        : { ...SHORT_FAST_MODEM, name: "SHORT_TURBO", bandwidth_khz: 500 }
  });
  const runtimes = new Map<string, { transport: LinkTransport; radio: FaultRadio }>();
  const workload = new ExperimentWorkload(config, now, (message) => {
    const runtime = runtimes.get(message.source);
    if (!runtime) throw new Error(`Missing source ${message.source}`);
    const destination = config.nodes.find((node) => node.id === message.destination);
    return runtime.transport.submit(message.message, {
      operationID: message.id,
      ...(destination ? { destination: { role: destination.role, id: destination.id } } : {})
    });
  });
  for (const [index, node] of config.nodes.entries()) {
    const radio = new FaultRadio(
      network.addRadio(node.id, 100 + index),
      node.id,
      config.faults,
      now,
      config.max_payload_bytes
    );
    let identitySequence = 0;
    const transport = new LinkTransport({
      node,
      radio,
      clock,
      sourceGeneration: 1,
      serviceSession: `sim${index.toString().padStart(5, "0")}`,
      createID: () =>
        createHash("sha256")
          .update(`${seed}:${node.id}:${identitySequence++}`)
          .digest()
          .subarray(0, 8)
          .toString("base64url"),
      retryJitterMs: config.retry_jitter_ms ?? 0,
      frameEncoding: config.frame_encoding ?? "canonical-json",
      adaptiveRetries: config.adaptive_retries ?? false,
      stateDeltas: config.state_deltas ?? false,
      privateChannel: 0,
      picture: new SharedPicture(node.id)
    });
    runtimes.set(node.id, { transport, radio });
    transport.onEvent((event) =>
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
      )
    );
  }
  for (const [i, source] of config.nodes.entries()) {
    for (const [j, destination] of config.nodes.entries()) {
      if (j > i && (config.topology === "full-mesh" || j === i + 1)) network.connect(source.id, destination.id);
    }
  }
  try {
    for (const message of config.messages) clock.schedule(message.at_ms, () => workload.submit(message));
    await clock.advanceBy(config.duration_ms);
    const outcomes = workload.results.finish(config.duration_ms);
    const faultsExercised = config.faults.every((_, index) =>
      [...runtimes.values()].some((runtime) => runtime.radio.applied.some((fault) => fault.rule === index))
    );
    return {
      passed: outcomes.passed && faultsExercised,
      faults_exercised: faultsExercised,
      kind: "atlas-modeled-experiment",
      seed,
      config,
      outcomes,
      network: network.metrics(),
      nodes: Object.fromEntries(
        [...runtimes].map(([id, runtime]) => [
          id,
          {
            transport: runtime.transport.metrics(),
            receive_faults: runtime.radio.observations
          }
        ])
      )
    };
  } finally {
    for (const runtime of runtimes.values()) {
      runtime.transport.stop();
      await runtime.radio.close();
    }
  }
}
