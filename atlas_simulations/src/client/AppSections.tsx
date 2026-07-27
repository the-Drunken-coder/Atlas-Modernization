import { Activity, CircleAlert, Play, RefreshCw, Square, Trash2 } from "lucide-react";
import type {
  AtlasTargetSummary,
  HealthResponse,
  RunSummary,
  ScenarioDescriptor,
  ScenarioInputField
} from "../shared/types.js";
import { RunDetails } from "./AppPanels.js";
import { displayStatus, type FieldValues } from "./run-state.js";

export function TopBar({
  targets,
  selectedTargetId,
  selectedTarget,
  selectedApiKey,
  health,
  onSelectTarget,
  onApiKeyChange,
  onRefreshHealth
}: {
  targets: AtlasTargetSummary[];
  selectedTargetId: string;
  selectedTarget: AtlasTargetSummary | undefined;
  selectedApiKey: string;
  health: HealthResponse | undefined;
  onSelectTarget(targetId: string): void;
  onApiKeyChange(value: string): void;
  onRefreshHealth(): void;
}) {
  return (
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
            onChange={(event) => onSelectTarget(event.target.value)}
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
            onChange={(event) => onApiKeyChange(event.target.value)}
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
            onClick={onRefreshHealth}
          >
            <RefreshCw size={16} aria-hidden="true" />
          </button>
        </div>
      </div>
    </header>
  );
}

export function DeployedWarning({
  target,
  confirmed,
  onConfirmedChange
}: {
  target: AtlasTargetSummary;
  confirmed: boolean;
  onConfirmedChange(confirmed: boolean): void;
}) {
  return (
    <section className="deployed-warning" role="alert" aria-labelledby="deployed-warning-title">
      <CircleAlert size={24} aria-hidden="true" />
      <div className="deployed-warning-content">
        <strong id="deployed-warning-title">Deployed Core selected</strong>
        <p>
          Starting a simulation will mutate remote resources on <strong>{target.label}</strong> at{" "}
          <code>{target.baseUrl}</code>. Cleanup is explicit.
        </p>
        <label className="deployed-confirmation">
          <input type="checkbox" checked={confirmed} onChange={(event) => onConfirmedChange(event.target.checked)} />
          <span>I understand this start will mutate the deployed Core.</span>
        </label>
      </div>
    </section>
  );
}

export function ScenarioList({
  scenarios,
  selectedId,
  onSelect
}: {
  scenarios: ScenarioDescriptor[];
  selectedId: string;
  onSelect(scenarioId: string): void;
}) {
  return (
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
            onClick={() => onSelect(scenario.id)}
          >
            <span>{scenario.name}</span>
            <small>{scenario.summary}</small>
          </button>
        ))}
      </div>
    </aside>
  );
}

export function ControlsPanel({
  selected,
  selectedTarget,
  currentRun,
  mutationPending,
  deployedMutationConfirmed,
  inputs,
  jsonInput,
  onStart,
  onStop,
  onCleanup,
  onInputChange,
  onJsonInputChange
}: {
  selected: ScenarioDescriptor | undefined;
  selectedTarget: AtlasTargetSummary | undefined;
  currentRun: RunSummary | undefined;
  mutationPending: boolean;
  deployedMutationConfirmed: boolean;
  inputs: FieldValues;
  jsonInput: string;
  onStart(): void;
  onStop(): void;
  onCleanup(): void;
  onInputChange(key: string, value: string | boolean): void;
  onJsonInputChange(value: string): void;
}) {
  return (
    <section className="panel controls-panel">
      <div className="panel-head">
        <h2>{selected?.name ?? "Scenario"}</h2>
        <div className="actions">
          <button
            className={selectedTarget?.deployed ? "danger" : "primary"}
            type="button"
            title={selectedTarget?.deployed ? "Start run on deployed Core" : "Start run"}
            onClick={onStart}
            disabled={
              mutationPending || !selected || !selectedTarget || (selectedTarget.deployed && !deployedMutationConfirmed)
            }
          >
            <Play size={16} aria-hidden="true" />
            {selectedTarget?.deployed ? "Start on deployed Core" : "Start"}
          </button>
          <button
            type="button"
            title="Stop run"
            onClick={onStop}
            disabled={mutationPending || currentRun?.status !== "running"}
          >
            <Square size={16} aria-hidden="true" />
            Stop
          </button>
          <button
            type="button"
            title="Cleanup run resources"
            onClick={onCleanup}
            disabled={mutationPending || !currentRun || currentRun.status === "running" || currentRun.cleaned}
          >
            <Trash2 size={16} aria-hidden="true" />
            Cleanup
          </button>
        </div>
      </div>

      <div className="input-grid">
        {selected?.inputFields.map((field) => (
          <ScenarioFieldInput key={field.key} field={field} value={inputs[field.key]} onChange={onInputChange} />
        ))}
      </div>

      {selected?.acceptsJson ? (
        <label className="json-field">
          <span>JSON input</span>
          <textarea value={jsonInput} onChange={(event) => onJsonInputChange(event.target.value)} spellCheck={false} />
        </label>
      ) : null}
    </section>
  );
}

export function RunPanel({
  currentRun,
  recoveryApiKeys,
  onRecoveryApiKeyChange
}: {
  currentRun: RunSummary | undefined;
  recoveryApiKeys: Record<string, string>;
  onRecoveryApiKeyChange(runId: string, value: string): void;
}) {
  return (
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
            value={recoveryApiKeys[currentRun.id] ?? ""}
            onChange={(event) => onRecoveryApiKeyChange(currentRun.id, event.target.value)}
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
  );
}

function ScenarioFieldInput({
  field,
  value,
  onChange
}: {
  field: ScenarioInputField;
  value: string | number | boolean | undefined;
  onChange(key: string, value: string | boolean): void;
}) {
  return (
    <label className="field">
      <span>{field.label}</span>
      {field.type === "boolean" ? (
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(event) => onChange(field.key, event.target.checked)}
        />
      ) : field.type === "number" ? (
        <input
          type="number"
          value={String(value ?? "")}
          min={field.min}
          max={field.max}
          step={field.step}
          onChange={(event) => onChange(field.key, event.target.value)}
        />
      ) : field.type === "text" ? (
        <input type="text" value={String(value ?? "")} onChange={(event) => onChange(field.key, event.target.value)} />
      ) : null}
    </label>
  );
}
