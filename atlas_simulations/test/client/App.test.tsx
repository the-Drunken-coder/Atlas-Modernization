import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";
import { App } from "../../src/client/App.js";
import { cleanupRun, loadRuns, loadTargets, startRun } from "../../src/client/api.js";
import { jsonNumber } from "../../src/shared/types.js";
import {
  type AtlasTargetSummary,
  cloneRun,
  deferred,
  deployedTarget,
  eventSources,
  localTarget,
  type RunEvent,
  run,
  scenario
} from "./App.test-harness.js";

vi.mock("../../src/client/api.js");

describe("App startup and forms", () => {
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

    render(
      <StrictMode>
        <App />
      </StrictMode>
    );
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
    expect(assetCount).toHaveValue(3);
    expect(jsonInput).toHaveValue('{"note":"ok"}');
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
});
