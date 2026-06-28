import { Activity, CheckCircle2, CircleAlert, Play, RefreshCw, Square, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { HealthResponse, RunEvent, RunSummary, ScenarioDescriptor } from "../shared/types.js";
import { cleanupRun, loadHealth, loadRuns, loadScenarios, startRun, stopRun } from "./api.js";

type FieldValues = Record<string, string | number | boolean>;

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
    setHealth(await loadHealth());
    setError(undefined);
  }

  async function refreshRuns() {
    setRuns(await loadRuns());
    setError(undefined);
  }

  function captureError(errorValue: unknown) {
    setError(errorValue instanceof Error ? errorValue.message : String(errorValue));
  }

  async function startSelectedRun() {
    if (!selected) return;
    setError(undefined);
    try {
      const run = await startRun({ scenarioId: selected.id, inputs, jsonInput });
      selectRun(run);
      await refreshRuns();
    } catch (errorValue) {
      captureError(errorValue);
    }
  }

  function selectRun(run: RunSummary) {
    setEvents([]);
    setCurrentRun(run);
    connectEvents(run.id);
  }

  function connectEvents(runId: string) {
    eventSourceRef.current?.close();
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
      setEvents((current) => [...current, event]);
      setCurrentRun((current) => (current?.id === runId ? applyRunEvent(current, event) : current));
      setRuns((current) => current.map((run) => (run.id === runId ? applyRunEvent(run, event) : run)));
      if (event.type === "status" && isTerminalStatus(event.status)) closeSource();
    };
    source.onerror = () => {
      // EventSource handles transient reconnects itself.
    };
  }

  async function stopCurrentRun() {
    if (!currentRun) return;
    setError(undefined);
    try {
      setCurrentRun(await stopRun(currentRun.id));
      await refreshRuns();
    } catch (errorValue) {
      captureError(errorValue);
    }
  }

  async function cleanupCurrentRun() {
    if (!currentRun) return;
    setError(undefined);
    try {
      setCurrentRun(await cleanupRun(currentRun.id));
      await refreshRuns();
    } catch (errorValue) {
      captureError(errorValue);
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <h1>Atlas Simulations</h1>
          <div className="subtle">{health?.atlasBaseUrl ?? "Atlas Core"}</div>
        </div>
        <div className={`health ${health ? (health.ok ? "ok" : "bad") : ""}`}>
          <Activity size={18} aria-hidden="true" />
          <span>{health ? (health.ok ? "Core reachable" : "Core offline") : "Checking"}</span>
          <button className="icon-button" type="button" title="Refresh Core status" aria-label="Refresh Core status" onClick={() => void refreshHealth().catch(captureError)}>
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
                onClick={() => setSelectedId(scenario.id)}
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
              <button className="primary" type="button" title="Start run" onClick={() => void startSelectedRun()} disabled={!selected || currentRun?.status === "running"}>
                <Play size={16} aria-hidden="true" />
                Start
              </button>
              <button type="button" title="Stop run" onClick={() => void stopCurrentRun()} disabled={currentRun?.status !== "running"}>
                <Square size={16} aria-hidden="true" />
                Stop
              </button>
              <button type="button" title="Cleanup run resources" onClick={() => void cleanupCurrentRun()} disabled={!currentRun || currentRun.status === "running" || currentRun.status === "cleaned"}>
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
                        [field.key]: rawValue === "" ? "" : Number(rawValue)
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
            <span className={`status-pill ${currentRun?.status ?? "idle"}`}>{currentRun?.status ?? "idle"}</span>
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
    case "log":
      return run;
  }
}

function isTerminalStatus(status: RunSummary["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "cleaned";
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
                <span className={`status-dot ${run.status}`} aria-hidden="true" />
                {run.status}
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
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value));
}
