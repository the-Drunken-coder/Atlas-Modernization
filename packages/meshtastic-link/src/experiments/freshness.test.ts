import { describe, expect, it } from "vitest";
import { positionPublication } from "../test-fixtures.js";
import type { TransportMessageEvent } from "../transport.js";
import type { ExperimentMessage } from "./config.js";
import { ExperimentResults } from "./results.js";

describe("experiment telemetry freshness accounting", () => {
  it("weights accepted state age over the active window and ignores older samples that arrive later", () => {
    const messages = [
      stateMessage("sample-0", 0),
      stateMessage("sample-1", 10),
      stateMessage("sample-2", 20),
      stateMessage("sample-3", 30)
    ];
    const results = new ExperimentResults({ messages });
    accept(results, messages[0]!, 4);
    accept(results, messages[1]!, 12);
    accept(results, messages[3]!, 34);
    accept(results, messages[2]!, 36);

    const receiver = results.finish(40).telemetry[0]?.receivers[0];
    expect(receiver).toMatchObject({
      scheduled: 4,
      delivered: 4,
      maximum_latency_ms: 16,
      latest_sample_age_ms: 10,
      active_publication_window_ms: 30,
      drain_window_ms: 10,
      known_age_window_ms: 26,
      time_weighted_age_p50_ms: 10,
      time_weighted_age_p95_ms: 19,
      time_weighted_age_max_ms: 20,
      longest_gap_without_fresher_accepted_sample_ms: 18,
      unknown_before_initial_sample_ms: 4
    });
  });

  it("reports unknown active time when no accepted sample establishes initial state", () => {
    const messages = [stateMessage("sample-0", 0), stateMessage("sample-1", 10), stateMessage("sample-2", 20)];
    const receiver = new ExperimentResults({ messages }).finish(30).telemetry[0]?.receivers[0];

    expect(receiver).toMatchObject({
      scheduled: 3,
      delivered: 0,
      active_publication_window_ms: 20,
      drain_window_ms: 10,
      known_age_window_ms: 0,
      time_weighted_age_p50_ms: null,
      time_weighted_age_p95_ms: null,
      time_weighted_age_max_ms: null,
      longest_gap_without_fresher_accepted_sample_ms: null,
      unknown_before_initial_sample_ms: 20
    });
  });
});

function stateMessage(id: string, atMs: number): ExperimentMessage {
  return {
    id,
    source: "asset",
    receivers: ["gateway"],
    at_ms: atMs,
    deadline_ms: 100,
    expect: "delivered",
    message: { ...positionPublication(atMs / 10 + 1), operation_id: id }
  };
}

function accept(results: ExperimentResults, workload: ExperimentMessage, acceptedAtMs: number): void {
  results.submitted(workload.source, workload.id, workload.at_ms, { operation_id: workload.id, status: "queued" });
  const event: TransportMessageEvent = {
    type: "message",
    message: workload.message,
    operation_id: workload.id,
    settlement_id: `${workload.id}-settlement`,
    source: { role: "asset", id: workload.source },
    destination: { role: "gateway", id: "gateway" },
    source_generation: 1,
    service_session: "asset-session",
    source_sequence: 1,
    received_at: acceptedAtMs,
    addressed_to_local: true,
    requires_settlement: false
  };
  results.observe("gateway", event, acceptedAtMs, () => true);
}
