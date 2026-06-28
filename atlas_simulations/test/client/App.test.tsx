import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startRun } from "../../src/client/api.js";
import { App } from "../../src/client/App.js";
import type { RunEvent, RunSummary, ScenarioDescriptor } from "../../src/shared/types.js";

const scenario: ScenarioDescriptor = {
  id: "moving-assets",
  name: "Moving assets",
  summary: "Creates assets",
  acceptsJson: true,
  inputFields: [{ key: "assetCount", label: "Asset count", type: "number", defaultValue: 2, min: 1, max: 4 }]
};

const run: RunSummary = {
  id: "sim-test",
  scenarioId: "moving-assets",
  scenarioName: "Moving assets",
  status: "running",
  startedAt: new Date().toISOString(),
  inputs: { assetCount: 2 },
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
  stopRun: vi.fn(async () => cloneRun({ status: "cancelled" })),
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
    this.onmessage?.({ data: JSON.stringify(event) } as MessageEvent<string>);
  }

  close() {
    this.closed = true;
  }
}

describe("App", () => {
  beforeEach(() => {
    eventSources = [];
    vi.clearAllMocks();
    vi.stubGlobal("EventSource", FakeEventSource);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads scenarios and starts a selected run", async () => {
    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Atlas Simulations" })).toBeInTheDocument();
    expect((await screen.findAllByText("Moving assets")).length).toBeGreaterThan(0);
    const assetCount = screen.getByLabelText("Asset count");
    const jsonInput = screen.getByLabelText("JSON input");
    await user.clear(assetCount);
    await user.type(assetCount, "3");
    fireEvent.change(jsonInput, { target: { value: '{"note":"ok"}' } });
    await user.click(screen.getByRole("button", { name: /start/i }));
    await waitFor(() =>
      expect(vi.mocked(startRun)).toHaveBeenCalledWith({
        scenarioId: scenario.id,
        inputs: { assetCount: 3 },
        jsonInput: '{"note":"ok"}'
      })
    );
    await waitFor(() => expect(screen.getByText("running")).toBeInTheDocument());
    expect(eventSources).toHaveLength(1);
    expect(eventSources[0].url).toBe(`/api/runs/${encodeURIComponent(run.id)}/events`);
    eventSources[0].emit({
      sequence: 1,
      runId: run.id,
      timestamp: new Date().toISOString(),
      type: "assertion",
      assertion: { id: "assert-1", name: "streamed check", passed: true, timestamp: new Date().toISOString() },
      message: "PASS streamed check"
    });
    expect(await screen.findByText("streamed check")).toBeInTheDocument();

    eventSources[0].emit({
      sequence: 2,
      runId: run.id,
      timestamp: new Date().toISOString(),
      type: "status",
      status: "completed",
      message: "Run completed"
    });
    await waitFor(() => expect(screen.getByText("completed")).toBeInTheDocument());
    expect(eventSources[0].closed).toBe(true);
    await user.click(screen.getByRole("button", { name: /cleanup/i }));
    await waitFor(() => expect(screen.getByText("cleaned")).toBeInTheDocument());
  });
});
