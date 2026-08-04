import { CheckCircle2, CircleAlert } from "lucide-react";
import type { RunEvent, RunSummary } from "../shared/types.js";
import { displayStatus } from "./run-state.js";

export function RunDetails({ run }: { run: RunSummary | undefined }) {
  if (!run) return <div className="empty">No run selected</div>;
  return (
    <dl className="run-details">
      <div>
        <dt>ID</dt>
        <dd>{run.id}</dd>
      </div>
      <div>
        <dt>Scenario</dt>
        <dd>{run.scenarioName}</dd>
      </div>
      <div>
        <dt>API</dt>
        <dd>{run.target ? `${run.target.label} (${run.target.baseUrl})` : "-"}</dd>
      </div>
      <div>
        <dt>Started</dt>
        <dd>{formatTime(run.startedAt)}</dd>
      </div>
      <div>
        <dt>Finished</dt>
        <dd>{run.finishedAt ? formatTime(run.finishedAt) : "-"}</dd>
      </div>
      <div>
        <dt>Created</dt>
        <dd>{run.createdResources.length}</dd>
      </div>
      <div>
        <dt>Checks</dt>
        <dd>
          {run.assertions.filter((assertion) => assertion.passed).length}/{run.assertions.length}
        </dd>
      </div>
      {run.lastError ? (
        <div className="run-error">
          <dt>Last error</dt>
          <dd>{run.lastError}</dd>
        </div>
      ) : null}
    </dl>
  );
}

export function AssertionTable({ run }: { run: RunSummary | undefined }) {
  if (!run?.assertions.length) return <div className="empty">No assertions</div>;
  return (
    <table>
      <thead>
        <tr>
          <th>Result</th>
          <th>Name</th>
          <th>Message</th>
        </tr>
      </thead>
      <tbody>
        {run.assertions.map((assertion) => (
          <tr key={assertion.id}>
            <td>
              <span className="result-cell">
                {assertion.passed ? (
                  <CheckCircle2 className="pass" size={17} aria-hidden="true" />
                ) : (
                  <CircleAlert className="fail" size={17} aria-hidden="true" />
                )}
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

export function ResourceTable({ run }: { run: RunSummary | undefined }) {
  if (!run?.createdResources.length) return <div className="empty">No resources</div>;
  return (
    <table>
      <thead>
        <tr>
          <th>Type</th>
          <th>ID</th>
        </tr>
      </thead>
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

export function LogList({ events }: { events: RunEvent[] }) {
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

export function RunTable({
  runs,
  selectedId,
  onSelect
}: {
  runs: RunSummary[];
  selectedId?: string;
  onSelect(run: RunSummary): void;
}) {
  if (!runs.length) return <div className="empty">No runs</div>;
  return (
    <table>
      <thead>
        <tr>
          <th>Status</th>
          <th>Scenario</th>
          <th>Started</th>
        </tr>
      </thead>
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
              <button
                className="run-select-button"
                type="button"
                aria-current={run.id === selectedId ? "true" : undefined}
                onClick={() => onSelect(run)}
              >
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
