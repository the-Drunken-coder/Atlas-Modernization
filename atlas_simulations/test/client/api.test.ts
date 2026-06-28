import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupRun, loadHealth, loadRun, loadRuns, loadScenarios, startRun, stopRun } from "../../src/client/api.js";
import { jsonNumber, type RunSummary, type ScenarioDescriptor } from "../../src/shared/types.js";

const scenario: ScenarioDescriptor = {
  id: "moving-assets",
  name: "Moving assets",
  summary: "Moves assets",
  acceptsJson: false,
  inputFields: []
};

const run: RunSummary = {
  id: "sim-test",
  scenarioId: "moving-assets",
  scenarioName: "Moving assets",
  status: "completed",
  startedAt: new Date().toISOString(),
  inputs: { assetCount: jsonNumber(1) },
  createdResources: [],
  assertions: [],
  cleaned: false
};

describe("client API", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects invalid list response shapes at the API boundary", async () => {
    stubJSON({ runs: [{ id: "missing-fields" }] });

    await expect(loadRuns()).rejects.toThrow("Expected run list response");
  });

  it("rejects invalid health and run response shapes at the API boundary", async () => {
    stubJSON({ ok: "yes" });
    await expect(loadHealth()).rejects.toThrow("Expected health response");

    stubJSON({ run: { id: "missing-fields" } });
    await expect(loadRun(run.id)).rejects.toThrow("Expected run response");

    stubJSON({ run: { id: "missing-fields" } });
    await expect(stopRun(run.id)).rejects.toThrow("Expected run response");
  });

  it("resolves health as offline when the local server cannot be reached", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("connection refused");
    }));

    await expect(loadHealth()).resolves.toMatchObject({ ok: false, status: jsonNumber(0), message: "connection refused" });
  });

  it("rejects invalid start payloads before serialization", async () => {
    await expect(startRun({ scenarioId: "moving-assets", inputs: { assetCount: Number.NaN } } as unknown as Parameters<typeof startRun>[0])).rejects.toThrow(
      "Invalid start run request"
    );
  });

  it("serializes valid start payloads with trusted mutation headers", async () => {
    const fetchMock = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) => jsonResponse({ run }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(startRun({ scenarioId: scenario.id, inputs: { assetCount: jsonNumber(1) } })).resolves.toEqual(run);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/runs");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ scenarioId: scenario.id, inputs: { assetCount: 1 } });
    const headers = new Headers(init?.headers);
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("X-Atlas-Simulations-Request")).toBe("1");
  });

  it("preserves HTTP status errors for non-JSON failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));

    await expect(loadRuns()).rejects.toThrow("Request failed (500)");
  });

  it("validates scenario and mutation response shapes", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ scenarios: [scenario] }))
      .mockResolvedValueOnce(jsonResponse({ run }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadScenarios()).resolves.toEqual([scenario]);
    await expect(cleanupRun(run.id)).resolves.toEqual(run);
    const [, init] = fetchMock.mock.calls.at(-1)!;
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("X-Atlas-Simulations-Request")).toBe("1");
  });
});

function stubJSON(body: unknown, status = 200): void {
  vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(body, status)));
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
