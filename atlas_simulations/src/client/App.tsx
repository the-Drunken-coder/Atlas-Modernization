import { Activity, CircleAlert, Play, RefreshCw, Square, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AtlasTargetSummary, HealthResponse, ScenarioDescriptor, StartRunRequest } from "../shared/types.js";
import { AssertionTable, LogList, ResourceTable, RunDetails, RunTable } from "./AppPanels.js";
import { loadHealth, loadScenarios, loadTargets } from "./api.js";
import { displayStatus, errorMessage, type FieldValues, submissionInputs } from "./run-state.js";
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

  async function startSelectedRun() {
    if (!selected || !selectedTarget || mutationPending || (selectedTarget.deployed && !deployedMutationConfirmed))
      return;
    const deployedStart = selectedTarget.deployed;
    runSession.clearError();
    try {
      const normalizedJsonInput = selected.acceptsJson && jsonInput.trim() !== "" ? jsonInput : undefined;
      if (normalizedJsonInput !== undefined) {
        try {
          JSON.parse(normalizedJsonInput);
        } catch {
          throw new Error("JSON input must be valid JSON");
        }
      }
      const request: StartRunRequest = {
        scenarioId: selected.id,
        targetId: selectedTarget.id,
        ...(selectedTarget.deployed ? { confirmDeployedMutation: true } : {}),
        inputs: submissionInputs(selected, inputs),
        ...(normalizedJsonInput ? { jsonInput: normalizedJsonInput } : {})
      };
      const apiKey = apiKeyForTarget(selectedTarget.id);
      await runSession.start(request, apiKey);
    } catch (errorValue) {
      runSession.reportError(errorValue);
    } finally {
      if (deployedStart) setDeployedMutationConfirmed(false);
    }
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
      <header className="topbar">
        <div>
          <h1>Atlas Simulations</h1>
          <div className="subtle">Atlas Core</div>
        </div>
        <div className="topbar-controls">
          <label className="target-menu">
            <span>API</span>
            <select
              value={selectedTargetId}
              onChange={(event) => selectTarget(event.target.value)}
              disabled={!targets.length}
              title={selectedTarget?.baseUrl}
            >
              {targets.map((target) => (
                <option key={target.id} value={target.id}>
                  {target.label} ({target.baseUrl})
                </option>
              ))}
            </select>
          </label>
          <label className="api-key-field">
            <span>API key</span>
            <input
              type="password"
              value={selectedApiKey}
              onChange={(event) => setSelectedApiKey(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              placeholder="Paste key"
            />
          </label>
          <div className={`health ${health ? (health.ok ? "ok" : "bad") : ""}`} role="status" aria-live="polite">
            <Activity size={18} aria-hidden="true" />
            <span>{health ? (health.ok ? "Core reachable" : "Core offline") : "Checking"}</span>
            <button
              className="icon-button"
              type="button"
              title="Refresh Core status"
              aria-label="Refresh Core status"
              onClick={() => {
                runSession.clearError();
                void refreshHealth().catch(runSession.reportError);
              }}
            >
              <RefreshCw size={16} aria-hidden="true" />
            </button>
          </div>
        </div>
      </header>

      {error ? (
        <div className="error-banner" role="alert">
          {error}
        </div>
      ) : null}

      {selectedTarget?.deployed ? (
        <section className="deployed-warning" role="alert" aria-labelledby="deployed-warning-title">
          <CircleAlert size={24} aria-hidden="true" />
          <div className="deployed-warning-content">
            <strong id="deployed-warning-title">Deployed Core selected</strong>
            <p>
              Starting a simulation will mutate remote resources on <strong>{selectedTarget.label}</strong> at{" "}
              <code>{selectedTarget.baseUrl}</code>. Cleanup is explicit.
            </p>
            <label className="deployed-confirmation">
              <input
                type="checkbox"
                checked={deployedMutationConfirmed}
                onChange={(event) => setDeployedMutationConfirmed(event.target.checked)}
              />
              <span>I understand this start will mutate the deployed Core.</span>
            </label>
          </div>
        </section>
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
                    onChange={(event) => setInputs((current) => ({ ...current, [field.key]: event.target.checked }))}
                  />
                ) : field.type === "number" ? (
                  <input
                    type="number"
                    value={String(inputs[field.key] ?? "")}
                    min={field.min}
                    max={field.max}
                    step={field.step}
                    onChange={(event) => {
                      const rawValue = event.target.value;
                      setInputs((current) => ({
                        ...current,
                        [field.key]: rawValue
                      }));
                    }}
                  />
                ) : field.type === "text" ? (
                  <input
                    type="text"
                    value={String(inputs[field.key] ?? "")}
                    onChange={(event) =>
                      setInputs((current) => ({
                        ...current,
                        [field.key]: event.target.value
                      }))
                    }
                  />
                ) : null}
              </label>
            ))}
          </div>

          {selected?.acceptsJson ? (
            <label className="json-field">
              <span>JSON input</span>
              <textarea value={jsonInput} onChange={(event) => setJsonInput(event.target.value)} spellCheck={false} />
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
          <RunTable runs={runs} onSelect={runSession.selectRun} />
        </section>
      </section>
    </main>
  );
}
