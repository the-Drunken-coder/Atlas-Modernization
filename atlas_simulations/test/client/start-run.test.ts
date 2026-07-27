import { describe, expect, it, vi } from "vitest";
import { buildStartRunRequest, type StartSelectedRunOptions, startSelectedRun } from "../../src/client/start-run.js";
import {
  type AtlasTargetSummary,
  jsonNumber,
  type ScenarioDescriptor,
  type StartRunRequest
} from "../../src/shared/types.js";

const scenario: ScenarioDescriptor = {
  id: "moving-assets",
  name: "Moving assets",
  summary: "Creates assets",
  acceptsJson: true,
  inputFields: [
    {
      key: "assetCount",
      label: "Asset count",
      type: "number",
      defaultValue: jsonNumber(2),
      min: jsonNumber(1),
      max: jsonNumber(4)
    }
  ]
};

const syncScenario: ScenarioDescriptor = {
  id: "multi-client-sync",
  name: "Multi-client sync",
  summary: "Checks sync",
  acceptsJson: false,
  inputFields: []
};

const localTarget: AtlasTargetSummary = {
  id: "local",
  label: "Local Core",
  baseUrl: "http://localhost:8000",
  deployed: false,
  apiKeyConfigured: true
};

const deployedTarget: AtlasTargetSummary = {
  id: "deployed",
  label: "Atlas Command API",
  baseUrl: "https://atlascommandapi.org",
  deployed: true,
  apiKeyConfigured: true
};

function createOptions(overrides: Partial<StartSelectedRunOptions> = {}) {
  const start = vi.fn(async (_request: StartRunRequest, _apiKey?: string) => undefined);
  const apiKeyForTarget = vi.fn((_targetId: string): string | undefined => undefined);
  const clearError = vi.fn();
  const reportError = vi.fn();
  const onDeployedStartSettled = vi.fn();
  const options: StartSelectedRunOptions = {
    scenario,
    target: localTarget,
    mutationPending: false,
    deployedMutationConfirmed: false,
    inputs: { assetCount: 2 },
    jsonInput: "",
    apiKeyForTarget,
    clearError,
    reportError,
    start,
    onDeployedStartSettled,
    ...overrides
  };
  return { options, start, apiKeyForTarget, clearError, reportError, onDeployedStartSettled };
}

describe("buildStartRunRequest", () => {
  it("includes valid JSON input and omits the deployed confirmation for local targets", () => {
    const request = buildStartRunRequest(scenario, localTarget, { assetCount: 3 }, '{"note":"ok"}');

    expect(request).toEqual({
      scenarioId: scenario.id,
      targetId: localTarget.id,
      inputs: { assetCount: jsonNumber(3) },
      jsonInput: '{"note":"ok"}'
    });
    expect(request).not.toHaveProperty("confirmDeployedMutation");
  });

  it("omits blank JSON input", () => {
    const request = buildStartRunRequest(scenario, localTarget, { assetCount: 2 }, "   ");

    expect(request).not.toHaveProperty("jsonInput");
  });

  it("omits JSON input when the scenario does not accept JSON", () => {
    const request = buildStartRunRequest(syncScenario, localTarget, {}, '{"note":"ok"}');

    expect(request).toEqual({ scenarioId: syncScenario.id, targetId: localTarget.id, inputs: {} });
  });

  it("rejects invalid JSON input", () => {
    expect(() => buildStartRunRequest(scenario, localTarget, { assetCount: 2 }, "{")).toThrow(
      "JSON input must be valid JSON"
    );
  });

  it("confirms deployed mutation for deployed targets", () => {
    const request = buildStartRunRequest(syncScenario, deployedTarget, {}, "");

    expect(request).toEqual({
      scenarioId: syncScenario.id,
      targetId: deployedTarget.id,
      confirmDeployedMutation: true,
      inputs: {}
    });
  });
});

describe("startSelectedRun", () => {
  it("does not start without a scenario and target selection", async () => {
    const withoutScenario = createOptions({ scenario: undefined });
    await startSelectedRun(withoutScenario.options);
    const withoutTarget = createOptions({ target: undefined });
    await startSelectedRun(withoutTarget.options);

    expect(withoutScenario.start).not.toHaveBeenCalled();
    expect(withoutScenario.clearError).not.toHaveBeenCalled();
    expect(withoutTarget.start).not.toHaveBeenCalled();
    expect(withoutTarget.clearError).not.toHaveBeenCalled();
  });

  it("does not start while a mutation is pending", async () => {
    const { options, start, clearError } = createOptions({ mutationPending: true });

    await startSelectedRun(options);

    expect(start).not.toHaveBeenCalled();
    expect(clearError).not.toHaveBeenCalled();
  });

  it("blocks a deployed start until the mutation is confirmed", async () => {
    const blocked = createOptions({ target: deployedTarget });
    await startSelectedRun(blocked.options);
    expect(blocked.start).not.toHaveBeenCalled();

    const confirmed = createOptions({ target: deployedTarget, deployedMutationConfirmed: true });
    await startSelectedRun(confirmed.options);
    expect(confirmed.start).toHaveBeenCalledWith(
      {
        scenarioId: scenario.id,
        targetId: deployedTarget.id,
        confirmDeployedMutation: true,
        inputs: { assetCount: jsonNumber(2) }
      },
      undefined
    );
  });

  it("starts with the target API key and keeps the local confirmation untouched", async () => {
    const { options, start, clearError, onDeployedStartSettled } = createOptions({
      apiKeyForTarget: vi.fn((_targetId: string): string | undefined => "secret-key")
    });

    await startSelectedRun(options);

    expect(clearError).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith(
      { scenarioId: scenario.id, targetId: localTarget.id, inputs: { assetCount: jsonNumber(2) } },
      "secret-key"
    );
    expect(onDeployedStartSettled).not.toHaveBeenCalled();
  });

  it("resets the confirmation after a deployed start settles", async () => {
    const { options, onDeployedStartSettled } = createOptions({
      target: deployedTarget,
      deployedMutationConfirmed: true
    });

    await startSelectedRun(options);

    expect(onDeployedStartSettled).toHaveBeenCalledTimes(1);
  });

  it("reports request validation failures without starting", async () => {
    const { options, start, reportError, onDeployedStartSettled } = createOptions({ jsonInput: "{" });

    await startSelectedRun(options);

    expect(start).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(new Error("JSON input must be valid JSON"));
    expect(onDeployedStartSettled).not.toHaveBeenCalled();
  });

  it("reports start failures and still settles the deployed confirmation", async () => {
    const failure = new Error("start failed");
    const { options, reportError, onDeployedStartSettled } = createOptions({
      target: deployedTarget,
      deployedMutationConfirmed: true,
      start: vi.fn(async (_request: StartRunRequest, _apiKey?: string) => {
        throw failure;
      })
    });

    await startSelectedRun(options);

    expect(reportError).toHaveBeenCalledWith(failure);
    expect(onDeployedStartSettled).toHaveBeenCalledTimes(1);
  });
});
