import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

vi.mock("../../src/client/api.js", () => ({
  loadHealth: vi.fn(async () => ({ ok: true, status: 200, message: "ok" })),
  loadScenarios: vi.fn(async () => [scenario]),
  loadRuns: vi.fn(async () => []),
  startRun: vi.fn(async () => run),
  loadRun: vi.fn(async () => run),
  stopRun: vi.fn(async () => ({ ...run, status: "cancelled" })),
  cleanupRun: vi.fn(async () => ({ ...run, cleaned: true }))
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
    await user.click(screen.getByRole("button", { name: /start/i }));
    await waitFor(() => expect(screen.getByText("running")).toBeInTheDocument());
    expect(eventSources).toHaveLength(1);
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
    expect(eventSources[0].closed).toBe(false);

    eventSources[0].emit({
      sequence: 3,
      runId: run.id,
      timestamp: new Date().toISOString(),
      type: "cleanup",
      message: "Cleanup complete"
    });
    await waitFor(() => expect(screen.getByText("cleaned")).toBeInTheDocument());
    expect(eventSources[0].closed).toBe(true);
  });
});
