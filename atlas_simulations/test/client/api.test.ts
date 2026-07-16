import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupRun, loadHealth, loadRun, loadRuns, loadScenarios, loadTargets, startRun, stopRun } from "../../src/client/api.js";
import { type AtlasTargetSummary, jsonNumber, type RunSummary, type ScenarioDescriptor } from "../../src/shared/types.js";

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

const target: AtlasTargetSummary = {
  id: "deployed",
  label: "Deployed Core",
  baseUrl: "https://atlascommandapi.org",
  deployed: true,
  apiKeyConfigured: true
};

describe("client API", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects invalid list response shapes at the API boundary", async () => {
    stubJSON({ runs: [{ id: "missing-fields" }] });

    await expect(loadRuns()).rejects.toThrow("Expected run list response");
  });

  it("normalizes invalid health responses and rejects invalid run response shapes at the API boundary", async () => {
    stubJSON({ ok: "yes" });
    await expect(loadHealth()).resolves.toMatchObject({ ok: false, status: jsonNumber(200), message: "Unexpected health response (200)" });

    stubJSON({ run: { id: "missing-fields" } });
    await expect(loadRun(run.id)).rejects.toThrow("Expected run response");

    stubJSON({ run: { id: "missing-fields" } });
    await expect(stopRun(run.id)).rejects.toThrow("Expected run response");
  });

  it("resolves health as offline when the local server cannot be reached", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("connection refused");
      })
    );

    await expect(loadHealth()).resolves.toMatchObject({ ok: false, status: jsonNumber(0), message: "connection refused" });
  });

  it("resolves health as unhealthy for unexpected success bodies", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not json", { status: 200 }))
    );

    await expect(loadHealth()).resolves.toMatchObject({ ok: false, status: jsonNumber(200), message: "Unexpected health response (200)" });
  });

  it("loads API targets and checks health for a selected target", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ targets: [target], defaultTargetId: target.id }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, status: 200, target }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadTargets()).resolves.toEqual({ targets: [target], defaultTargetId: target.id });
    await expect(loadHealth(target.id, " pasted-key ")).resolves.toMatchObject({ ok: true, status: jsonNumber(200), target });
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`/api/health?target=${encodeURIComponent(target.id)}`);
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("X-Atlas-Target-Api-Key")).toBe("pasted-key");
  });

  it("normalizes transport failures for JSON APIs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("server offline");
      })
    );

    await expect(loadRuns()).rejects.toThrow("server offline");
  });

  it("rejects invalid start payloads before serialization", async () => {
    await expect(startRun({ scenarioId: "moving-assets", inputs: { assetCount: Number.NaN } } as unknown as Parameters<typeof startRun>[0])).rejects.toThrow(
      "Invalid start run request"
    );
    await expect(startRun({ scenarioId: "moving-assets", confirmDeployedMutation: false } as unknown as Parameters<typeof startRun>[0])).rejects.toThrow(
      "Invalid start run request"
    );
  });

  it("serializes valid start payloads with trusted mutation headers", async () => {
    const fetchMock = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) => jsonResponse({ run }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      startRun(
        {
          scenarioId: scenario.id,
          targetId: target.id,
          confirmDeployedMutation: true,
          inputs: { assetCount: jsonNumber(1) }
        },
        "pasted-key"
      )
    ).resolves.toEqual(run);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/runs");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      scenarioId: scenario.id,
      targetId: target.id,
      confirmDeployedMutation: true,
      inputs: { assetCount: 1 }
    });
    const headers = new Headers(init?.headers);
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("X-Atlas-Simulations-Request")).toBe("1");
    expect(headers.get("X-Atlas-Target-Api-Key")).toBe("pasted-key");
  });

  it("sends trusted mutation headers when stopping runs", async () => {
    const fetchMock = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) => jsonResponse({ run }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(stopRun(run.id)).resolves.toEqual(run);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`/api/runs/${encodeURIComponent(run.id)}/stop`);
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("X-Atlas-Simulations-Request")).toBe("1");
  });

  it("forwards a pasted API key when cleaning up a run", async () => {
    const fetchMock = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) => jsonResponse({ run }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(cleanupRun(run.id, " pasted-cleanup-key ")).resolves.toEqual(run);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`/api/runs/${encodeURIComponent(run.id)}/cleanup`);
    expect(init?.method).toBe("POST");
    const headers = new Headers(init?.headers);
    expect(headers.get("X-Atlas-Simulations-Request")).toBe("1");
    expect(headers.get("X-Atlas-Target-Api-Key")).toBe("pasted-cleanup-key");
  });

  it("preserves HTTP status errors for non-JSON failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500 }))
    );

    await expect(loadRuns()).rejects.toThrow("Request failed (500)");
  });

  it("validates scenario and mutation response shapes", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ scenarios: [scenario] }))
      .mockResolvedValueOnce(jsonResponse({ run }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadScenarios()).resolves.toEqual([scenario]);
    await expect(cleanupRun(run.id)).resolves.toEqual(run);
    const [url, init] = fetchMock.mock.calls.at(-1)!;
    expect(url).toBe(`/api/runs/${encodeURIComponent(run.id)}/cleanup`);
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("X-Atlas-Simulations-Request")).toBe("1");
  });
});

function stubJSON(body: unknown, status = 200): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => jsonResponse(body, status))
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
