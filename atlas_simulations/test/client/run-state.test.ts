import { describe, expect, it } from "vitest";
import { buildStartRunRequest } from "../../src/client/run-state.js";
import { type AtlasTargetSummary, jsonNumber, type ScenarioDescriptor } from "../../src/shared/types.js";

const scenario: ScenarioDescriptor = {
  id: "sync-entity",
  name: "Sync entity",
  summary: "Synchronizes an entity",
  acceptsJson: true,
  inputFields: [
    { key: "entityId", label: "Entity ID", type: "text", defaultValue: "entity-1" },
    { key: "attempts", label: "Attempts", type: "number", defaultValue: jsonNumber(1), min: jsonNumber(1) }
  ]
};

const target: AtlasTargetSummary = {
  id: "deployed-core",
  label: "Deployed Core",
  baseUrl: "https://atlas.example",
  deployed: true,
  apiKeyConfigured: true
};

describe("buildStartRunRequest", () => {
  it("builds the complete request after validating inputs", () => {
    expect(
      buildStartRunRequest(scenario, target, { entityId: "entity-2", attempts: "3" }, '{"mode":"fast"}', true)
    ).toEqual({
      scenarioId: "sync-entity",
      targetId: "deployed-core",
      confirmDeployedMutation: true,
      inputs: { entityId: "entity-2", attempts: 3 },
      jsonInput: '{"mode":"fast"}'
    });
  });

  it("requires explicit confirmation for a deployed mutation", () => {
    expect(() => buildStartRunRequest(scenario, target, {}, "", false)).toThrow(
      "Confirm the deployed mutation before starting the run"
    );
  });

  it("rejects invalid JSON before a run is submitted", () => {
    expect(() => buildStartRunRequest(scenario, target, {}, "{", true)).toThrow("JSON input must be valid JSON");
  });
});
