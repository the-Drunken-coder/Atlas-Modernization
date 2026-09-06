import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseExperiment } from "./config.js";
import { LabClient, LabEvidence } from "./lab.js";
import { runLabExperiment } from "./runner.js";

afterEach(() => vi.restoreAllMocks());

describe("lab lifecycle and evidence", () => {
  it("retains a failed startup report and restores the previous scenario", async () => {
    const config = parseExperiment(
      JSON.parse(await readFile(new URL("../../experiments/quiet.json", import.meta.url), "utf8"))
    );
    config.lab_url = "http://127.0.0.1:58999";
    const previous = { saved: "original scenario" };
    const request = vi.spyOn(LabClient.prototype, "request").mockImplementation(async (path, method) => {
      if (path === "/api/state") return { state: "STOPPED" };
      if (path === "/api/capabilities") return { collisionAvailable: true, provenanceAvailable: true };
      if (path === "/api/scenario" && method === undefined) return previous;
      if (path === "/api/simulation/start") throw new Error("startup failed");
      return {};
    });
    const result = await runLabExperiment(config);
    expect(result.passed).toBe(false);
    expect(result.completed_observation_window).toBe(false);
    expect(result.packets.complete).toBe(false);
    expect(result.outcomes.summary.message_delivery_failure_rate).toBeNull();
    expect(result.lab_restored).toBe(true);
    expect(request).toHaveBeenLastCalledWith("/api/scenario", "PUT", previous);
    // A completed failed run must release its process-level reservation.
    expect((await runLabExperiment(config)).lab_restored).toBe(true);
  });

  it("does not stop or overwrite a lab already running someone else's experiment", async () => {
    const config = parseExperiment(
      JSON.parse(await readFile(new URL("../../experiments/quiet.json", import.meta.url), "utf8"))
    );
    config.lab_url = "http://127.0.0.1:58998";
    const request = vi.spyOn(LabClient.prototype, "request").mockResolvedValue({ state: "RUNNING" });
    await expect(runLabExperiment(config)).rejects.toThrow("exclusively available");
    expect(request).toHaveBeenCalledExactlyOnceWith("/api/state");
  });

  it("starts at the current cursor instead of counting packets from a previous run", async () => {
    const lab = new LabClient("http://127.0.0.1:1");
    const request = vi
      .spyOn(lab, "request")
      .mockResolvedValueOnce({ schemaVersion: 1, streamId: "stream", latestSequence: 55 })
      .mockResolvedValueOnce({
        schemaVersion: 1,
        streamId: "stream",
        streamChanged: false,
        historyGap: false,
        hasMore: false,
        events: [{ sequence: 56, eventType: "rf_transmit", airtimeMs: 42 }]
      });
    const evidence = new LabEvidence(lab);
    await evidence.begin();
    await evidence.collect();
    expect(request).toHaveBeenLastCalledWith("/api/events/history?afterSequence=55&limit=5000&streamId=stream");
    expect(evidence.result()).toMatchObject({ complete: true, rf_airtime_ms: 42, counts: { rf_transmit: 1 } });
  });

  it("keeps topology exclusions separate and invalidates RF aggregates after an event gap", async () => {
    const lab = new LabClient("http://127.0.0.1:1");
    vi.spyOn(lab, "request").mockResolvedValue({
      schemaVersion: 1,
      streamId: "stream",
      streamChanged: false,
      historyGap: true,
      hasMore: false,
      events: [
        { sequence: 15, eventType: "link_disabled" },
        { sequence: 16, eventType: "rf_transmit", airtimeMs: 42 }
      ]
    });
    const evidence = new LabEvidence(lab);
    await evidence.collect();
    expect(evidence.result()).toMatchObject({
      complete: false,
      rf_airtime_ms: null,
      native_packet_loss_rate: null,
      counts: { link_disabled: 1, rf_transmit: 1 }
    });
  });
});
