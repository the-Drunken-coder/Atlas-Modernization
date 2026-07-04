import type { AtlasTargetSummary } from "../shared/types.js";
import { createAtlasClientFactory, type AtlasClientFactory } from "./atlas.js";
import type { AtlasTargetConfig, SimulationConfig } from "./config.js";
import type { RunTarget } from "./run-store.js";

export type TargetRegistry = {
  targets: Map<string, AtlasTargetConfig>;
  summaries: AtlasTargetSummary[];
  defaultTarget: AtlasTargetConfig;
  defaultTargetId: string;
};

export function createTargetRegistry(config: SimulationConfig): TargetRegistry {
  const configuredTargets = config.atlasTargets ?? [
    {
      id: "configured",
      label: "Atlas Core",
      baseUrl: config.atlasBaseUrl,
      ...(config.atlasApiKey ? { apiKey: config.atlasApiKey } : {})
    }
  ];
  const targets = new Map(configuredTargets.map((target) => [target.id, target]));
  const defaultTarget = (config.defaultAtlasTargetId ? targets.get(config.defaultAtlasTargetId) : undefined) ?? configuredTargets[0];
  if (!defaultTarget) throw new Error("At least one Atlas target is required");
  return {
    targets,
    summaries: configuredTargets.map(targetSummary),
    defaultTarget,
    defaultTargetId: defaultTarget.id
  };
}

export function targetForRequest(url: URL, registry: TargetRegistry, apiKey: string | undefined): AtlasTargetConfig | undefined {
  return targetForId(url.searchParams.get("target") ?? undefined, registry, apiKey);
}

export function targetForId(id: string | undefined, registry: TargetRegistry, apiKey: string | undefined): AtlasTargetConfig | undefined {
  const target = id ? registry.targets.get(id) : registry.defaultTarget;
  return target && apiKey ? { ...target, apiKey } : target;
}

export function runTarget(target: AtlasTargetConfig, includeClientFactory: boolean): RunTarget {
  return {
    ...targetSummary(target),
    ...(includeClientFactory ? { clientFactory: clientFactoryForTarget(target) } : {})
  };
}

export function clientFactoryForTarget(target: AtlasTargetConfig): AtlasClientFactory {
  return target.clientFactory ?? createAtlasClientFactory(target);
}

export function targetSummary(target: AtlasTargetConfig): AtlasTargetSummary {
  return {
    id: target.id,
    label: target.label,
    baseUrl: target.baseUrl,
    apiKeyConfigured: !!target.apiKey
  };
}
