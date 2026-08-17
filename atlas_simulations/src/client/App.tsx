import { Play, Square, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ScenarioDescriptor } from "../shared/types.js";
import { AssertionTable, LogList, ResourceTable, RunDetails, RunTable } from "./AppPanels.js";
import { loadScenarios } from "./api.js";
import { buildStartRunRequest, displayStatus, type FieldValues } from "./run-state.js";
import { SimulationTargetControls } from "./SimulationTargetControls.js";
import { useRunSession } from "./use-run-session.js";
import { useSimulationTarget } from "./use-simulation-target.js";

function defaultInputs(scenario: ScenarioDescriptor): FieldValues {
  return Object.fromEntries(scenario.inputFields.map((field) => [field.key, field.defaultValue]));
}

type ScenarioFormState = { selectedId: string; inputs: FieldValues; jsonInput: string };

function selectScenarioForm(
  current: ScenarioFormState,
  scenarioId: string,
  scenarios: ScenarioDescriptor[]
): ScenarioFormState {
  const scenario = scenarios.find((candidate) => candidate.id === scenarioId);
  return scenario
    ? { selectedId: scenarioId, inputs: defaultInputs(scenario), jsonInput: "" }
    : { ...current, selectedId: scenarioId };
}

export function App() {
  const [recoveryApiKeysByRunId, setRecoveryApiKeysByRunId] = useState<Record<string, string>>({});
  const [scenarios, setScenarios] = useState<ScenarioDescriptor[]>([]);
  const [scenarioForm, setScenarioForm] = useState<ScenarioFormState>({ selectedId: "", inputs: {}, jsonInput: "" });
  const { selectedId, inputs, jsonInput } = scenarioForm;

  function selectScenarioState(scenarioId: string, availableScenarios = scenarios) {
    setScenarioForm((current) => selectScenarioForm(current, scenarioId, availableScenarios));
  }

  function setInput(name: string, value: FieldValues[string]) {
    setScenarioForm((current) => ({ ...current, inputs: { ...current.inputs, [name]: value } }));
  }

  const runSession = useRunSession(selectScenarioState);
  const { currentRun, error, events, mutationPending, runs } = runSession;
  const target = useSimulationTarget({ clearError: runSession.clearError, reportError: runSession.reportError });
  const { selectedTarget, deployedMutationConfirmed, setDeployedMutationConfirmed, apiKeyForTarget } = target;
  const reportErrorRef = useRef(runSession.reportError);
  reportErrorRef.current = runSession.reportError;

  useEffect(() => {
    let cancelled = false;
    void loadScenarios()
      .then((loaded) => {
        if (cancelled) return;
        setScenarios(loaded);
        setScenarioForm((current) => selectScenarioForm(current, current.selectedId || loaded[0]?.id || "", loaded));
      })
      .catch((errorValue) => {
        if (!cancelled) reportErrorRef.current(errorValue);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const selected = scenarios.find((scenario) => scenario.id === selectedId);

  async function startSelectedRun() {
    if (!selected || !selectedTarget || mutationPending || (selectedTarget.deployed && !deployedMutationConfirmed))
      return;
    const deployedStart = selectedTarget.deployed;
    runSession.clearError();
    try {
      const request = buildStartRunRequest(selected, selectedTarget, inputs, jsonInput, deployedMutationConfirmed);
      const apiKey = apiKeyForTarget(selectedTarget.id);
      await runSession.start(request, apiKey);
    } catch (errorValue) {
      runSession.reportError(errorValue);
    } finally {
      if (deployedStart) setDeployedMutationConfirmed(false);
    }
  }

  function selectScenario(scenarioId: string) {
    selectScenarioState(scenarioId);
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
      <SimulationTargetControls target={target} />

      {error ? (
        <div className="error-banner" role="alert">
          {error}
        </div>
      ) : null}

      <section className="workspace">
        <aside className="panel scenario-panel">
          <h2>Scenarios</h2>
          <div className="scenario-list">
            {scenarios.map((scenario) => (
              <button
                className={`scenario-option ${scenario.id === selectedId ? "selected" : ""}`}
                type="button"
                key={scenario.id}
                aria-pressed={scenario.id === selectedId}
                aria-label={`${scenario.name} ${scenario.summary}`}
                onClick={() => selectScenario(scenario.id)}
              >
                <span>{scenario.name}</span>
                <small>{scenario.summary}</small>
              </button>
            ))}
          </div>
        </aside>

        <section className="panel controls-panel">
          <div className="panel-head">
            <h2>{selected?.name ?? "Scenario"}</h2>
            <div className="actions">
              <button
                className={selectedTarget?.deployed ? "danger" : "primary"}
                type="button"
                title={selectedTarget?.deployed ? "Start run on deployed Core" : "Start run"}
                onClick={() => void startSelectedRun()}
                disabled={
                  mutationPending ||
                  !selected ||
                  !selectedTarget ||
                  (selectedTarget.deployed && !deployedMutationConfirmed)
                }
              >
                <Play size={16} aria-hidden="true" />
                {selectedTarget?.deployed ? "Start on deployed Core" : "Start"}
              </button>
              <button
                type="button"
                title="Stop run"
                onClick={() => void runSession.stopCurrentRun()}
                disabled={mutationPending || currentRun?.status !== "running"}
              >
                <Square size={16} aria-hidden="true" />
                Stop
              </button>
              <button
                type="button"
                title="Cleanup run resources"
                onClick={() => void cleanupCurrentRun()}
                disabled={mutationPending || !currentRun || currentRun.status === "running" || currentRun.cleaned}
              >
                <Trash2 size={16} aria-hidden="true" />
                Cleanup
              </button>
            </div>
          </div>

          <div className="input-grid">
            {selected?.inputFields.map((field) => (
              <label key={field.key} className="field">
                <span>{field.label}</span>
                {field.type === "boolean" ? (
                  <input
                    type="checkbox"
                    checked={Boolean(inputs[field.key])}
                    onChange={(event) => setInput(field.key, event.target.checked)}
                  />
                ) : field.type === "number" ? (
                  <input
                    type="number"
                    value={String(inputs[field.key] ?? "")}
                    min={field.min}
                    max={field.max}
                    step={field.step}
                    onChange={(event) => {
                      setInput(field.key, event.target.value);
                    }}
                  />
                ) : field.type === "text" ? (
                  <input
                    type="text"
                    value={String(inputs[field.key] ?? "")}
                    onChange={(event) => setInput(field.key, event.target.value)}
                  />
                ) : null}
              </label>
            ))}
          </div>

          {selected?.acceptsJson ? (
            <label className="json-field">
              <span>JSON input</span>
              <textarea
                value={jsonInput}
                onChange={(event) => setScenarioForm((current) => ({ ...current, jsonInput: event.target.value }))}
                spellCheck={false}
              />
            </label>
          ) : null}
        </section>

        <section className="panel run-panel">
          <div className="panel-head">
            <h2>Run</h2>
            <span className={`status-pill ${displayStatus(currentRun)}`}>{displayStatus(currentRun)}</span>
          </div>
          <RunDetails run={currentRun} />
          {currentRun?.status === "abandoned" && currentRun.target?.deployed ? (
            <div className="recovery-key-field">
              <label htmlFor="recovery-cleanup-api-key">Cleanup API key</label>
              <input
                id="recovery-cleanup-api-key"
                type="password"
                value={recoveryApiKeysByRunId[currentRun.id] ?? ""}
                onChange={(event) =>
                  setRecoveryApiKeysByRunId((current) => ({ ...current, [currentRun.id]: event.target.value }))
                }
                autoComplete="off"
                spellCheck={false}
                placeholder="Paste current key if required"
                aria-describedby="recovery-cleanup-api-key-help"
              />
              <small id="recovery-cleanup-api-key-help">
                Kept only in this browser tab and sent with explicit cleanup.
              </small>
            </div>
          ) : null}
        </section>
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
          <RunTable runs={runs} selectedRunId={currentRun?.id} onSelect={runSession.selectRun} />
        </section>
      </section>
    </main>
  );
}
