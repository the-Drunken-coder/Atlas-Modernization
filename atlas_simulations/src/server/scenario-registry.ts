import movingAssets from "../scenarios/moving-assets.js";
import multiClientSync from "../scenarios/multi-client-sync.js";
import observationsObjects from "../scenarios/observations-objects.js";
import type { Scenario } from "./scenario.js";

const registeredScenarios: Scenario[] = [movingAssets, observationsObjects, multiClientSync];
assertUniqueScenarioIds(registeredScenarios);

export const scenarios: readonly Scenario[] = Object.freeze(registeredScenarios);

export function findScenario(id: string): Scenario | undefined {
  return scenarios.find((scenario) => scenario.id === id);
}

function assertUniqueScenarioIds(allScenarios: Scenario[]): void {
  const seen = new Set<string>();
  for (const scenario of allScenarios) {
    if (seen.has(scenario.id)) throw new Error(`Duplicate scenario id: ${scenario.id}`);
    seen.add(scenario.id);
  }
}
