import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { App } from "../../src/client/App.js";
import { cleanupRun, loadRuns, loadScenarios, startRun, stopRun } from "../../src/client/api.js";
import { jsonNumber } from "../../src/shared/types.js";
import { cloneRun, eventSources, run, scenario, syncScenario } from "./App.test-harness.js";

vi.mock("../../src/client/api.js");

describe("App run lifecycle", () => {
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
    const recentRun = await screen.findByRole("button", { name: syncRun.scenarioName });
    await user.click(recentRun);

    expect(screen.getByRole("button", { name: /multi-client sync checks sync/i })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(recentRun).toHaveAttribute("aria-current", "true");
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
      vi.mocked(loadRuns)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([completedRun])
        .mockResolvedValue([completedRun]);

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
