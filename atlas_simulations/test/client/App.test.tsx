import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupRun, loadHealth, loadRun, loadRuns, loadScenarios, startRun, stopRun } from "../../src/client/api.js";
import { App } from "../../src/client/App.js";
import { jsonNumber } from "../../src/shared/types.js";
import type { RunEvent, RunSummary, ScenarioDescriptor } from "../../src/shared/types.js";

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

vi.mock("../../src/client/api.js", () => ({
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
    eventSources[0].emit(assertionEvent);
    eventSources[0].emit(assertionEvent);
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
    eventSources[0].emit(completedEvent);
    eventSources[0].emit(completedEvent);
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
        inputs: { assetCount: 2 }
      })
    );
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
    expect(eventSources).toHaveLength(0);
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
    eventSources[0].emit({
      sequence: jsonNumber(1),
      runId: run.id,
      timestamp: new Date().toISOString(),
      type: "status",
      status: "cancelled",
      message: "Run cancelled"
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

    eventSources[0].onerror?.();

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

    eventSources[0].onmessage?.({
      data: JSON.stringify({
        sequence: 1.5,
        runId: run.id,
        timestamp: "not-a-date",
        type: "log",
        message: "bad event"
      })
    } as MessageEvent<string>);

    expect(await screen.findByRole("alert")).toHaveTextContent(`Invalid event payload for run ${run.id}`);
    expect(eventSources[0].closed).toBe(true);
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
    eventSources[0].emit({
      sequence: jsonNumber(1),
      runId: startedRun.id,
      timestamp: new Date().toISOString(),
      type: "log",
      message: "remembered log"
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

    eventSources[0].onerror?.();

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
