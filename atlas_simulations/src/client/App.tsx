import { Activity, CircleAlert, Play, RefreshCw, Square, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AtlasTargetSummary,
  HealthResponse,
  RunEvent,
  RunSummary,
  ScenarioDescriptor,
  StartRunRequest
} from "../shared/types.js";
import { AssertionTable, LogList, ResourceTable, RunDetails, RunTable } from "./AppPanels.js";
import { cleanupRun, loadHealth, loadRuns, loadScenarios, loadTargets, startRun, stopRun } from "./api.js";
import {
  appendRunEvent,
  applyRunEvent,
  displayStatus,
  errorMessage,
  type FieldValues,
  isTerminalStatus,
  mergeRunLists,
  mergeRunSummary,
  parseRunEvent,
  submissionInputs
} from "./run-state.js";

const ACTIVE_RUN_REFRESH_MS = 2_000;

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
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [currentRun, setCurrentRun] = useState<RunSummary | undefined>();
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [mutationPending, setMutationPending] = useState(false);
  const [cleanupRunId, setCleanupRunId] = useState<string | undefined>();
  const eventSourceRef = useRef<EventSource | null>(null);
  const activeRunIdRef = useRef<string | undefined>(undefined);
  const cleanupStreamRunIdRef = useRef<string | undefined>(undefined);
  const currentRunIdRef = useRef<string | undefined>(undefined);
  const healthRequestRef = useRef(0);
  const refreshRunsRequestRef = useRef(0);
  const runsRef = useRef<RunSummary[]>([]);
  const eventsByRunIdRef = useRef<Map<string, RunEvent[]>>(new Map());
  const effectsRef = useRef({ captureError, refreshHealth, refreshRuns, refreshRunsBestEffort });
  effectsRef.current = { captureError, refreshHealth, refreshRuns, refreshRunsBestEffort };

  useEffect(() => {
    const { captureError, refreshHealth, refreshRuns } = effectsRef.current;
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
        if (!cancelled) captureError(errorValue);
      });
    void loadScenarios()
      .then((loaded) => {
        if (cancelled) return;
        setScenarios(loaded);
        setSelectedId((current) => current || loaded[0]?.id || "");
      })
      .catch((errorValue) => {
        if (!cancelled) captureError(errorValue);
      });
    void refreshRuns().catch((errorValue) => {
      if (!cancelled) captureError(errorValue);
    });
    return () => {
      cancelled = true;
      activeRunIdRef.current = undefined;
      eventSourceRef.current?.close();
    };
  }, []);

  const selected = useMemo(() => scenarios.find((scenario) => scenario.id === selectedId), [scenarios, selectedId]);
  const selectedTarget = useMemo(
    () => targets.find((target) => target.id === selectedTargetId),
    [selectedTargetId, targets]
  );
  const selectedApiKey = selectedTargetId ? (apiKeysByTargetId[selectedTargetId] ?? "") : "";
  const hasRunningRuns = useMemo(() => runs.some((run) => run.status === "running"), [runs]);
  const hasCleanupInFlight = useMemo(
    () => !!cleanupRunId && runs.some((run) => run.id === cleanupRunId && !run.cleaned),
    [cleanupRunId, runs]
  );

  useEffect(() => {
    runsRef.current = runs;
  }, [runs]);

  useEffect(() => {
    currentRunIdRef.current = currentRun?.id;
  }, [currentRun?.id]);

  useEffect(() => {
    if (!selected) return;
    setInputs(Object.fromEntries(selected.inputFields.map((field) => [field.key, field.defaultValue])));
    setJsonInput("");
  }, [selected]);

  useEffect(() => {
    if (!hasRunningRuns && !hasCleanupInFlight) return;
    const interval = window.setInterval(() => void effectsRef.current.refreshRunsBestEffort(), ACTIVE_RUN_REFRESH_MS);
    return () => window.clearInterval(interval);
  }, [hasCleanupInFlight, hasRunningRuns]);

  async function refreshHealth(targetId = selectedTargetId) {
    const requestId = ++healthRequestRef.current;
    try {
      const apiKey = apiKeyForTarget(targetId);
      const nextHealth = apiKey
        ? await loadHealth(targetId || undefined, apiKey)
        : await loadHealth(targetId || undefined);
      if (!applyHealthResponse(requestId, nextHealth)) return;
      setError(undefined);
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
    setError(undefined);
    void refreshHealth(targetId).catch(captureError);
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

  async function refreshRuns() {
    const requestId = ++refreshRunsRequestRef.current;
    const runIdsAtRequestStart = new Set(runsRef.current.map((run) => run.id));
    const loadedRuns = await loadRuns();
    if (requestId !== refreshRunsRequestRef.current) return;
    const mergedRuns = mergeRunLists(runsRef.current, loadedRuns, runIdsAtRequestStart);
    const mergedRunIds = new Set(mergedRuns.map((run) => run.id));
    for (const runId of eventsByRunIdRef.current.keys()) {
      if (!mergedRunIds.has(runId)) eventsByRunIdRef.current.delete(runId);
    }
    runsRef.current = mergedRuns;
    setRuns(mergedRuns);
    setError(undefined);
    const selectedRunAfterLoad = selectedRunId();
    if (selectedRunAfterLoad && !mergedRuns.some((run) => run.id === selectedRunAfterLoad)) {
      clearRunSelection();
      return;
    }
    const refreshedSelection = selectedRunAfterLoad
      ? mergedRuns.find((run) => run.id === selectedRunAfterLoad)
      : undefined;
    if (
      refreshedSelection?.status !== "running" &&
      activeRunIdRef.current === selectedRunAfterLoad &&
      cleanupStreamRunIdRef.current !== selectedRunAfterLoad
    ) {
      closeActiveEventSource();
    }
    const needsCleanupReconnect =
      cleanupRunId === selectedRunAfterLoad && !!refreshedSelection && !refreshedSelection.cleaned;
    setCurrentRun((current) => {
      if (!current) return current;
      const refreshed = mergedRuns.find((run) => run.id === current.id);
      return refreshed ? mergeRunSummary(current, refreshed) : current;
    });
    if (
      selectedRunAfterLoad &&
      refreshedSelection &&
      activeRunIdRef.current !== selectedRunAfterLoad &&
      (refreshedSelection.status === "running" || needsCleanupReconnect)
    ) {
      if (needsCleanupReconnect) cleanupStreamRunIdRef.current = selectedRunAfterLoad;
      connectEvents(selectedRunAfterLoad, { preserveCleanup: needsCleanupReconnect });
    }
  }

  async function refreshRunsBestEffort() {
    try {
      await refreshRuns();
    } catch (errorValue) {
      captureError(errorValue);
    }
  }

  function captureError(errorValue: unknown) {
    setError(errorMessage(errorValue));
  }

  async function startSelectedRun() {
    if (!selected || !selectedTarget || mutationPending || (selectedTarget.deployed && !deployedMutationConfirmed))
      return;
    const deployedStart = selectedTarget.deployed;
    setError(undefined);
    setMutationPending(true);
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
      const run = apiKey ? await startRun(request, apiKey) : await startRun(request);
      upsertRun(run);
      selectRun(run);
      await refreshRunsBestEffort();
    } catch (errorValue) {
      captureError(errorValue);
    } finally {
      if (deployedStart) setDeployedMutationConfirmed(false);
      setMutationPending(false);
    }
  }

  function selectRun(run: RunSummary) {
    setSelectedId(run.scenarioId);
    activateRun(run);
  }

  function selectScenario(scenarioId: string) {
    setSelectedId(scenarioId);
    const scenarioRun = runs.find((run) => run.scenarioId === scenarioId);
    if (scenarioRun) {
      activateRun(scenarioRun);
      return;
    }
    clearRunSelection();
  }

  function activateRun(run: RunSummary) {
    const needsCleanupStream = cleanupStreamRunIdRef.current === run.id && !run.cleaned;
    const cachedEvents = eventsByRunIdRef.current.get(run.id) ?? [];
    const needsReplayStream = run.status !== "running" && cachedEvents.length === 0;
    currentRunIdRef.current = run.id;
    if (currentRun?.id === run.id) {
      setCurrentRun((current) => (current ? { ...current, ...run } : run));
      if (run.status === "running" || needsCleanupStream || needsReplayStream) {
        if (activeRunIdRef.current !== run.id) connectEvents(run.id, { preserveCleanup: needsCleanupStream });
      } else if (activeRunIdRef.current === run.id && cleanupStreamRunIdRef.current !== run.id) {
        closeActiveEventSource({ preserveCleanup: true });
      }
      return;
    }
    setEvents(cachedEvents);
    setCurrentRun(run);
    if (run.status === "running" || needsCleanupStream || needsReplayStream) {
      connectEvents(run.id, { preserveCleanup: needsCleanupStream });
    } else {
      closeActiveEventSource({ preserveCleanup: true });
    }
  }

  function clearRunSelection() {
    currentRunIdRef.current = undefined;
    setEvents([]);
    setCurrentRun(undefined);
    closeActiveEventSource({ preserveCleanup: true });
  }

  function connectEvents(runId: string, options: { preserveCleanup?: boolean } = {}) {
    closeActiveEventSource({ preserveCleanup: options.preserveCleanup });
    activeRunIdRef.current = runId;
    if (!options.preserveCleanup) cleanupStreamRunIdRef.current = undefined;
    const source = new EventSource(`/api/runs/${encodeURIComponent(runId)}/events`);
    eventSourceRef.current = source;
    const closeSource = () => {
      if (activeRunIdRef.current === runId && eventSourceRef.current === source) {
        activeRunIdRef.current = undefined;
        if (cleanupStreamRunIdRef.current === runId) cleanupStreamRunIdRef.current = undefined;
        eventSourceRef.current = null;
        source.close();
      }
    };
    source.onmessage = (message) => {
      if (activeRunIdRef.current !== runId) return;
      let event: RunEvent;
      try {
        event = parseRunEvent(JSON.parse(message.data));
      } catch {
        captureError(new Error(`Invalid event payload for run ${runId}`));
        closeSource();
        return;
      }
      if (event.runId !== runId) {
        captureError(new Error(`Received event for ${event.runId} on stream for ${runId}`));
        closeSource();
        return;
      }
      const nextEvents = appendRunEvent(eventsByRunIdRef.current.get(runId) ?? [], event);
      if (!nextEvents) return;
      eventsByRunIdRef.current.set(runId, nextEvents);
      if (currentRunIdRef.current === runId) setEvents(nextEvents);
      setCurrentRun((current) => (current?.id === runId ? applyRunEvent(current, event) : current));
      setRuns((current) => {
        const next = current.map((run) => (run.id === runId ? applyRunEvent(run, event) : run));
        runsRef.current = next;
        return next;
      });
      if (event.type === "status" && isTerminalStatus(event.status) && cleanupStreamRunIdRef.current !== runId)
        closeSource();
      if (event.type === "cleanup" && !event.resource) {
        setCleanupRunId((current) => (current === runId ? undefined : current));
        closeSource();
      }
    };
    source.onerror = () => {
      void refreshRunsBestEffort();
    };
  }

  async function stopCurrentRun() {
    if (!currentRun || mutationPending) return;
    const targetRunId = currentRun.id;
    setError(undefined);
    setMutationPending(true);
    try {
      const updatedRun = await stopRun(targetRunId);
      upsertRun(updatedRun);
      await refreshRunsBestEffort();
    } catch (errorValue) {
      captureError(errorValue);
    } finally {
      setMutationPending(false);
    }
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
    setError(undefined);
    setMutationPending(true);
    try {
      cleanupStreamRunIdRef.current = targetRunId;
      if (activeRunIdRef.current !== targetRunId) connectEvents(targetRunId, { preserveCleanup: true });
      setCleanupRunId(targetRunId);
      const updatedRun = targetApiKey ? await cleanupRun(targetRunId, targetApiKey) : await cleanupRun(targetRunId);
      upsertRun(updatedRun);
      if (updatedRun.cleaned && cleanupStreamRunIdRef.current === targetRunId) {
        cleanupStreamRunIdRef.current = undefined;
        if (activeRunIdRef.current === targetRunId) closeActiveEventSource();
      }
      if (updatedRun.cleaned) {
        setCleanupRunId(undefined);
        setRecoveryApiKeysByRunId((current) => {
          const remaining = { ...current };
          delete remaining[targetRunId];
          return remaining;
        });
      }
      await refreshRunsBestEffort();
    } catch (errorValue) {
      if (cleanupStreamRunIdRef.current === targetRunId) {
        cleanupStreamRunIdRef.current = undefined;
        if (activeRunIdRef.current === targetRunId) closeActiveEventSource();
      }
      setCleanupRunId(undefined);
      captureError(errorValue);
    } finally {
      setMutationPending(false);
    }
  }

  function upsertRun(run: RunSummary) {
    setRuns((current) => {
      const index = current.findIndex((existing) => existing.id === run.id);
      if (index === -1) {
        const next = [run, ...current];
        runsRef.current = next;
        return next;
      }
      const next = [...current];
      next[index] = mergeRunSummary(next[index], run);
      runsRef.current = next;
      return next;
    });
    setCurrentRun((current) => (current?.id === run.id ? mergeRunSummary(current, run) : current));
  }

  function closeActiveEventSource(options: { preserveCleanup?: boolean } = {}) {
    if (!eventSourceRef.current) return;
    const source = eventSourceRef.current;
    activeRunIdRef.current = undefined;
    if (!options.preserveCleanup) cleanupStreamRunIdRef.current = undefined;
    eventSourceRef.current = null;
    source.close();
  }

  function selectedRunId(): string | undefined {
    return activeRunIdRef.current ?? currentRunIdRef.current;
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
                setError(undefined);
                void refreshHealth().catch(captureError);
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
                onClick={() => void stopCurrentRun()}
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
          <RunTable runs={runs} onSelect={selectRun} />
        </section>
      </section>
    </main>
  );
}
