import type { AtlasTargetSummary, ScenarioDescriptor, StartRunRequest } from "../shared/types.js";
import { type FieldValues, submissionInputs } from "./run-state.js";

export type StartSelectedRunOptions = {
  scenario: ScenarioDescriptor | undefined;
  target: AtlasTargetSummary | undefined;
  mutationPending: boolean;
  deployedMutationConfirmed: boolean;
  inputs: FieldValues;
  jsonInput: string;
  apiKeyForTarget(targetId: string): string | undefined;
  clearError(): void;
  reportError(errorValue: unknown): void;
  start(request: StartRunRequest, apiKey?: string): Promise<unknown>;
  onDeployedStartSettled(): void;
};

export async function startSelectedRun(options: StartSelectedRunOptions): Promise<void> {
  const { scenario, target } = options;
  if (!scenario || !target || options.mutationPending || (target.deployed && !options.deployedMutationConfirmed))
    return;
  const deployedStart = target.deployed;
  options.clearError();
  try {
    const request = buildStartRunRequest(scenario, target, options.inputs, options.jsonInput);
    await options.start(request, options.apiKeyForTarget(target.id));
  } catch (errorValue) {
    options.reportError(errorValue);
  } finally {
    if (deployedStart) options.onDeployedStartSettled();
  }
}

export function buildStartRunRequest(
  scenario: ScenarioDescriptor,
  target: AtlasTargetSummary,
  inputs: FieldValues,
  jsonInput: string
): StartRunRequest {
  const normalizedJsonInput = scenario.acceptsJson && jsonInput.trim() !== "" ? jsonInput : undefined;
  if (normalizedJsonInput !== undefined) {
    try {
      JSON.parse(normalizedJsonInput);
    } catch {
      throw new Error("JSON input must be valid JSON");
    }
  }
  return {
    scenarioId: scenario.id,
    targetId: target.id,
    ...(target.deployed ? { confirmDeployedMutation: true } : {}),
    inputs: submissionInputs(scenario, inputs),
    ...(normalizedJsonInput ? { jsonInput: normalizedJsonInput } : {})
  };
}
