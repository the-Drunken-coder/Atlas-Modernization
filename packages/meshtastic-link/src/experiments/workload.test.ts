import { describe, expect, it } from "vitest";
import type { TransportMessageEvent } from "../transport.js";
import { type ExperimentMessage, labScenario, parseExperiment } from "./config.js";
import { createGatewayFleetExperiment } from "./fleet.js";
import { runSimulatedExperiment } from "./simulated.js";
import { ExperimentWorkload } from "./workload.js";

function setup() {
  const fleet = createGatewayFleetExperiment();
  const command = fleet.messages.find((message) => message.response);
  if (!command?.destination || !command.response) throw new Error("Missing command fixture");
  const config = parseExperiment({ ...fleet, messages: [command] });
  let now = 0;
  const sent: ExperimentMessage[] = [];
  const workload = new ExperimentWorkload(
    config,
    () => now,
    (message) => {
      sent.push(message);
      return { operation_id: message.id, status: "queued" };
    }
  );
  const event: TransportMessageEvent = {
    type: "message",
    message: command.message,
    operation_id: command.id,
    settlement_id: "command-settlement",
    source: { id: "gateway", role: "gateway" },
    destination: { id: command.destination, role: "asset" },
    source_generation: 1,
    service_session: "test",
    source_sequence: 1,
    received_at: 1000,
    addressed_to_local: true,
    requires_settlement: true
  };
  return {
    config,
    command,
    workload,
    sent,
    event,
    setNow: (value: number) => {
      now = value;
    }
  };
}

describe("reactive Task experiment application", () => {
  it("sends one result only after the matching command is accepted", () => {
    const { command, workload, sent, event, setNow } = setup();
    workload.submit(command);
    expect(sent).toHaveLength(1);
    setNow(1000);
    workload.observe(command.destination ?? "", event, () => false);
    expect(sent).toHaveLength(1);
    workload.observe(command.destination ?? "", event, () => true);
    workload.observe(command.destination ?? "", event, () => true);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({
      source: command.destination,
      destination: command.source,
      message: command.response?.message
    });
  });

  it("still responds to a late command while retaining its missed delivery deadline", () => {
    const { command, workload, sent, event, setNow } = setup();
    workload.submit(command);
    setNow(16_000);
    workload.observe(command.destination ?? "", event, () => true);
    expect(sent).toHaveLength(2);
    const result = workload.results.finish(35_000);
    expect(result.messages[0]?.outcome).toBe("delivered_late");
    expect(result.exchanges[0]?.response_submitted).toBe(true);
  });

  it("keeps a lost command from producing a scheduled success response", () => {
    const { command, workload, sent } = setup();
    workload.submit(command);
    const report = workload.results.finish(330_000);
    expect(sent).toHaveLength(1);
    expect(report.exchanges[0]).toMatchObject({
      command_delivered: false,
      response_submitted: false,
      response_delivered: false,
      completed_within_deadline: false
    });
    expect(report.messages[1]?.outcome).toBe("not_submitted");
    expect(report.passed).toBe(false);
  });

  it("separates application round-trip success from missing transport confirmations", () => {
    const { command, workload, sent, event, setNow } = setup();
    workload.submit(command);
    setNow(1000);
    workload.observe(command.destination ?? "", event, () => true);
    const reply = sent[1];
    if (!reply) throw new Error("Response not submitted");
    setNow(3000);
    workload.observe(
      "gateway",
      {
        ...event,
        message: reply.message,
        operation_id: reply.id,
        settlement_id: "response-settlement",
        source: { role: "asset", id: reply.source },
        destination: { role: "gateway", id: "gateway" }
      },
      () => true
    );
    const exchange = workload.results.finish(330_000).exchanges[0];
    expect(exchange).toMatchObject({
      command_delivered: true,
      response_delivered: true,
      command_confirmed: false,
      response_confirmed: false,
      round_trip_ms: 3000,
      completed_within_deadline: true
    });
  });

  it("rejects mismatched Task results and conflicting response identities", () => {
    const { config, command } = setup();
    expect(() =>
      parseExperiment({
        ...config,
        messages: [
          {
            ...command,
            response: {
              ...command.response,
              message: { ...command.response?.message, task_id: "wrong-task" }
            }
          }
        ]
      })
    ).toThrow("matching Asset Task report");
    expect(() => parseExperiment({ ...config, duration_ms: 20_000 })).toThrow("round-trip deadline");
    const reply = command.response;
    if (!reply) throw new Error("Missing response");
    expect(() =>
      parseExperiment({
        ...config,
        messages: [
          command,
          {
            id: reply.id,
            source: command.destination,
            destination: "gateway",
            receivers: ["gateway"],
            at_ms: 0,
            deadline_ms: 15000,
            expect: "delivered",
            message: reply.message
          }
        ]
      })
    ).toThrow("unique per source");
  });

  it.each(["quiet", "drop", "duplicate"] as const)(
    "runs a reactive exchange through production transports: %s",
    async (fault) => {
      const { config, command } = setup();
      config.nodes = config.nodes.filter((node) => node.id === "gateway" || node.id === command.destination);
      config.topology = "full-mesh";
      config.duration_ms = 35_000;
      if (fault !== "quiet")
        config.faults = [
          {
            receiver: command.destination ?? "",
            source: "gateway",
            message_type: "task_delivery",
            action: fault,
            count: 10000,
            after_ms: 0,
            before_ms: 35000
          }
        ];
      const result = await runSimulatedExperiment(config);
      expect(result.outcomes.exchanges[0]).toMatchObject({
        response_submitted: fault !== "drop",
        response_delivered: fault !== "drop",
        completed_within_deadline: fault !== "drop"
      });
      expect(result.outcomes.summary.duplicate_application_acceptances).toBe(0);
      if (fault !== "drop") expect(result.outcomes.passed).toBe(true);
    }
  );

  it("builds exactly the requested cadence and relay topology", () => {
    const config = createGatewayFleetExperiment();
    expect(config.messages.filter((message) => message.message.type === "state")).toHaveLength(180);
    for (const [index, asset] of ["asset-a", "asset-b", "asset-c"].entries()) {
      const samples = config.messages.filter((message) => message.source === asset);
      expect(samples.map((message) => message.at_ms)).toEqual(
        Array.from({ length: 60 }, (_, n) => n * 5000 + index * 1600)
      );
    }
    const synchronized = createGatewayFleetExperiment({ synchronizedTelemetry: true });
    expect(
      synchronized.messages.filter((message) => message.message.type === "state" && message.at_ms === 0)
    ).toHaveLength(3);
    const commands = config.messages.filter((message) => message.response);
    expect(commands).toHaveLength(20);
    expect(commands.slice(0, 4).map((message) => [message.at_ms, message.destination])).toEqual([
      [0, "asset-a"],
      [15000, "asset-b"],
      [30000, "asset-c"],
      [45000, "asset-a"]
    ]);
    expect(
      labScenario(config)
        .links.filter((link) => link.enabled)
        .map((link) => `${link.from}:${link.to}`)
        .sort()
    ).toEqual(
      [
        "asset-a:gateway",
        "gateway:asset-a",
        "gateway:asset-b",
        "asset-b:gateway",
        "asset-b:asset-c",
        "asset-c:asset-b"
      ].sort()
    );
  });
});

it.each(["deflate-v1", "deflate-v2", "deflate-v3"] as const)(
  "reproduces the complete %s fleet from its seed",
  async (encoding) => {
    const config = parseExperiment({ ...createGatewayFleetExperiment(), frame_encoding: encoding });
    const first = await runSimulatedExperiment(config, 42);
    const second = await runSimulatedExperiment(config, 42);
    expect(second).toEqual(first);
    expect(first.outcomes.summary.submission_attempts).toBeGreaterThanOrEqual(200);
    expect(first.outcomes.summary.duplicate_application_acceptances).toBe(0);
  }
);

it("supports the heavier per-Asset command cadence without changing telemetry", () => {
  const fleet = createGatewayFleetExperiment({ commandsPerAsset: true });
  const commands = fleet.messages.filter((message) => message.response);
  expect(commands).toHaveLength(60);
  expect(fleet.messages.filter((message) => message.message.type === "state")).toHaveLength(180);
  for (const asset of ["asset-a", "asset-b", "asset-c"]) {
    expect(commands.filter((command) => command.destination === asset).map((command) => command.at_ms)).toEqual(
      Array.from({ length: 20 }, (_, index) => index * 15_000)
    );
  }
  expect(new Set(commands.map((command) => command.id)).size).toBe(60);
});
