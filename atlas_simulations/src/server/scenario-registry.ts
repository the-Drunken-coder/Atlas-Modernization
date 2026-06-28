import movingAssets from "../scenarios/moving-assets.js";
import multiClientSync from "../scenarios/multi-client-sync.js";
import observationsObjects from "../scenarios/observations-objects.js";
import type { Scenario } from "./scenario.js";

export const scenarios: Scenario[] = [movingAssets, observationsObjects, multiClientSync];

export function findScenario(id: string): Scenario | undefined {
  return scenarios.find((scenario) => scenario.id === id);
}
