import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupRun, loadRuns, loadScenarios } from "../../src/client/api.js";
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

  it("validates scenario and mutation response shapes", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ scenarios: [scenario] }))
      .mockResolvedValueOnce(jsonResponse({ run }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadScenarios()).resolves.toEqual([scenario]);
    await expect(cleanupRun(run.id)).resolves.toEqual(run);
    expect(fetchMock).toHaveBeenLastCalledWith(`/api/runs/${encodeURIComponent(run.id)}/cleanup`, expect.objectContaining({
      method: "POST",
      headers: expect.any(Headers)
    }));
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
