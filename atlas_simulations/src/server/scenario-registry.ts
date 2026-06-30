import movingAssets from "../scenarios/moving-assets.js";
import multiClientSync from "../scenarios/multi-client-sync.js";
import observationsObjects from "../scenarios/observations-objects.js";
import type { Scenario } from "./scenario.js";

export type RegisteredScenario = Readonly<Scenario>;

const registeredScenarios: RegisteredScenario[] = [movingAssets, observationsObjects, multiClientSync].map(freezeScenario);
assertUniqueScenarioIds(registeredScenarios);

export const scenarios: readonly RegisteredScenario[] = Object.freeze(registeredScenarios);

export function findScenario(id: string): RegisteredScenario | undefined {
  return scenarios.find((scenario) => scenario.id === id);
}

function assertUniqueScenarioIds(allScenarios: readonly RegisteredScenario[]): void {
  const seen = new Set<string>();
  for (const scenario of allScenarios) {
    if (seen.has(scenario.id)) throw new Error(`Duplicate scenario id: ${scenario.id}`);
    seen.add(scenario.id);
  }
}

function freezeScenario(scenario: Scenario): RegisteredScenario {
  return Object.freeze({
    ...scenario,
    inputFields: deepFreeze(scenario.inputFields.map((field) => ({ ...field }))) as Scenario["inputFields"]
  });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) {
      deepFreeze((value as Record<PropertyKey, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}
