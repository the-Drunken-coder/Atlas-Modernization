import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/client/App.js";
import type { RunSummary, ScenarioDescriptor } from "../../src/shared/types.js";

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
  assertions: []
};

vi.mock("../../src/client/api.js", () => ({
  loadHealth: vi.fn(async () => ({ ok: true, atlasBaseUrl: "http://localhost:8000", status: 200, message: "ok" })),
  loadScenarios: vi.fn(async () => [scenario]),
  loadRuns: vi.fn(async () => []),
  startRun: vi.fn(async () => run),
  loadRun: vi.fn(async () => run),
  stopRun: vi.fn(async () => ({ ...run, status: "cancelled" })),
  cleanupRun: vi.fn(async () => ({ ...run, status: "cleaned" }))
}));

class FakeEventSource {
  onmessage: ((message: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {}
  close() {}
}

describe("App", () => {
  beforeEach(() => {
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
  });
});
