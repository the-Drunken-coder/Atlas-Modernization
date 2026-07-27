import { useEffect, useMemo, useRef, useState } from "react";
import type { AtlasTargetSummary, HealthResponse, ScenarioDescriptor } from "../shared/types.js";
import { AssertionTable, LogList, ResourceTable, RunTable } from "./AppPanels.js";
import { ControlsPanel, DeployedWarning, RunPanel, ScenarioList, TopBar } from "./AppSections.js";
import { loadHealth, loadScenarios, loadTargets } from "./api.js";
import { errorMessage, type FieldValues } from "./run-state.js";
import { startSelectedRun } from "./start-run.js";
import { useRunSession } from "./use-run-session.js";

export function App() {
  const [health, setHealth] = useState<HealthResponse | undefined>();
  const [targets, setTargets] = useState<AtlasTargetSummary[]>([]);
  const [selectedTargetId, setSelectedTargetId] = useState("");
  const [deployedMutationConfirmed, setDeployedMutationConfirmed] = useState(false);
  const [apiKeysByTargetId, setApiKeysByTargetId] = useState<Record<string, string>>({});
  const [recoveryApiKeysByRunId, setRecoveryApiKeysByRunId] = useState<Record<string, string>>({});
  const [scenarios, setScenarios] = useState<ScenarioDescriptor[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [inputs, setInputs] = useState<FieldValues>({});
  const [jsonInput, setJsonInput] = useState("");
  const healthRequestRef = useRef(0);
  const runSession = useRunSession(setSelectedId);
  const { currentRun, error, events, mutationPending, runs } = runSession;
  const effectsRef = useRef({ refreshHealth, reportError: runSession.reportError });
  effectsRef.current = { refreshHealth, reportError: runSession.reportError };

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
    void loadScenarios()
      .then((loaded) => {
        if (cancelled) return;
        setScenarios(loaded);
        setSelectedId((current) => current || loaded[0]?.id || "");
      })
      .catch((errorValue) => {
        if (!cancelled) reportError(errorValue);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const selected = useMemo(() => scenarios.find((scenario) => scenario.id === selectedId), [scenarios, selectedId]);
  const selectedTarget = useMemo(
    () => targets.find((target) => target.id === selectedTargetId),
    [selectedTargetId, targets]
  );
  const selectedApiKey = selectedTargetId ? (apiKeysByTargetId[selectedTargetId] ?? "") : "";
  useEffect(() => {
    if (!selected) return;
    setInputs(Object.fromEntries(selected.inputFields.map((field) => [field.key, field.defaultValue])));
    setJsonInput("");
  }, [selected]);

  async function refreshHealth(targetId = selectedTargetId) {
    const requestId = ++healthRequestRef.current;
    try {
      const apiKey = apiKeyForTarget(targetId);
      const nextHealth = apiKey
        ? await loadHealth(targetId || undefined, apiKey)
        : await loadHealth(targetId || undefined);
      if (!applyHealthResponse(requestId, nextHealth)) return;
      runSession.clearError();
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
    runSession.clearError();
    void refreshHealth(targetId).catch(runSession.reportError);
  }

  function setSelectedApiKey(value: string) {
    if (!selectedTargetId) return;
    setApiKeyForTarget(selectedTargetId, value);
  }

  function setApiKeyForTarget(targetId: string, value: string) {
    setApiKeysByTargetId((current) => ({ ...current, [targetId]: value }));
  }

  function apiKeyForTarget(targetId: string): string | undefined {
    const trimmed = apiKeysByTargetId[targetId]?.trim();
    return trimmed ? trimmed : undefined;
  }

  function handleStartRun() {
    return startSelectedRun({
      scenario: selected,
      target: selectedTarget,
      mutationPending,
      deployedMutationConfirmed,
      inputs,
      jsonInput,
      apiKeyForTarget,
      clearError: runSession.clearError,
      reportError: runSession.reportError,
      start: runSession.start,
      onDeployedStartSettled: () => setDeployedMutationConfirmed(false)
    });
  }

  function handleRefreshHealth() {
    runSession.clearError();
    void refreshHealth().catch(runSession.reportError);
  }

  function handleInputChange(key: string, value: string | boolean) {
    setInputs((current) => ({ ...current, [key]: value }));
  }

  function handleRecoveryApiKeyChange(runId: string, value: string) {
    setRecoveryApiKeysByRunId((current) => ({ ...current, [runId]: value }));
  }

  function selectScenario(scenarioId: string) {
    setSelectedId(scenarioId);
    runSession.selectScenarioRun(scenarioId);
  }

  async function cleanupCurrentRun() {
    if (!currentRun || mutationPending) return;
    const targetRunId = currentRun.id;
    const recoveryApiKey = recoveryApiKeysByRunId[targetRunId]?.trim();
    const targetApiKey =
      currentRun.status === "abandoned"
        ? recoveryApiKey || undefined
        : currentRun.target
          ? apiKeyForTarget(currentRun.target.id)
          : undefined;
    const updatedRun = await runSession.cleanupCurrentRun(targetApiKey);
    if (updatedRun?.cleaned) {
      setRecoveryApiKeysByRunId((current) => {
        const remaining = { ...current };
        delete remaining[targetRunId];
        return remaining;
      });
    }
  }

  return (
    <main className="app-shell">
      <TopBar
        targets={targets}
        selectedTargetId={selectedTargetId}
        selectedTarget={selectedTarget}
        selectedApiKey={selectedApiKey}
        health={health}
        onSelectTarget={selectTarget}
        onApiKeyChange={setSelectedApiKey}
        onRefreshHealth={handleRefreshHealth}
      />

      {error ? (
        <div className="error-banner" role="alert">
          {error}
        </div>
      ) : null}

      {selectedTarget?.deployed ? (
        <DeployedWarning
          target={selectedTarget}
          confirmed={deployedMutationConfirmed}
          onConfirmedChange={setDeployedMutationConfirmed}
        />
      ) : null}

      <section className="workspace">
        <ScenarioList scenarios={scenarios} selectedId={selectedId} onSelect={selectScenario} />

        <ControlsPanel
          selected={selected}
          selectedTarget={selectedTarget}
          currentRun={currentRun}
          mutationPending={mutationPending}
          deployedMutationConfirmed={deployedMutationConfirmed}
          inputs={inputs}
          jsonInput={jsonInput}
          onStart={() => void handleStartRun()}
          onStop={() => void runSession.stopCurrentRun()}
          onCleanup={() => void cleanupCurrentRun()}
          onInputChange={handleInputChange}
          onJsonInputChange={setJsonInput}
        />

        <RunPanel
          currentRun={currentRun}
          recoveryApiKeys={recoveryApiKeysByRunId}
          onRecoveryApiKeyChange={handleRecoveryApiKeyChange}
        />
      </section>

      <section className="lower-grid">
        <section className="panel">
          <h2>Assertions</h2>
          <AssertionTable run={currentRun} />
        </section>
        <section className="panel">
          <h2>Resources</h2>
          <ResourceTable run={currentRun} />
        </section>
        <section className="panel log-panel">
          <h2>Log</h2>
          <LogList events={events} />
        </section>
        <section className="panel">
          <h2>Recent Runs</h2>
          <RunTable runs={runs} onSelect={runSession.selectRun} />
        </section>
      </section>
    </main>
  );
}
