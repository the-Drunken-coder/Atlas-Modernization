import { Activity, CheckCircle2, CircleAlert, Play, RefreshCw, Square, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { isCreatedResource, jsonNumber, type AtlasTargetSummary, type HealthResponse, type RunEvent, type RunSummary, type ScenarioDescriptor, type StartRunRequest } from "../shared/types.js";
import { cleanupRun, loadHealth, loadRuns, loadScenarios, loadTargets, startRun, stopRun } from "./api.js";

type FieldValues = Record<string, string | number | boolean>;

const MAX_CLIENT_EVENTS = 500;
const ACTIVE_RUN_REFRESH_MS = 2_000;

export function App() {
  const [health, setHealth] = useState<HealthResponse | undefined>();
  const [targets, setTargets] = useState<AtlasTargetSummary[]>([]);
  const [selectedTargetId, setSelectedTargetId] = useState("");
  const [apiKeysByTargetId, setApiKeysByTargetId] = useState<Record<string, string>>({});
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

  useEffect(() => {
    void loadTargets().then((loaded) => {
      setTargets(loaded.targets);
      const targetId = loaded.targets.some((target) => target.id === loaded.defaultTargetId) ? loaded.defaultTargetId : loaded.targets[0]?.id ?? "";
      setSelectedTargetId(targetId);
      return refreshHealth(targetId);
    }).catch(captureError);
    void loadScenarios().then((loaded) => {
      setScenarios(loaded);
      setSelectedId((current) => current || loaded[0]?.id || "");
    }).catch(captureError);
    void refreshRuns().catch(captureError);
    return () => {
      activeRunIdRef.current = undefined;
      eventSourceRef.current?.close();
    };
  }, []);

  const selected = useMemo(() => scenarios.find((scenario) => scenario.id === selectedId), [scenarios, selectedId]);
  const selectedTarget = useMemo(() => targets.find((target) => target.id === selectedTargetId), [selectedTargetId, targets]);
  const selectedApiKey = selectedTargetId ? apiKeysByTargetId[selectedTargetId] ?? "" : "";
  const hasRunningRuns = useMemo(() => runs.some((run) => run.status === "running"), [runs]);
  const hasCleanupInFlight = useMemo(() => !!cleanupRunId && runs.some((run) => run.id === cleanupRunId && !run.cleaned), [cleanupRunId, runs]);

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
    const interval = window.setInterval(() => void refreshRunsBestEffort(), ACTIVE_RUN_REFRESH_MS);
    return () => window.clearInterval(interval);
  }, [hasCleanupInFlight, hasRunningRuns]);

  async function refreshHealth(targetId = selectedTargetId) {
    const requestId = ++healthRequestRef.current;
    try {
      const apiKey = apiKeyForTarget(targetId);
      const nextHealth = apiKey ? await loadHealth(targetId || undefined, apiKey) : await loadHealth(targetId || undefined);
      if (requestId !== healthRequestRef.current) return;
      setHealth(nextHealth);
      setError(undefined);
    } catch (errorValue) {
      if (requestId !== healthRequestRef.current) return;
      setHealth({ ok: false, message: errorMessage(errorValue) });
      throw errorValue;
    }
  }

  function selectTarget(targetId: string) {
    setSelectedTargetId(targetId);
    setError(undefined);
    void refreshHealth(targetId).catch(captureError);
  }

  function setSelectedApiKey(value: string) {
    if (!selectedTargetId) return;
    setApiKeysByTargetId((current) => ({ ...current, [selectedTargetId]: value }));
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
    const refreshedSelection = selectedRunAfterLoad ? mergedRuns.find((run) => run.id === selectedRunAfterLoad) : undefined;
    if (refreshedSelection?.status !== "running" && activeRunIdRef.current === selectedRunAfterLoad && cleanupStreamRunIdRef.current !== selectedRunAfterLoad) {
      closeActiveEventSource();
    }
    const needsCleanupReconnect = cleanupRunId === selectedRunAfterLoad && !!refreshedSelection && !refreshedSelection.cleaned;
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
    if (!selected || mutationPending) return;
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
        ...(selectedTargetId ? { targetId: selectedTargetId } : {}),
        inputs: submissionInputs(selected, inputs),
        ...(normalizedJsonInput ? { jsonInput: normalizedJsonInput } : {})
      };
      const apiKey = apiKeyForTarget(selectedTargetId);
      const run = apiKey ? await startRun(request, apiKey) : await startRun(request);
      upsertRun(run);
      selectRun(run);
      await refreshRunsBestEffort();
    } catch (errorValue) {
      captureError(errorValue);
    } finally {
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
      if (event.type === "status" && isTerminalStatus(event.status) && cleanupStreamRunIdRef.current !== runId) closeSource();
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
    setError(undefined);
    setMutationPending(true);
    try {
      cleanupStreamRunIdRef.current = targetRunId;
      if (activeRunIdRef.current !== targetRunId) connectEvents(targetRunId, { preserveCleanup: true });
      setCleanupRunId(targetRunId);
      const updatedRun = await cleanupRun(targetRunId);
      upsertRun(updatedRun);
      if (updatedRun.cleaned && cleanupStreamRunIdRef.current === targetRunId) {
        cleanupStreamRunIdRef.current = undefined;
        if (activeRunIdRef.current === targetRunId) closeActiveEventSource();
      }
      if (updatedRun.cleaned) setCleanupRunId(undefined);
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
            <select value={selectedTargetId} onChange={(event) => selectTarget(event.target.value)} disabled={!targets.length} title={selectedTarget?.baseUrl}>
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
          <div className={`health ${health ? (health.ok ? "ok" : "bad") : ""}`}>
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

      {error ? <div className="error-banner" role="alert">{error}</div> : null}

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
              <button className="primary" type="button" title="Start run" onClick={() => void startSelectedRun()} disabled={mutationPending || !selected}>
                <Play size={16} aria-hidden="true" />
                Start
              </button>
              <button type="button" title="Stop run" onClick={() => void stopCurrentRun()} disabled={mutationPending || currentRun?.status !== "running"}>
                <Square size={16} aria-hidden="true" />
                Stop
              </button>
              <button type="button" title="Cleanup run resources" onClick={() => void cleanupCurrentRun()} disabled={mutationPending || !currentRun || currentRun.status === "running" || currentRun.cleaned}>
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

function RunDetails({ run }: { run: RunSummary | undefined }) {
  if (!run) return <div className="empty">No run selected</div>;
  return (
    <dl className="run-details">
      <div><dt>ID</dt><dd>{run.id}</dd></div>
      <div><dt>Scenario</dt><dd>{run.scenarioName}</dd></div>
      <div><dt>API</dt><dd>{run.target ? `${run.target.label} (${run.target.baseUrl})` : "-"}</dd></div>
      <div><dt>Started</dt><dd>{formatTime(run.startedAt)}</dd></div>
      <div><dt>Finished</dt><dd>{run.finishedAt ? formatTime(run.finishedAt) : "-"}</dd></div>
      <div><dt>Created</dt><dd>{run.createdResources.length}</dd></div>
      <div><dt>Checks</dt><dd>{run.assertions.filter((assertion) => assertion.passed).length}/{run.assertions.length}</dd></div>
    </dl>
  );
}

function AssertionTable({ run }: { run: RunSummary | undefined }) {
  if (!run?.assertions.length) return <div className="empty">No assertions</div>;
  return (
    <table>
      <thead><tr><th>Result</th><th>Name</th><th>Message</th></tr></thead>
      <tbody>
        {run.assertions.map((assertion) => (
          <tr key={assertion.id}>
            <td>
              <span className="result-cell">
                {assertion.passed ? <CheckCircle2 className="pass" size={17} aria-hidden="true" /> : <CircleAlert className="fail" size={17} aria-hidden="true" />}
                {assertion.passed ? "Pass" : "Fail"}
              </span>
            </td>
            <td>{assertion.name}</td>
            <td>{assertion.message ?? ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ResourceTable({ run }: { run: RunSummary | undefined }) {
  if (!run?.createdResources.length) return <div className="empty">No resources</div>;
  return (
    <table>
      <thead><tr><th>Type</th><th>ID</th></tr></thead>
      <tbody>
        {run.createdResources.map((resource) => (
          <tr key={`${resource.type}:${resource.id}`}>
            <td>{resource.type}</td>
            <td className="mono">{resource.id}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function LogList({ events }: { events: RunEvent[] }) {
  if (!events.length) return <div className="empty">No events</div>;
  return (
    <ol className="log-list">
      {events.map((event) => (
        <li key={event.sequence} className={event.level === "error" ? "log-error" : ""}>
          <time>{formatTime(event.timestamp)}</time>
          <span>{event.message}</span>
        </li>
      ))}
    </ol>
  );
}

function appendRunEvent(current: RunEvent[], event: RunEvent): RunEvent[] | undefined {
  if (current.some((existing) => existing.runId === event.runId && existing.sequence === event.sequence)) return undefined;
  return [...current, event].slice(-MAX_CLIENT_EVENTS);
}

function applyRunEvent(run: RunSummary, event: RunEvent): RunSummary {
  switch (event.type) {
    case "status":
      if (event.status === "running" && isTerminalStatus(run.status)) return run;
      return {
        ...run,
        status: event.status,
        updatedAt: event.timestamp,
        ...(event.status === "running" || run.finishedAt ? {} : { finishedAt: event.timestamp })
      };
    case "assertion":
      if (run.assertions.some((assertion) => assertion.id === event.assertion.id)) return run;
      return { ...run, assertions: [...run.assertions, event.assertion], updatedAt: event.timestamp };
    case "resource":
      if (run.createdResources.some((resource) => resource.type === event.resource.type && resource.id === event.resource.id)) return run;
      return { ...run, createdResources: [...run.createdResources, event.resource], updatedAt: event.timestamp };
    case "error":
      return { ...run, lastError: event.message, updatedAt: event.timestamp };
    case "cleanup":
      if (!event.resource) return { ...run, cleaned: true, updatedAt: event.timestamp };
      return { ...run, updatedAt: event.timestamp };
    case "log":
      return { ...run, updatedAt: event.timestamp };
  }
}

function isTerminalStatus(status: RunSummary["status"]): boolean {
  return status !== "running";
}

function displayStatus(run: RunSummary | undefined): string {
  return run?.cleaned ? "cleaned" : run?.status ?? "idle";
}

function mergeRunLists(current: RunSummary[], incoming: RunSummary[], runIdsAtRequestStart: Set<string>): RunSummary[] {
  const byId = new Map(current.map((run) => [run.id, run]));
  const incomingIds = new Set(incoming.map((run) => run.id));
  const retained = current.filter((run) => !incomingIds.has(run.id) && !runIdsAtRequestStart.has(run.id));
  return [...incoming.map((run) => mergeRunSummary(byId.get(run.id), run)), ...retained].sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt));
}

function mergeRunSummary(existing: RunSummary | undefined, incoming: RunSummary): RunSummary {
  if (!existing) return incoming;
  const existingIsNewer = runRecency(existing) >= runRecency(incoming);
  const fresher = existingIsNewer ? existing : incoming;
  return {
    id: incoming.id,
    scenarioId: incoming.scenarioId,
    scenarioName: incoming.scenarioName,
    ...(incoming.target ?? existing.target ? { target: incoming.target ?? existing.target } : {}),
    status: fresher.status,
    startedAt: incoming.startedAt,
    ...(fresher.finishedAt ? { finishedAt: fresher.finishedAt } : {}),
    ...(fresher.updatedAt ? { updatedAt: fresher.updatedAt } : {}),
    inputs: incoming.inputs,
    ...(incoming.jsonInput === undefined ? {} : { jsonInput: incoming.jsonInput }),
    assertions: mergeAssertions(existing.assertions, incoming.assertions),
    createdResources: mergeResources(existing.createdResources, incoming.createdResources),
    cleaned: existing.cleaned || incoming.cleaned,
    ...(fresher.lastError ? { lastError: fresher.lastError } : {})
  };
}

function runRecency(run: RunSummary): number {
  return Date.parse(run.updatedAt ?? run.finishedAt ?? run.startedAt);
}

function mergeAssertions(existing: RunSummary["assertions"], incoming: RunSummary["assertions"]): RunSummary["assertions"] {
  const byId = new Map(existing.map((assertion) => [assertion.id, assertion]));
  for (const assertion of incoming) byId.set(assertion.id, assertion);
  return [...byId.values()];
}

function mergeResources(existing: RunSummary["createdResources"], incoming: RunSummary["createdResources"]): RunSummary["createdResources"] {
  const byId = new Map(existing.map((resource) => [`${resource.type}:${resource.id}`, resource]));
  for (const resource of incoming) byId.set(`${resource.type}:${resource.id}`, resource);
  return [...byId.values()];
}

function submissionInputs(scenario: ScenarioDescriptor, values: FieldValues): NonNullable<StartRunRequest["inputs"]> {
  return Object.fromEntries(
    scenario.inputFields.map((field): [string, string | boolean | ReturnType<typeof jsonNumber>] => {
      const value = values[field.key];
      if (field.type === "text") return [field.key, typeof value === "string" ? value : field.defaultValue];
      if (field.type === "boolean") return [field.key, typeof value === "boolean" ? value : field.defaultValue];
      if (typeof value === "number") return [field.key, jsonNumber(value)];
      if (typeof value !== "string") return [field.key, field.defaultValue];
      const trimmed = value.trim();
      if (trimmed === "") return [field.key, field.defaultValue];
      const parsed = Number(trimmed);
      if (!Number.isFinite(parsed)) throw new Error(`${field.label} must be a number`);
      if (field.min !== undefined && parsed < field.min) throw new Error(`${field.label} must be at least ${field.min}`);
      if (field.max !== undefined && parsed > field.max) throw new Error(`${field.label} must be at most ${field.max}`);
      if (field.step !== undefined && field.step > 0 && !alignsToStep(parsed, field.step, field.min ?? 0)) {
        throw new Error(`${field.label} must align to step ${field.step}`);
      }
      return [field.key, jsonNumber(parsed)];
    })
  );
}

function alignsToStep(value: number, step: number, base: number): boolean {
  const steps = (value - base) / step;
  return Math.abs(steps - Math.round(steps)) < 1e-9;
}

function parseRunEvent(value: unknown): RunEvent {
  if (
    !isRecord(value) ||
    typeof value.sequence !== "number" ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 1 ||
    typeof value.runId !== "string" ||
    typeof value.timestamp !== "string" ||
    Number.isNaN(Date.parse(value.timestamp)) ||
    typeof value.message !== "string"
  ) {
    throw new Error("Invalid run event");
  }
  switch (value.type) {
    case "status":
      if (value.status === "running" || value.status === "completed" || value.status === "failed" || value.status === "cancelled") return value as RunEvent;
      break;
    case "log":
      if (value.level === undefined || isRunEventLevel(value.level)) return value as RunEvent;
      break;
    case "assertion":
      if (
        isRecord(value.assertion) &&
        typeof value.assertion.id === "string" &&
        typeof value.assertion.name === "string" &&
        typeof value.assertion.passed === "boolean" &&
        typeof value.assertion.timestamp === "string" &&
        (value.assertion.message === undefined || typeof value.assertion.message === "string")
      ) return value as RunEvent;
      break;
    case "resource":
      if (isCreatedResource(value.resource)) return value as RunEvent;
      break;
    case "error":
      if (value.level === "error") return value as RunEvent;
      break;
    case "cleanup":
      if (value.resource === undefined || isCreatedResource(value.resource)) return value as RunEvent;
      break;
  }
  throw new Error("Invalid run event");
}

function isRunEventLevel(value: unknown): boolean {
  return value === "info" || value === "warn" || value === "error";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function RunTable({ runs, onSelect }: { runs: RunSummary[]; onSelect(run: RunSummary): void }) {
  if (!runs.length) return <div className="empty">No runs</div>;
  return (
    <table>
      <thead><tr><th>Status</th><th>Scenario</th><th>Started</th></tr></thead>
      <tbody>
        {runs.map((run) => (
          <tr key={run.id}>
            <td>
              <span className="status-cell">
                <span className={`status-dot ${displayStatus(run)}`} aria-hidden="true" />
                {displayStatus(run)}
              </span>
            </td>
            <td>
              <button className="run-select-button" type="button" onClick={() => onSelect(run)}>
                {run.scenarioName}
              </button>
            </td>
            <td>{formatTime(run.startedAt)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function formatTime(value: string): string {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return value;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "medium" }).format(parsed);
}

function errorMessage(errorValue: unknown): string {
  return errorValue instanceof Error ? errorValue.message : String(errorValue);
}
