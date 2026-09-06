import { readFile } from "node:fs/promises";
import { create, toBinary } from "@bufbuild/protobuf";
import { Protobuf } from "@meshtastic/core";
import { describe, expect, it } from "vitest";
import { VirtualClock } from "../clock.js";
import { SharedPicture } from "../picture.js";
import { SimulatedPacketNetwork } from "../simulation.js";
import { LinkTransport } from "../transport.js";
import { parseExperiment } from "./config.js";
import { FaultRadio } from "./fault-radio.js";
import { ExperimentResults } from "./results.js";

async function fixture(name: string) {
  return parseExperiment(
    JSON.parse(await readFile(new URL(`../../experiments/${name}.json`, import.meta.url), "utf8"))
  );
}

describe("Atlas semantic experiment accounting over the production Link", () => {
  it("reserves the native firmware wrapper's six bytes", async () => {
    const config = await fixture("quiet");
    const wrappedSize = (size: number) =>
      toBinary(
        Protobuf.Mesh.CompressedSchema,
        create(Protobuf.Mesh.CompressedSchema, {
          portnum: Protobuf.Portnums.PortNum.PRIVATE_APP,
          data: new Uint8Array(size)
        })
      ).byteLength;
    expect(wrappedSize(227)).toBe(233);
    expect(wrappedSize(228)).toBe(234);
    expect(parseExperiment({ ...config, max_payload_bytes: 227 }).max_payload_bytes).toBe(227);
    for (const encoding of ["deflate-v2", "binary-v1", "message-v1", "message-v2"] as const)
      expect(parseExperiment({ ...config, frame_encoding: encoding }).frame_encoding).toBe(encoding);
    expect(() => parseExperiment({ ...config, max_payload_bytes: 228 })).toThrow("SIMULATOR_APP");
  });

  it.each(
    (["canonical-json", "deflate-v1", "deflate-v2", "deflate-v3", "message-v1", "message-v2"] as const).flatMap(
      (frameEncoding) =>
        ["quiet", "recover-loss", "no-delivery", "lost-confirmation", "duplicate", "state-fanout"].map(
          (name) => [frameEncoding, name] as const
        )
    )
  )("%s distinguishes %s from packet failures", async (frameEncoding, name) => {
    const config = await fixture(name);
    const clock = new VirtualClock(Date.parse("2026-09-05T12:00:00Z"));
    const start = clock.now();
    const network = new SimulatedPacketNetwork({ seed: 42, clock });
    const results = new ExperimentResults(config);
    const nodes = config.nodes.map((node, i) => {
      const radio = new FaultRadio(
        network.addRadio(node.id, 101 + i),
        node.id,
        config.faults,
        () => clock.now() - start,
        config.max_payload_bytes
      );
      const transport = new LinkTransport({
        node,
        sourceGeneration: 1,
        serviceSession: node.id,
        frameEncoding,
        radio,
        clock,
        picture: new SharedPicture(node.id),
        privateChannel: 0
      });
      transport.onEvent((event) =>
        results.observe(node.id, event, clock.now() - start, (id) => transport.settleInbound(id, true))
      );
      return { node, radio, transport };
    });
    network.connect("asset", "gateway");
    if (name === "state-fanout") network.connect("asset", "peer");
    const message = config.messages[0];
    const source = nodes.find((node) => node.node.id === message?.source);
    if (!source || !message) throw new Error("missing fixture");
    const submission = source.transport.submit(message.message, {
      ...(message.destination === undefined
        ? {}
        : {
            destination: {
              id: message.destination,
              role: config.nodes.find((node) => node.id === message.destination)?.role ?? "asset"
            }
          }),
      operationID: message.id
    });
    results.submitted(message.source, message.id, 0, submission);
    await clock.advanceBy(config.duration_ms);
    const report = results.finish();
    expect(report.messages[0]?.outcome).toBe(message.expect);
    expect(report.passed).toBe(true);
    expect(report.summary.duplicate_application_acceptances).toBe(0);
    if (name === "recover-loss") {
      expect(nodes.reduce((sum, node) => sum + node.radio.observations.dropped_packets, 0)).toBe(1);
      expect(report.summary.message_delivery_failure_rate).toBe(0);
      expect(nodes.reduce((sum, node) => sum + node.transport.metrics().retransmitted_packets, 0)).toBeGreaterThan(0);
    }
    if (name === "lost-confirmation") {
      expect(report.summary.message_delivery_failure_rate).toBe(0);
      expect(report.summary.confirmation_failure_rate).toBe(1);
    }
    if (name === "no-delivery") expect(report.summary.message_delivery_failure_rate).toBe(1);
    for (const node of nodes) {
      node.transport.stop();
      await node.radio.close();
    }
  });

  it("rejects an observation window shorter than a message deadline before any lab writes", async () => {
    const config = await fixture("quiet");
    expect(() => parseExperiment({ ...config, duration_ms: 5000 })).toThrow("deadline");
    expect(() => parseExperiment({ ...config, lab_url: "http://example.com:8080" })).toThrow("127.0.0.1");
    expect(() => parseExperiment({ ...config, nodes: [config.nodes[0], config.nodes[0]] })).toThrow("unique");
  });

  it("does not count an unsubmitted negative expectation as a successful failure test", async () => {
    const results = new ExperimentResults(await fixture("no-delivery"));
    expect(results.finish().passed).toBe(false);
    expect(results.finish().summary.message_delivery_failure_rate).toBeNull();
  });
});

it("reports late delivery separately from nondelivery and rejects duplicate acceptance", async () => {
  const config = await fixture("quiet");
  const message = config.messages[0];
  if (!message) throw new Error("missing fixture");
  const results = new ExperimentResults(config);
  results.submitted(message.source, message.id, 0, { operation_id: message.id, status: "queued" });
  const event = {
    type: "message" as const,
    message: message.message,
    operation_id: message.id,
    settlement_id: "settlement",
    source: { id: message.source, role: "gateway" as const },
    source_generation: 1,
    service_session: "session",
    source_sequence: 1,
    received_at: 31000,
    addressed_to_local: true,
    requires_settlement: true
  };
  expect(results.finish(1000).messages[0]?.outcome).toBe("incomplete");
  results.observe("asset", event, 31000, () => true);
  const report = results.finish(35000);
  expect(report.messages[0]?.outcome).toBe("delivered_late");
  expect(report.summary.message_delivery_failure_rate).toBe(0);
  expect(report.summary.delivery_deadline_failure_rate).toBe(1);
  results.observe("asset", event, 32000, () => true);
  expect(results.finish(35000).summary.duplicate_application_acceptances).toBe(1);
  expect(results.finish(35000).passed).toBe(false);
});
