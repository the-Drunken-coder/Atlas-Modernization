import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupRun, loadHealth, loadRun, loadRuns, loadScenarios, loadTargets, startRun, stopRun } from "../../src/client/api.js";
import { App } from "../../src/client/App.js";
import { jsonNumber } from "../../src/shared/types.js";
import type { AtlasTargetSummary, HealthResponse, RunEvent, RunSummary, ScenarioDescriptor } from "../../src/shared/types.js";

const scenario: ScenarioDescriptor = {
  id: "moving-assets",
  name: "Moving assets",
  summary: "Creates assets",
  acceptsJson: true,
  inputFields: [{ key: "assetCount", label: "Asset count", type: "number", defaultValue: jsonNumber(2), min: jsonNumber(1), max: jsonNumber(4) }]
};

const syncScenario: ScenarioDescriptor = {
  id: "multi-client-sync",
  name: "Multi-client sync",
  summary: "Checks sync",
  acceptsJson: false,
  inputFields: []
};

const localTarget: AtlasTargetSummary = {
  id: "local",
  label: "Local Core",
  baseUrl: "http://localhost:8000",
  deployed: false,
  apiKeyConfigured: true
};

const deployedTarget: AtlasTargetSummary = {
  id: "deployed",
  label: "Atlas Command API",
  baseUrl: "https://atlascommandapi.org",
  deployed: true,
  apiKeyConfigured: true
};

const run: RunSummary = {
  id: "sim-test",
  scenarioId: "moving-assets",
  scenarioName: "Moving assets",
  status: "running",
  startedAt: new Date().toISOString(),
  inputs: { assetCount: jsonNumber(2) },
  createdResources: [],
  assertions: [],
  cleaned: false
};

let eventSources: FakeEventSource[] = [];

function cloneRun(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    ...run,
    inputs: { ...run.inputs },
    createdResources: [...run.createdResources],
    assertions: [...run.assertions],
    ...overrides
  };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(reason?: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

vi.mock("../../src/client/api.js", () => ({
  loadTargets: vi.fn(async () => ({ targets: [localTarget, deployedTarget], defaultTargetId: localTarget.id })),
  loadHealth: vi.fn(async () => ({ ok: true, status: 200, message: "ok" })),
  loadScenarios: vi.fn(async () => [scenario]),
  loadRuns: vi.fn(async () => []),
  startRun: vi.fn(async () => cloneRun()),
  loadRun: vi.fn(async () => cloneRun()),
  stopRun: vi.fn(async () => cloneRun({ status: "running" })),
  cleanupRun: vi.fn(async () => cloneRun({ status: "completed", cleaned: true }))
}));

class FakeEventSource {
  onmessage: ((message: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    eventSources.push(this);
  }

  emit(event: RunEvent) {
    if (this.closed) return;
    this.onmessage?.({ data: JSON.stringify(event) } as MessageEvent<string>);
  }

  close() {
    this.closed = true;
    this.onmessage = null;
    this.onerror = null;
  }
}

describe("App", () => {
  beforeEach(() => {
    eventSources = [];
    vi.resetAllMocks();
    vi.mocked(loadTargets).mockResolvedValue({ targets: [localTarget, deployedTarget], defaultTargetId: localTarget.id });
    vi.mocked(loadHealth).mockResolvedValue({ ok: true, status: jsonNumber(200), message: "ok" });
    vi.mocked(loadScenarios).mockResolvedValue([scenario]);
    vi.mocked(loadRun).mockResolvedValue(cloneRun());
    vi.mocked(loadRuns).mockResolvedValue([]);
    vi.mocked(startRun).mockResolvedValue(cloneRun());
    vi.mocked(stopRun).mockResolvedValue(cloneRun({ status: "running" }));
    vi.mocked(cleanupRun).mockResolvedValue(cloneRun({ status: "completed", cleaned: true }));
    vi.stubGlobal("EventSource", FakeEventSource);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps Start disabled until an API target loads", async () => {
    const loadedTargets = deferred<{ targets: AtlasTargetSummary[]; defaultTargetId: string }>();
    vi.mocked(loadTargets).mockReturnValue(loadedTargets.promise);

    render(<App />);

    const startButton = await screen.findByRole("button", { name: "Start" });
    expect(startButton).toBeDisabled();

    await act(async () => {
      loadedTargets.resolve({ targets: [localTarget], defaultTargetId: localTarget.id });
      await loadedTargets.promise;
    });
    await waitFor(() => expect(startButton).toBeEnabled());
  });

  it("ignores the cancelled StrictMode target load instead of resetting the user's selection", async () => {
    const user = userEvent.setup();
    const cancelledLoad = deferred<{ targets: AtlasTargetSummary[]; defaultTargetId: string }>();
    const activeLoad = deferred<{ targets: AtlasTargetSummary[]; defaultTargetId: string }>();
    vi.mocked(loadTargets).mockReturnValueOnce(cancelledLoad.promise).mockReturnValueOnce(activeLoad.promise);

    render(<StrictMode><App /></StrictMode>);
    await act(async () => {
      activeLoad.resolve({ targets: [localTarget, deployedTarget], defaultTargetId: localTarget.id });
      await activeLoad.promise;
    });
    await user.selectOptions(await screen.findByLabelText("API"), deployedTarget.id);

    await act(async () => {
      cancelledLoad.resolve({ targets: [localTarget, deployedTarget], defaultTargetId: localTarget.id });
      await cancelledLoad.promise;
    });

    expect(screen.getByLabelText("API")).toHaveValue(deployedTarget.id);
    expect(screen.getByRole("alert", { name: "Deployed Core selected" })).toBeInTheDocument();
  });

  it("loads scenarios and starts a selected run", async () => {
    const user = userEvent.setup();
    vi.mocked(loadRuns).mockResolvedValueOnce([]).mockResolvedValue([cloneRun()]);
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Atlas Simulations" })).toBeInTheDocument();
    expect((await screen.findAllByText("Moving assets")).length).toBeGreaterThan(0);
    const assetCount = screen.getByLabelText("Asset count");
    const jsonInput = screen.getByLabelText("JSON input");
    fireEvent.change(assetCount, { target: { value: "3" } });
    fireEvent.change(jsonInput, { target: { value: '{"note":"ok"}' } });
    await user.click(screen.getByRole("button", { name: /start/i }));
    await waitFor(() =>
      expect(vi.mocked(startRun)).toHaveBeenCalledWith({
        scenarioId: scenario.id,
        targetId: localTarget.id,
        inputs: { assetCount: 3 },
        jsonInput: '{"note":"ok"}'
      })
    );
    await waitFor(() => expect(screen.getAllByText("running").length).toBeGreaterThan(0));
    await waitFor(() => expect(eventSources).toHaveLength(1));
    expect(eventSources[0].url).toBe(`/api/runs/${encodeURIComponent(run.id)}/events`);
    const assertionEvent: RunEvent = {
      sequence: jsonNumber(1),
      runId: run.id,
      timestamp: new Date().toISOString(),
      type: "assertion",
      assertion: { id: "assert-1", name: "streamed check", passed: true, timestamp: new Date().toISOString() },
      message: "PASS streamed check"
    };
    act(() => {
      eventSources[0].emit(assertionEvent);
      eventSources[0].emit(assertionEvent);
    });
    expect(await screen.findByText("streamed check")).toBeInTheDocument();
    expect(await screen.findByText("PASS streamed check")).toBeInTheDocument();
    expect(screen.getAllByText("streamed check")).toHaveLength(1);
    expect(screen.getAllByText("PASS streamed check")).toHaveLength(1);

    const completedEvent: RunEvent = {
      sequence: jsonNumber(2),
      runId: run.id,
      timestamp: new Date().toISOString(),
      type: "status",
      status: "completed",
      message: "Run completed"
    };
    act(() => {
      eventSources[0].emit(completedEvent);
      eventSources[0].emit(completedEvent);
    });
    await waitFor(() => expect(screen.getAllByText("completed").length).toBeGreaterThan(0));
    expect(await screen.findByText("Run completed")).toBeInTheDocument();
    expect(screen.getAllByText("Run completed")).toHaveLength(1);
    await waitFor(() => expect(eventSources[0].closed).toBe(true));
    await user.click(screen.getByRole("button", { name: /cleanup/i }));
    await waitFor(() => expect(vi.mocked(cleanupRun)).toHaveBeenCalledWith(run.id));
    await waitFor(() => expect(screen.getAllByText("cleaned").length).toBeGreaterThan(0));
  });

  it("omits blank JSON input from start requests", async () => {
    const user = userEvent.setup();
    render(<App />);

    fireEvent.change(await screen.findByLabelText("JSON input"), { target: { value: "   " } });
    await user.click(screen.getByRole("button", { name: /start/i }));

    await waitFor(() =>
      expect(vi.mocked(startRun)).toHaveBeenCalledWith({
        scenarioId: scenario.id,
        targetId: localTarget.id,
        inputs: { assetCount: 2 }
      })
    );
  });

  it("requires a fresh acknowledgement before each deployed start", async () => {
    const user = userEvent.setup();
    render(<App />);

    const apiSelect = await screen.findByLabelText("API");
    await user.selectOptions(apiSelect, deployedTarget.id);
    await waitFor(() => expect(vi.mocked(loadHealth)).toHaveBeenCalledWith(deployedTarget.id));
    const warning = await screen.findByRole("alert", { name: "Deployed Core selected" });
    expect(warning).toHaveTextContent(deployedTarget.label);
    expect(warning).toHaveTextContent(deployedTarget.baseUrl);

    let confirmation = screen.getByRole("checkbox", { name: "I understand this start will mutate the deployed Core." });
    let startButton = screen.getByRole("button", { name: "Start on deployed Core" });
    expect(confirmation).not.toBeChecked();
    expect(startButton).toBeDisabled();

    await user.click(confirmation);
    expect(startButton).toBeEnabled();
    await user.selectOptions(apiSelect, localTarget.id);
    expect(screen.queryByRole("alert", { name: "Deployed Core selected" })).not.toBeInTheDocument();
    await user.selectOptions(apiSelect, deployedTarget.id);

    confirmation = await screen.findByRole("checkbox", { name: "I understand this start will mutate the deployed Core." });
    startButton = screen.getByRole("button", { name: "Start on deployed Core" });
    expect(confirmation).not.toBeChecked();
    expect(startButton).toBeDisabled();
    await user.click(confirmation);
    await user.click(startButton);

    await waitFor(() =>
      expect(vi.mocked(startRun)).toHaveBeenCalledWith({
        scenarioId: scenario.id,
        targetId: deployedTarget.id,
        confirmDeployedMutation: true,
        inputs: { assetCount: 2 }
      })
    );
    await waitFor(() => expect(confirmation).not.toBeChecked());
    expect(startButton).toBeDisabled();
  });

  it("clears stale health while checking a newly selected target", async () => {
    const user = userEvent.setup();
    const deployedHealth = deferred<HealthResponse>();
    vi.mocked(loadHealth).mockImplementation((targetId) =>
      targetId === deployedTarget.id
        ? deployedHealth.promise
        : Promise.resolve({ ok: true, status: jsonNumber(200), message: "local ok", target: localTarget })
    );
    render(<App />);

    expect(await screen.findByText("Core reachable")).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("API"), deployedTarget.id);
    expect(screen.getByText("Checking")).toBeInTheDocument();
    expect(screen.queryByText("Core reachable")).not.toBeInTheDocument();

    await act(async () => {
      deployedHealth.resolve({ ok: true, status: jsonNumber(200), message: "deployed ok", target: deployedTarget });
      await deployedHealth.promise;
    });
    expect(await screen.findByText("Core reachable")).toBeInTheDocument();
  });

  it("ignores stale health responses after target switches", async () => {
    const user = userEvent.setup();
    const localHealth = deferred<HealthResponse>();
    const deployedHealth = deferred<HealthResponse>();
    vi.mocked(loadHealth).mockImplementation((targetId) => (targetId === deployedTarget.id ? deployedHealth.promise : localHealth.promise));
    render(<App />);

    const apiSelect = await screen.findByLabelText("API");
    await waitFor(() => expect(vi.mocked(loadHealth)).toHaveBeenCalledWith(localTarget.id));
    await user.selectOptions(apiSelect, deployedTarget.id);
    await waitFor(() => expect(vi.mocked(loadHealth)).toHaveBeenCalledWith(deployedTarget.id));

    await act(async () => {
      deployedHealth.resolve({ ok: true, status: jsonNumber(200), message: "deployed ok", target: deployedTarget });
      await deployedHealth.promise;
    });
    expect(await screen.findByText("Core reachable")).toBeInTheDocument();

    await act(async () => {
      localHealth.resolve({ ok: false, status: jsonNumber(503), message: "local down", target: localTarget });
      await localHealth.promise;
    });

    expect(screen.getByText("Core reachable")).toBeInTheDocument();
    expect(screen.queryByText("Core offline")).not.toBeInTheDocument();
  });

  it("uses the pasted API key when refreshing health and starting a run", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.type(await screen.findByLabelText("API key"), "secret-key");
    await user.click(screen.getByRole("button", { name: "Refresh Core status" }));
    await waitFor(() => expect(vi.mocked(loadHealth)).toHaveBeenCalledWith(localTarget.id, "secret-key"));

    await user.click(screen.getByRole("button", { name: /start/i }));
    await waitFor(() =>
      expect(vi.mocked(startRun)).toHaveBeenCalledWith(
        {
          scenarioId: scenario.id,
          targetId: localTarget.id,
          inputs: { assetCount: 2 }
        },
        "secret-key"
      )
    );
  });

  it("uses the run target's in-memory API key for cleanup", async () => {
    const user = userEvent.setup();
    const deployedRun = cloneRun({ status: "completed", target: deployedTarget });
    vi.mocked(loadRuns).mockResolvedValue([deployedRun]);
    vi.mocked(cleanupRun).mockResolvedValue({ ...deployedRun, cleaned: true });
    render(<App />);

    const apiSelect = await screen.findByLabelText("API");
    await user.selectOptions(apiSelect, deployedTarget.id);
    await user.type(screen.getByLabelText("API key"), "remote-key");
    await user.selectOptions(apiSelect, localTarget.id);
    await user.click(await screen.findByRole("button", { name: /^Moving assets$/ }));
    await user.click(screen.getByRole("button", { name: /cleanup/i }));

    await waitFor(() => expect(vi.mocked(cleanupRun)).toHaveBeenCalledWith(deployedRun.id, "remote-key"));
  });

  it("shows abandoned runs and their last cleanup error", async () => {
    const user = userEvent.setup();
    const abandonedRun = cloneRun({
      status: "abandoned",
      target: deployedTarget,
      lastError: "The workbench restarted before this run finished"
    });
    vi.mocked(loadTargets).mockResolvedValue({ targets: [localTarget], defaultTargetId: localTarget.id });
    vi.mocked(loadRuns).mockResolvedValue([abandonedRun]);
    vi.mocked(cleanupRun).mockResolvedValue({ ...abandonedRun, cleaned: true });
    render(<App />);

    await user.click(await screen.findByRole("button", { name: /^Moving assets$/ }));

    expect(document.querySelector(".status-pill.abandoned")).toHaveTextContent("abandoned");
    expect(screen.getByText("Last error")).toBeInTheDocument();
    expect(screen.getByText("The workbench restarted before this run finished")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Cleanup API key"), "recovery-key");
    await user.click(screen.getByRole("button", { name: /cleanup/i }));
    await waitFor(() => expect(vi.mocked(cleanupRun)).toHaveBeenCalledWith(abandonedRun.id, "recovery-key"));
  });

  it("isolates recovery keys between abandoned runs that share a target ID", async () => {
    const user = userEvent.setup();
    const first = cloneRun({
      id: "sim-recovered-first",
      scenarioName: "Recovered first",
      status: "abandoned",
      target: deployedTarget
    });
    const second = cloneRun({
      id: "sim-recovered-second",
      scenarioName: "Recovered second",
      status: "abandoned",
      target: { ...deployedTarget, baseUrl: "https://different-atlas.example.test" }
    });
    vi.mocked(loadTargets).mockResolvedValue({ targets: [localTarget], defaultTargetId: localTarget.id });
    vi.mocked(loadRuns).mockResolvedValue([first, second]);
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Recovered first" }));
    await user.type(screen.getByLabelText("Cleanup API key"), "first-key");
    await user.click(screen.getByRole("button", { name: "Recovered second" }));

    expect(screen.getByLabelText("Cleanup API key")).toHaveValue("");
  });

  it("blocks invalid JSON input before starting a run", async () => {
    const user = userEvent.setup();
    render(<App />);

    await waitFor(() => expect(screen.getByLabelText("Asset count")).toHaveValue(2));
    fireEvent.change(await screen.findByLabelText("JSON input"), { target: { value: "{" } });
    await user.click(screen.getByRole("button", { name: /start/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("JSON input must be valid JSON");
    expect(vi.mocked(startRun)).not.toHaveBeenCalled();
  });

  it("keeps selected scenario and selected run synchronized", async () => {
    const user = userEvent.setup();
    const syncRun = cloneRun({
      id: "sim-sync",
      scenarioId: syncScenario.id,
      scenarioName: syncScenario.name,
      status: "completed"
    });
    vi.mocked(loadScenarios).mockResolvedValueOnce([scenario, syncScenario]);
    vi.mocked(loadRuns).mockResolvedValueOnce([syncRun]).mockResolvedValue([syncRun]);
    vi.mocked(cleanupRun).mockResolvedValueOnce({ ...syncRun, cleaned: true });

    render(<App />);
    await user.click(await screen.findByRole("button", { name: syncScenario.name }));

    expect(screen.getByRole("button", { name: /multi-client sync checks sync/i })).toHaveAttribute("aria-pressed", "true");
    expect(eventSources).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: /cleanup/i }));
    await waitFor(() => expect(vi.mocked(cleanupRun)).toHaveBeenCalledWith(syncRun.id));
    await waitFor(() => expect(screen.getAllByText("cleaned").length).toBeGreaterThan(0));
  });

  it("keeps the stream open after stop until the terminal event arrives", async () => {
    const user = userEvent.setup();
    vi.mocked(loadRuns).mockResolvedValueOnce([]).mockResolvedValue([cloneRun()]);

    render(<App />);
    await waitFor(() => expect(screen.getByRole("button", { name: /start/i })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: /start/i }));
    await waitFor(() => expect(eventSources).toHaveLength(1));

    await user.click(screen.getByRole("button", { name: /stop/i }));

    await waitFor(() => expect(vi.mocked(stopRun)).toHaveBeenCalledWith(run.id));
    expect(eventSources[0].closed).toBe(false);
    act(() => {
      eventSources[0].emit({
        sequence: jsonNumber(1),
        runId: run.id,
        timestamp: new Date().toISOString(),
        type: "status",
        status: "cancelled",
        message: "Run cancelled"
      });
    });
    await waitFor(() => expect(eventSources[0].closed).toBe(true));
  });

  it("refreshes the selected run when the event stream errors before a terminal event", async () => {
    const user = userEvent.setup();
    const completedRun = cloneRun({
      status: "completed",
      finishedAt: new Date().toISOString()
    });
    vi.mocked(loadRuns).mockResolvedValueOnce([]).mockResolvedValueOnce([cloneRun()]).mockResolvedValue([completedRun]);

    render(<App />);
    await user.click(await screen.findByRole("button", { name: /start/i }));
    await waitFor(() => expect(eventSources).toHaveLength(1));
    await waitFor(() => expect(vi.mocked(loadRuns).mock.calls.length).toBeGreaterThanOrEqual(2));

    act(() => {
      eventSources[0].onerror?.();
    });

    await waitFor(() => expect(screen.getAllByText("completed").length).toBeGreaterThan(0));
    await waitFor(() => expect(eventSources[0].closed).toBe(true));
  });

  it("rejects malformed stream event envelopes", async () => {
    const user = userEvent.setup();
    vi.mocked(loadRuns).mockResolvedValueOnce([]).mockResolvedValue([cloneRun()]);

    render(<App />);
    await waitFor(() => expect(screen.getByRole("button", { name: /start/i })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: /start/i }));
    await waitFor(() => expect(eventSources).toHaveLength(1));

    act(() => {
      eventSources[0].onmessage?.({
        data: JSON.stringify({
          sequence: 1.5,
          runId: run.id,
          timestamp: "not-a-date",
          type: "log",
          message: "bad event"
        })
      } as MessageEvent<string>);
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(`Invalid event payload for run ${run.id}`);
    expect(eventSources[0].closed).toBe(true);
  });

  it("reconnects a selected running run after a malformed stream event", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(loadRuns).mockResolvedValueOnce([]).mockResolvedValue([cloneRun()]);

      render(<App />);
      await vi.waitFor(() => expect(screen.getByRole("button", { name: /start/i })).toBeEnabled());
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /start/i }));
      });
      await vi.waitFor(() => expect(eventSources).toHaveLength(1));

      act(() => {
        eventSources[0].onmessage?.({
          data: JSON.stringify({
            sequence: 1.5,
            runId: run.id,
            timestamp: "not-a-date",
            type: "log",
            message: "bad event"
          })
        } as MessageEvent<string>);
      });
      expect(eventSources[0].closed).toBe(true);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });

      await vi.waitFor(() => expect(eventSources).toHaveLength(2));
      expect(eventSources[1].url).toBe(`/api/runs/${encodeURIComponent(run.id)}/events`);
    } finally {
      vi.useRealTimers();
    }
  });

  it("restores remembered log events when reselecting a run", async () => {
    const user = userEvent.setup();
    const startedRun = cloneRun({ scenarioName: "Started run" });
    vi.mocked(loadScenarios).mockResolvedValueOnce([scenario, syncScenario]);
    vi.mocked(startRun).mockResolvedValueOnce(startedRun);
    vi.mocked(loadRuns).mockResolvedValueOnce([]).mockResolvedValue([startedRun]);

    render(<App />);
    await waitFor(() => expect(screen.getByRole("button", { name: /start/i })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: /start/i }));
    await waitFor(() => expect(eventSources).toHaveLength(1));
    act(() => {
      eventSources[0].emit({
        sequence: jsonNumber(1),
        runId: startedRun.id,
        timestamp: new Date().toISOString(),
        type: "log",
        message: "remembered log"
      });
    });
    expect(await screen.findByText("remembered log")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /multi-client sync checks sync/i }));
    await waitFor(() => expect(screen.getByText("No run selected")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Started run" }));

    expect(screen.getByText("remembered log")).toBeInTheDocument();
  });

  it("clears the selected run when refresh reports it missing", async () => {
    const missingRun = cloneRun({
      id: "sim-pruned",
      scenarioName: "Pruned run",
      status: "running"
    });
    vi.mocked(loadRuns).mockResolvedValueOnce([missingRun]).mockResolvedValue([]);

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Pruned run" }));
    await waitFor(() => expect(eventSources).toHaveLength(1));

    act(() => {
      eventSources[0].onerror?.();
    });

    await waitFor(() => expect(screen.getByText("No run selected")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText("No runs")).toBeInTheDocument());
    expect(eventSources[0].closed).toBe(true);
  });

  it("closes the stream when refresh reports the selected run completed", async () => {
    vi.useFakeTimers();
    try {
      const completedRun = cloneRun({
        status: "completed",
        finishedAt: new Date().toISOString()
      });
      vi.mocked(loadRuns).mockResolvedValueOnce([]).mockResolvedValueOnce([completedRun]).mockResolvedValue([completedRun]);

      render(<App />);
      await vi.waitFor(() => expect(screen.getByRole("button", { name: /start/i })).toBeEnabled());
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /start/i }));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });

      await vi.waitFor(() => expect(eventSources).toHaveLength(1));
      await vi.waitFor(() => expect(eventSources[0].closed).toBe(true));
      await vi.waitFor(() => expect(screen.getAllByText("completed").length).toBeGreaterThan(0));
    } finally {
      vi.useRealTimers();
    }
  });
});
