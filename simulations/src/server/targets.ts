import type { AtlasTargetSummary } from "../shared/types.js";
import { type AtlasClientFactory, createAtlasClientFactory } from "./atlas.js";
import { type AtlasTargetConfig, isDeployedAtlasUrl, type SimulationConfig } from "./config.js";
import type { RunTarget } from "./run-store.js";

export type TargetRegistry = {
  targets: Map<string, AtlasTargetConfig>;
  summaries: AtlasTargetSummary[];
  defaultTarget: AtlasTargetConfig;
  defaultTargetId: string;
};

export function createTargetRegistry(config: SimulationConfig): TargetRegistry {
  const configuredTargets = config.atlasTargets;
  const targets = new Map(configuredTargets.map((target) => [target.id, target]));
  const defaultTarget = targets.get(config.defaultAtlasTargetId);
  if (!defaultTarget) throw new Error(`Default Atlas target ${config.defaultAtlasTargetId} is not configured`);
  return {
    targets,
    summaries: configuredTargets.map(targetSummary),
    defaultTarget,
    defaultTargetId: defaultTarget.id
  };
}

export function targetForRequest(
  url: URL,
  registry: TargetRegistry,
  apiKey: string | undefined
): AtlasTargetConfig | undefined {
  return targetForId(url.searchParams.get("target") ?? undefined, registry, apiKey);
}

export function targetForId(
  id: string | undefined,
  registry: TargetRegistry,
  apiKey: string | undefined
): AtlasTargetConfig | undefined {
  const target = id ? registry.targets.get(id) : registry.defaultTarget;
  return target && apiKey ? { ...target, apiKey } : target;
}

export function targetForRun(
  runTarget: Pick<AtlasTargetSummary, "id" | "baseUrl">,
  registry: TargetRegistry,
  apiKey: string | undefined
): AtlasTargetConfig {
  const configured = registry.targets.get(runTarget.id);
  if (apiKey) {
    return {
      id: runTarget.id,
      label: "Recovered deployed Core",
      baseUrl: runTarget.baseUrl,
      apiKey
    };
  }
  if (configured && configured.baseUrl !== runTarget.baseUrl) {
    throw new Error(`Atlas target ${runTarget.id} no longer matches the run cleanup target`);
  }
  return (
    configured ?? {
      id: runTarget.id,
      label: "Recovered deployed Core",
      baseUrl: runTarget.baseUrl
    }
  );
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
    deployed: isDeployedAtlasUrl(target.baseUrl),
    apiKeyConfigured: !!target.apiKey
  };
}
