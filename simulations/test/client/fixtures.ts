import type { RunSummary, ScenarioDescriptor } from "../../src/shared/types.js";

export function scenarioFixture(overrides: Partial<ScenarioDescriptor> = {}): ScenarioDescriptor {
  return {
    id: "fixture-scenario",
    name: "Fixture scenario",
    summary: "Exercises a simulation",
    acceptsJson: false,
    inputFields: [],
    ...overrides
  };
}

export function runFixture(overrides: Partial<RunSummary> = {}): RunSummary {
  const run: RunSummary = {
    id: "sim-test",
    scenarioId: "fixture-scenario",
    scenarioName: "Fixture scenario",
    status: "completed",
    startedAt: new Date().toISOString(),
    inputs: {},
    createdResources: [],
    assertions: [],
    cleaned: false,
    ...overrides
  };
  return {
    ...run,
    inputs: { ...run.inputs },
    createdResources: [...run.createdResources],
    assertions: [...run.assertions]
  };
}
