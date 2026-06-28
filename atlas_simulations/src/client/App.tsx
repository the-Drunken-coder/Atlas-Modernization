import { Activity, CheckCircle2, CircleAlert, Play, RefreshCw, Square, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { HealthResponse, RunEvent, RunSummary, ScenarioDescriptor } from "../shared/types.js";
import { cleanupRun, loadHealth, loadRuns, loadScenarios, startRun, stopRun } from "./api.js";

type FieldValues = Record<string, string | number | boolean>;

const MAX_CLIENT_EVENTS = 500;

export function App() {
  const [health, setHealth] = useState<HealthResponse | undefined>();
  const [scenarios, setScenarios] = useState<ScenarioDescriptor[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [inputs, setInputs] = useState<FieldValues>({});
  const [jsonInput, setJsonInput] = useState("");
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [currentRun, setCurrentRun] = useState<RunSummary | undefined>();
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [mutationPending, setMutationPending] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);
  const activeRunIdRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    void refreshHealth().catch(captureError);
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

  useEffect(() => {
    if (!selected) return;
    setInputs(Object.fromEntries(selected.inputFields.map((field) => [field.key, field.defaultValue])));
    setJsonInput("");
  }, [selected]);

  async function refreshHealth() {
    try {
      setHealth(await loadHealth());
    } catch (errorValue) {
      setHealth({ ok: false, message: errorMessage(errorValue) });
      throw errorValue;
    }
  }

  async function refreshRuns() {
    setRuns(await loadRuns());
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
      const run = await startRun({ scenarioId: selected.id, inputs: submissionInputs(selected, inputs), jsonInput });
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
    if (currentRun?.id === run.id) {
      setCurrentRun((current) => (current ? { ...current, ...run } : run));
      if (run.status === "running" && activeRunIdRef.current !== run.id) connectEvents(run.id);
      if (run.status !== "running") closeActiveEventSource();
      return;
    }
    setEvents([]);
    setCurrentRun(run);
    if (run.status === "running") {
      connectEvents(run.id);
    } else {
      closeActiveEventSource();
    }
  }

  function clearRunSelection() {
    setEvents([]);
    setCurrentRun(undefined);
    closeActiveEventSource();
  }

  function connectEvents(runId: string) {
    closeActiveEventSource();
    activeRunIdRef.current = runId;
    const source = new EventSource(`/api/runs/${encodeURIComponent(runId)}/events`);
    eventSourceRef.current = source;
    const closeSource = () => {
      if (activeRunIdRef.current === runId && eventSourceRef.current === source) {
        activeRunIdRef.current = undefined;
        eventSourceRef.current = null;
        source.close();
      }
    };
    source.onmessage = (message) => {
      if (activeRunIdRef.current !== runId) return;
      const event = JSON.parse(message.data) as RunEvent;
      setEvents((current) => {
        if (current.some((existing) => existing.runId === event.runId && existing.sequence === event.sequence)) return current;
        return [...current, event].slice(-MAX_CLIENT_EVENTS);
      });
      setCurrentRun((current) => (current?.id === runId ? applyRunEvent(current, event) : current));
      setRuns((current) => current.map((run) => (run.id === runId ? applyRunEvent(run, event) : run)));
      if (event.type === "status" && isTerminalStatus(event.status)) closeSource();
      if (event.type === "cleanup" && !event.resource) closeSource();
    };
    source.onerror = () => {
      // EventSource handles transient reconnects itself.
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
      setCurrentRun((current) => (current?.id === targetRunId ? updatedRun : current));
      if (isTerminalStatus(updatedRun.status)) closeActiveEventSource();
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
      if (activeRunIdRef.current !== targetRunId) connectEvents(targetRunId);
      const updatedRun = await cleanupRun(targetRunId);
      upsertRun(updatedRun);
      setCurrentRun((current) => (current?.id === targetRunId ? updatedRun : current));
      if (updatedRun.cleaned) closeActiveEventSource();
      await refreshRunsBestEffort();
    } catch (errorValue) {
      captureError(errorValue);
    } finally {
      setMutationPending(false);
    }
  }

  function upsertRun(run: RunSummary) {
    setRuns((current) => {
      const index = current.findIndex((existing) => existing.id === run.id);
      if (index === -1) return [run, ...current];
      const next = [...current];
      next[index] = { ...next[index], ...run };
      return next;
    });
  }

  function closeActiveEventSource() {
    if (!eventSourceRef.current) return;
    const source = eventSourceRef.current;
    activeRunIdRef.current = undefined;
    eventSourceRef.current = null;
    source.close();
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <h1>Atlas Simulations</h1>
          <div className="subtle">Atlas Core</div>
        </div>
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
                ) : (
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
                )}
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

function applyRunEvent(run: RunSummary, event: RunEvent): RunSummary {
  switch (event.type) {
    case "status":
      if (event.status === "running" && isTerminalStatus(run.status)) return run;
      return {
        ...run,
        status: event.status,
        ...(event.status === "running" || run.finishedAt ? {} : { finishedAt: event.timestamp })
      };
    case "assertion":
      if (run.assertions.some((assertion) => assertion.id === event.assertion.id)) return run;
      return { ...run, assertions: [...run.assertions, event.assertion] };
    case "resource":
      if (run.createdResources.some((resource) => resource.type === event.resource.type && resource.id === event.resource.id)) return run;
      return { ...run, createdResources: [...run.createdResources, event.resource] };
    case "error":
      return { ...run, lastError: event.message };
    case "cleanup":
      if (!event.resource) return { ...run, cleaned: true };
      return run;
    case "log":
      return run;
  }
}

function isTerminalStatus(status: RunSummary["status"]): boolean {
  return status !== "running";
}

function displayStatus(run: RunSummary | undefined): string {
  return run?.cleaned ? "cleaned" : run?.status ?? "idle";
}

function submissionInputs(scenario: ScenarioDescriptor, values: FieldValues): FieldValues {
  return Object.fromEntries(
    scenario.inputFields.map((field) => {
      const value = values[field.key];
      if (field.type !== "number" || typeof value !== "string") return [field.key, value ?? field.defaultValue];
      const trimmed = value.trim();
      if (trimmed === "") return [field.key, field.defaultValue];
      const parsed = Number(trimmed);
      if (!Number.isFinite(parsed)) throw new Error(`${field.label} must be a number`);
      return [field.key, parsed];
    })
  );
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
  return new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "medium" }).format(new Date(value));
}

function errorMessage(errorValue: unknown): string {
  return errorValue instanceof Error ? errorValue.message : String(errorValue);
}
