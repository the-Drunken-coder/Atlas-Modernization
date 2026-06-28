import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupRun, loadRuns, loadScenarios, startRun } from "../../src/client/api.js";
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

  it("rejects invalid start payloads before serialization", async () => {
    await expect(startRun({ scenarioId: "moving-assets", inputs: { assetCount: Number.NaN } } as unknown as Parameters<typeof startRun>[0])).rejects.toThrow(
      "Invalid start run request"
    );
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
