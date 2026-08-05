import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupRun, loadRuns, startRun, stopRun } from "../../src/client/api.js";
import { useRunSession } from "../../src/client/use-run-session.js";
import type { RunSummary } from "../../src/shared/types.js";

vi.mock("../../src/client/api.js");

const run: RunSummary = {
  id: "sim-hook",
  scenarioId: "moving-assets",
  scenarioName: "Moving assets",
  status: "completed",
  startedAt: new Date().toISOString(),
  inputs: {},
  createdResources: [],
  assertions: [],
  cleaned: false
};

class FakeEventSource {
  onmessage: ((message: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor() {
    eventSources.push(this);
  }

  close() {
    this.closed = true;
  }
}

let eventSources: FakeEventSource[] = [];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

beforeEach(() => {
  eventSources = [];
  vi.resetAllMocks();
  vi.mocked(loadRuns).mockResolvedValue([]);
  vi.mocked(startRun).mockResolvedValue(run);
  vi.mocked(stopRun).mockResolvedValue(run);
  vi.mocked(cleanupRun).mockResolvedValue({ ...run, cleaned: true });
  vi.stubGlobal("EventSource", FakeEventSource);
});

describe("useRunSession", () => {
  it("reports an initial run-load failure", async () => {
    vi.mocked(loadRuns).mockRejectedValueOnce(new Error("runs unavailable"));
    const { result } = renderHook(() => useRunSession(vi.fn()));

    await waitFor(() => expect(result.current.error).toBe("runs unavailable"));
  });

  it("selects scenario runs and starts with an API key", async () => {
    const onScenarioSelected = vi.fn();
    vi.mocked(loadRuns).mockResolvedValueOnce([run]).mockResolvedValue([run]);
    const { result } = renderHook(() => useRunSession(onScenarioSelected));
    await waitFor(() => expect(result.current.runs).toHaveLength(1));

    act(() => result.current.selectScenarioRun(run.scenarioId));
    expect(result.current.currentRun?.id).toBe(run.id);
    act(() => result.current.selectScenarioRun("missing"));
    expect(result.current.currentRun).toBeUndefined();

    await act(async () => {
      await result.current.start({ scenarioId: run.scenarioId, targetId: "local", inputs: {} }, "api-key");
    });
    expect(vi.mocked(startRun)).toHaveBeenCalledWith(
      { scenarioId: run.scenarioId, targetId: "local", inputs: {} },
      "api-key"
    );
    expect(onScenarioSelected).toHaveBeenCalledWith(run.scenarioId);
  });

  it("guards concurrent stops and reports stop failures", async () => {
    const pendingStop = deferred<RunSummary>();
    vi.mocked(stopRun).mockReturnValueOnce(pendingStop.promise).mockRejectedValueOnce(new Error("stop failed"));
    const { result } = renderHook(() => useRunSession(vi.fn()));
    await waitFor(() => expect(vi.mocked(loadRuns)).toHaveBeenCalled());
    act(() => result.current.selectRun({ ...run, status: "running" }));

    let firstStop!: Promise<RunSummary | undefined>;
    act(() => {
      firstStop = result.current.stopCurrentRun();
    });
    await waitFor(() => expect(result.current.mutationPending).toBe(true));
    await expect(result.current.stopCurrentRun()).resolves.toBeUndefined();
    pendingStop.resolve({ ...run, status: "cancelled" });
    await act(async () => firstStop);

    act(() => result.current.selectRun({ ...run, status: "running" }));
    await act(async () => {
      await result.current.stopCurrentRun();
    });
    expect(result.current.error).toBe("stop failed");
  });

  it("cleans with an API key and recovers from cleanup failure", async () => {
    vi.mocked(cleanupRun)
      .mockResolvedValueOnce({ ...run, cleaned: true })
      .mockRejectedValueOnce(new Error("cleanup failed"));
    const { result } = renderHook(() => useRunSession(vi.fn()));
    await waitFor(() => expect(vi.mocked(loadRuns)).toHaveBeenCalled());
    act(() => result.current.selectRun(run));

    await act(async () => {
      await result.current.cleanupCurrentRun("cleanup-key");
    });
    expect(vi.mocked(cleanupRun)).toHaveBeenCalledWith(run.id, "cleanup-key");

    act(() => result.current.selectRun({ ...run, id: "sim-hook-failure" }));
    await act(async () => {
      await result.current.cleanupCurrentRun();
    });
    expect(result.current.error).toBe("cleanup failed");
  });

  it("rejects cross-run events and closes a completed cleanup stream", async () => {
    const { result } = renderHook(() => useRunSession(vi.fn()));
    await waitFor(() => expect(vi.mocked(loadRuns)).toHaveBeenCalled());
    act(() => result.current.selectRun({ ...run, status: "running" }));
    expect(eventSources).toHaveLength(1);

    act(() => {
      eventSources[0].onmessage?.({
        data: JSON.stringify({
          sequence: 1,
          runId: "another-run",
          timestamp: new Date().toISOString(),
          type: "log",
          message: "wrong stream"
        })
      } as MessageEvent<string>);
    });
    expect(result.current.error).toContain("Received event for another-run");
    expect(eventSources[0].closed).toBe(true);

    act(() => result.current.selectRun({ ...run, id: "sim-cleanup-stream", status: "running" }));
    expect(eventSources).toHaveLength(2);
    act(() => {
      eventSources[1].onmessage?.({
        data: JSON.stringify({
          sequence: 1,
          runId: "sim-cleanup-stream",
          timestamp: new Date().toISOString(),
          type: "cleanup",
          message: "Cleanup complete"
        })
      } as MessageEvent<string>);
    });
    expect(eventSources[1].closed).toBe(true);
  });

  it("closes replaced event streams and ignores their late callbacks", async () => {
    const { result } = renderHook(() => useRunSession(vi.fn()));
    await waitFor(() => expect(vi.mocked(loadRuns)).toHaveBeenCalled());
    act(() => result.current.selectRun({ ...run, id: "first-run", status: "running" }));
    act(() => result.current.selectRun({ ...run, id: "second-run", status: "running" }));

    expect(eventSources).toHaveLength(2);
    expect(eventSources[0].closed).toBe(true);

    act(() => {
      eventSources[0].onmessage?.({
        data: JSON.stringify({
          sequence: 1,
          runId: "first-run",
          timestamp: new Date().toISOString(),
          type: "error",
          message: "late error"
        })
      } as MessageEvent<string>);
      eventSources[0].onerror?.();
    });

    expect(result.current.currentRun).toMatchObject({ id: "second-run" });
    expect(result.current.error).toBeUndefined();
    expect(vi.mocked(loadRuns)).toHaveBeenCalledTimes(1);
  });

  it("honors terminal lifecycle semantics for a duplicate event", async () => {
    const { result } = renderHook(() => useRunSession(vi.fn()));
    await waitFor(() => expect(vi.mocked(loadRuns)).toHaveBeenCalled());
    act(() => result.current.selectRun({ ...run, status: "running" }));
    const source = eventSources[0];
    const timestamp = new Date().toISOString();

    act(() => {
      source.onmessage?.({
        data: JSON.stringify({ sequence: 1, runId: run.id, timestamp, type: "log", message: "recorded" })
      } as MessageEvent<string>);
      source.onmessage?.({
        data: JSON.stringify({
          sequence: 1,
          runId: run.id,
          timestamp,
          type: "status",
          status: "completed",
          message: "duplicate terminal sequence"
        })
      } as MessageEvent<string>);
    });

    expect(source.closed).toBe(true);
    expect(result.current.events).toHaveLength(1);
  });
});
