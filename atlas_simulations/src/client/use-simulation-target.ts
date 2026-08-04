import { useEffect, useMemo, useRef, useState } from "react";
import type { HealthResponse } from "../shared/types.js";
import { loadHealth, loadTargets } from "./api.js";
import { errorMessage } from "./run-state.js";

export function useSimulationTarget({
  clearError,
  reportError
}: {
  clearError: () => void;
  reportError: (error: unknown) => void;
}) {
  const [health, setHealth] = useState<HealthResponse | undefined>();
  const [targets, setTargets] = useState<Awaited<ReturnType<typeof loadTargets>>["targets"]>([]);
  const [selectedTargetId, setSelectedTargetId] = useState("");
  const [deployedMutationConfirmed, setDeployedMutationConfirmed] = useState(false);
  const [apiKeysByTargetId, setApiKeysByTargetId] = useState<Record<string, string>>({});
  const healthRequestRef = useRef(0);
  const effectsRef = useRef({ refreshHealth, reportError });
  effectsRef.current = { refreshHealth, reportError };

  useEffect(() => {
    const { refreshHealth, reportError } = effectsRef.current;
    let cancelled = false;
    void loadTargets()
      .then((loaded) => {
        if (cancelled) return;
        setTargets(loaded.targets);
        const targetId = loaded.targets.some((target) => target.id === loaded.defaultTargetId)
          ? loaded.defaultTargetId
          : (loaded.targets[0]?.id ?? "");
        setSelectedTargetId(targetId);
        return refreshHealth(targetId);
      })
      .catch((errorValue) => {
        if (!cancelled) reportError(errorValue);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedTarget = useMemo(
    () => targets.find((target) => target.id === selectedTargetId),
    [selectedTargetId, targets]
  );
  const selectedApiKey = selectedTargetId ? (apiKeysByTargetId[selectedTargetId] ?? "") : "";

  async function refreshHealth(targetId = selectedTargetId) {
    const requestId = ++healthRequestRef.current;
    try {
      const apiKey = apiKeyForTarget(targetId);
      const nextHealth = apiKey
        ? await loadHealth(targetId || undefined, apiKey)
        : await loadHealth(targetId || undefined);
      if (!applyHealthResponse(requestId, nextHealth)) return;
      clearError();
    } catch (errorValue) {
      if (!applyHealthResponse(requestId, { ok: false, message: errorMessage(errorValue) })) return;
      throw errorValue;
    }
  }

  function applyHealthResponse(requestId: number, nextHealth: HealthResponse): boolean {
    if (requestId !== healthRequestRef.current) return false;
    setHealth(nextHealth);
    return true;
  }

  function selectTarget(targetId: string) {
    setSelectedTargetId(targetId);
    setDeployedMutationConfirmed(false);
    setHealth(undefined);
    clearError();
    void refreshHealth(targetId).catch(reportError);
  }

  function setSelectedApiKey(value: string) {
    if (!selectedTargetId) return;
    setApiKeysByTargetId((current) => ({ ...current, [selectedTargetId]: value }));
  }

  function apiKeyForTarget(targetId: string): string | undefined {
    const trimmed = apiKeysByTargetId[targetId]?.trim();
    return trimmed ? trimmed : undefined;
  }

  function refreshSelectedTarget() {
    clearError();
    void refreshHealth().catch(reportError);
  }

  return {
    health,
    targets,
    selectedTargetId,
    selectedTarget,
    selectedApiKey,
    deployedMutationConfirmed,
    setDeployedMutationConfirmed,
    selectTarget,
    setSelectedApiKey,
    refreshSelectedTarget,
    apiKeyForTarget
  };
}

export type SimulationTargetController = ReturnType<typeof useSimulationTarget>;
