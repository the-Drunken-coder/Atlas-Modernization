import { Activity, CircleAlert, RefreshCw } from "lucide-react";
import type { SimulationTargetController } from "./use-simulation-target.js";

export function SimulationTargetControls({ target }: { target: SimulationTargetController }) {
  const {
    health,
    targets,
    selectedTargetId,
    selectedTarget,
    selectedApiKey,
    deployedMutationConfirmed,
    setDeployedMutationConfirmed
  } = target;

  return (
    <>
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
              onChange={(event) => target.selectTarget(event.target.value)}
              disabled={!targets.length}
              title={selectedTarget?.baseUrl}
            >
              {targets.map((availableTarget) => (
                <option key={availableTarget.id} value={availableTarget.id}>
                  {availableTarget.label} ({availableTarget.baseUrl})
                </option>
              ))}
            </select>
          </label>
          <label className="api-key-field">
            <span>API key</span>
            <input
              type="password"
              value={selectedApiKey}
              disabled={!selectedTargetId}
              onChange={(event) => target.setSelectedApiKey(event.target.value)}
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
              onClick={target.refreshSelectedTarget}
            >
              <RefreshCw size={16} aria-hidden="true" />
            </button>
          </div>
        </div>
      </header>

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
    </>
  );
}
