import { useEffect, useRef, useState } from "react";
import type { RunEvent, RunSummary, StartRunRequest } from "../shared/types.js";
import {
  loadRuns,
  cleanupRun as requestCleanupRun,
  startRun as requestStartRun,
  stopRun as requestStopRun
} from "./api.js";
import { RunEventStream } from "./run-event-stream.js";
import {
  appendRunEvent,
  applyRunEvent,
  errorMessage,
  isTerminalStatus,
  mergeRunLists,
  mergeRunSummary
} from "./run-state.js";

const ACTIVE_RUN_REFRESH_MS = 2_000;

export function useRunSession(onScenarioSelected: (scenarioId: string) => void) {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [currentRun, setCurrentRun] = useState<RunSummary | undefined>();
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [mutationPending, setMutationPending] = useState(false);
  const [cleanupRunId, setCleanupRunId] = useState<string | undefined>();
  const eventStreamRef = useRef<RunEventStream | undefined>(undefined);
  eventStreamRef.current ??= new RunEventStream();
  const eventStream = eventStreamRef.current;
  const cleanupStreamRunIdRef = useRef<string | undefined>(undefined);
  const currentRunIdRef = useRef<string | undefined>(undefined);
  const refreshRunsRequestRef = useRef(0);
  const disconnectedRunIdsRef = useRef(new Set<string>());
  const runsRef = useRef<RunSummary[]>([]);
  const eventsByRunIdRef = useRef<Map<string, RunEvent[]>>(new Map());
  const onScenarioSelectedRef = useRef(onScenarioSelected);
  const effectsRef = useRef({ refreshRuns, refreshRunsBestEffort, reportError });
  onScenarioSelectedRef.current = onScenarioSelected;
  effectsRef.current = { refreshRuns, refreshRunsBestEffort, reportError };

  const hasRunningRuns = runs.some((run) => run.status === "running");
  const hasCleanupInFlight = !!cleanupRunId && runs.some((run) => run.id === cleanupRunId && !run.cleaned);

  useEffect(() => {
    let cancelled = false;
    void effectsRef.current.refreshRuns().catch((errorValue) => {
      if (!cancelled) effectsRef.current.reportError(errorValue);
    });
    return () => {
      cancelled = true;
      eventStreamRef.current?.close();
    };
  }, []);

  useEffect(() => {
    runsRef.current = runs;
  }, [runs]);

  useEffect(() => {
    currentRunIdRef.current = currentRun?.id;
  }, [currentRun?.id]);

  useEffect(() => {
    if (!hasRunningRuns && !hasCleanupInFlight) return;
    const interval = window.setInterval(() => void effectsRef.current.refreshRunsBestEffort(), ACTIVE_RUN_REFRESH_MS);
    return () => window.clearInterval(interval);
  }, [hasCleanupInFlight, hasRunningRuns]);

  async function refreshRuns() {
    const requestId = ++refreshRunsRequestRef.current;
    const runIdsAtRequestStart = new Set(runsRef.current.map((run) => run.id));
    const loadedRuns = await loadRuns();
    if (requestId !== refreshRunsRequestRef.current) return;
    const mergedRuns = mergeRunLists(runsRef.current, loadedRuns, runIdsAtRequestStart);
    const mergedRunIds = new Set(mergedRuns.map((run) => run.id));
    for (const runId of eventsByRunIdRef.current.keys()) {
      if (!mergedRunIds.has(runId)) eventsByRunIdRef.current.delete(runId);
    }
    for (const runId of disconnectedRunIdsRef.current) {
      if (!mergedRunIds.has(runId)) disconnectedRunIdsRef.current.delete(runId);
    }
    runsRef.current = mergedRuns;
    setRuns(mergedRuns);
    setError(undefined);
    const selectedRunAfterLoad = selectedRunId();
    if (selectedRunAfterLoad && !mergedRuns.some((run) => run.id === selectedRunAfterLoad)) {
      clearRunSelection();
      return;
    }
    const refreshedSelection = selectedRunAfterLoad
      ? mergedRuns.find((run) => run.id === selectedRunAfterLoad)
      : undefined;
    const replayCleanedRun = needsCleanedRunReplay(
      refreshedSelection,
      selectedRunAfterLoad ? (eventsByRunIdRef.current.get(selectedRunAfterLoad) ?? []) : []
    );
    const replayDisconnectedRun =
      !!selectedRunAfterLoad &&
      refreshedSelection?.status !== "running" &&
      disconnectedRunIdsRef.current.has(selectedRunAfterLoad);
    if (
      !replayCleanedRun &&
      !replayDisconnectedRun &&
      refreshedSelection?.status !== "running" &&
      eventStream.runId === selectedRunAfterLoad &&
      cleanupStreamRunIdRef.current !== selectedRunAfterLoad
    ) {
      closeActiveEventSource();
    }
    const needsCleanupReconnect =
      cleanupRunId === selectedRunAfterLoad && !!refreshedSelection && !refreshedSelection.cleaned;
    setCurrentRun((current) => {
      if (!current) return current;
      const refreshed = mergedRuns.find((run) => run.id === current.id);
      return refreshed ? mergeRunSummary(current, refreshed) : current;
    });
    if (
      selectedRunAfterLoad &&
      refreshedSelection &&
      (eventStream.runId !== selectedRunAfterLoad || replayCleanedRun || replayDisconnectedRun) &&
      (refreshedSelection.status === "running" || needsCleanupReconnect || replayCleanedRun || replayDisconnectedRun)
    ) {
      if (needsCleanupReconnect) cleanupStreamRunIdRef.current = selectedRunAfterLoad;
      connectEvents(selectedRunAfterLoad, { preserveCleanup: needsCleanupReconnect, replayCleanedRun });
    }
  }

  async function refreshRunsBestEffort() {
    try {
      await refreshRuns();
    } catch (errorValue) {
      reportError(errorValue);
    }
  }

  function reportError(errorValue: unknown) {
    setError(errorMessage(errorValue));
  }

  async function start(request: StartRunRequest, apiKey?: string): Promise<RunSummary | undefined> {
    if (mutationPending) return undefined;
    setError(undefined);
    setMutationPending(true);
    try {
      const run = apiKey ? await requestStartRun(request, apiKey) : await requestStartRun(request);
      upsertRun(run);
      selectRun(run);
      await refreshRunsBestEffort();
      return run;
    } catch (errorValue) {
      reportError(errorValue);
      return undefined;
    } finally {
      setMutationPending(false);
    }
  }

  function selectRun(run: RunSummary) {
    onScenarioSelectedRef.current(run.scenarioId);
    activateRun(run);
  }

  function selectScenarioRun(scenarioId: string) {
    const scenarioRun = runs.find((run) => run.scenarioId === scenarioId);
    if (scenarioRun) {
      activateRun(scenarioRun);
      return;
    }
    clearRunSelection();
  }

  function activateRun(run: RunSummary) {
    const needsCleanupStream = cleanupStreamRunIdRef.current === run.id && !run.cleaned;
    const cachedEvents = eventsByRunIdRef.current.get(run.id) ?? [];
    const replayCleanedRun = needsCleanedRunReplay(run, cachedEvents);
    const replayDisconnectedRun = disconnectedRunIdsRef.current.has(run.id);
    const needsReplayStream =
      run.status !== "running" && (cachedEvents.length === 0 || replayCleanedRun || replayDisconnectedRun);
    currentRunIdRef.current = run.id;
    if (currentRun?.id === run.id) {
      setCurrentRun((current) => (current ? { ...current, ...run } : run));
      if (run.status === "running" || needsCleanupStream || needsReplayStream) {
        if (eventStream.runId !== run.id || replayDisconnectedRun)
          connectEvents(run.id, {
            preserveCleanup: needsCleanupStream,
            replayCleanedRun
          });
      } else if (eventStream.runId === run.id && cleanupStreamRunIdRef.current !== run.id) {
        closeActiveEventSource({ preserveCleanup: true });
      }
      return;
    }
    setEvents(cachedEvents);
    setCurrentRun(run);
    if (run.status === "running" || needsCleanupStream || needsReplayStream) {
      connectEvents(run.id, {
        preserveCleanup: needsCleanupStream,
        replayCleanedRun
      });
    } else {
      closeActiveEventSource({ preserveCleanup: true });
    }
  }

  function clearRunSelection() {
    currentRunIdRef.current = undefined;
    setEvents([]);
    setCurrentRun(undefined);
    closeActiveEventSource({ preserveCleanup: true });
  }

  function connectEvents(runId: string, options: { preserveCleanup?: boolean; replayCleanedRun?: boolean } = {}) {
    closeActiveEventSource({ preserveCleanup: options.preserveCleanup });
    if (!options.preserveCleanup) cleanupStreamRunIdRef.current = undefined;
    eventStream.connect(runId, {
      onEvent(event) {
        disconnectedRunIdsRef.current.delete(runId);
        const terminalStatus =
          !options.replayCleanedRun &&
          event.type === "status" &&
          isTerminalStatus(event.status) &&
          cleanupStreamRunIdRef.current !== runId;
        const cleanupComplete = event.type === "cleanup" && !event.resource;
        const nextEvents = appendRunEvent(eventsByRunIdRef.current.get(runId) ?? [], event);
        if (nextEvents) {
          eventsByRunIdRef.current.set(runId, nextEvents);
          if (currentRunIdRef.current === runId) setEvents(nextEvents);
          setCurrentRun((current) => (current?.id === runId ? applyRunEvent(current, event) : current));
          setRuns((current) => {
            const next = current.map((run) => (run.id === runId ? applyRunEvent(run, event) : run));
            runsRef.current = next;
            return next;
          });
        }
        if (cleanupComplete) {
          cleanupStreamRunIdRef.current = undefined;
          setCleanupRunId((current) => (current === runId ? undefined : current));
          return true;
        }
        return terminalStatus;
      },
      onInvalidEvent(error) {
        if (cleanupStreamRunIdRef.current === runId) cleanupStreamRunIdRef.current = undefined;
        reportError(error);
      },
      onConnectionError() {
        disconnectedRunIdsRef.current.add(runId);
        void refreshRunsBestEffort();
      }
    });
  }

  async function stopCurrentRun(): Promise<RunSummary | undefined> {
    if (!currentRun || mutationPending) return undefined;
    const targetRunId = currentRun.id;
    setError(undefined);
    setMutationPending(true);
    try {
      const updatedRun = await requestStopRun(targetRunId);
      upsertRun(updatedRun);
      await refreshRunsBestEffort();
      return updatedRun;
    } catch (errorValue) {
      reportError(errorValue);
      return undefined;
    } finally {
      setMutationPending(false);
    }
  }

  async function cleanupCurrentRun(apiKey?: string): Promise<RunSummary | undefined> {
    if (!currentRun || mutationPending) return undefined;
    const targetRunId = currentRun.id;
    setError(undefined);
    setMutationPending(true);
    try {
      cleanupStreamRunIdRef.current = targetRunId;
      if (eventStream.runId !== targetRunId) connectEvents(targetRunId, { preserveCleanup: true });
      setCleanupRunId(targetRunId);
      const updatedRun = apiKey ? await requestCleanupRun(targetRunId, apiKey) : await requestCleanupRun(targetRunId);
      upsertRun(updatedRun);
      if (updatedRun.cleaned && cleanupStreamRunIdRef.current === targetRunId) {
        cleanupStreamRunIdRef.current = undefined;
        if (eventStream.runId === targetRunId) closeActiveEventSource();
      }
      if (updatedRun.cleaned) setCleanupRunId(undefined);
      await refreshRunsBestEffort();
      return updatedRun;
    } catch (errorValue) {
      if (cleanupStreamRunIdRef.current === targetRunId) {
        cleanupStreamRunIdRef.current = undefined;
        if (eventStream.runId === targetRunId) closeActiveEventSource();
      }
      setCleanupRunId(undefined);
      reportError(errorValue);
      return undefined;
    } finally {
      setMutationPending(false);
    }
  }

  function upsertRun(run: RunSummary) {
    setRuns((current) => {
      const index = current.findIndex((existing) => existing.id === run.id);
      if (index === -1) {
        const next = [run, ...current];
        runsRef.current = next;
        return next;
      }
      const next = [...current];
      next[index] = mergeRunSummary(next[index], run);
      runsRef.current = next;
      return next;
    });
    setCurrentRun((current) => (current?.id === run.id ? mergeRunSummary(current, run) : current));
  }

  function closeActiveEventSource(options: { preserveCleanup?: boolean } = {}) {
    if (!options.preserveCleanup) cleanupStreamRunIdRef.current = undefined;
    if (!eventStream.runId) return;
    eventStream.close();
  }

  function selectedRunId(): string | undefined {
    return eventStream.runId ?? currentRunIdRef.current;
  }

  return {
    cleanupCurrentRun,
    clearError: () => setError(undefined),
    currentRun,
    error,
    events,
    mutationPending,
    reportError,
    runs,
    selectRun,
    selectScenarioRun,
    start,
    stopCurrentRun
  };
}

function needsCleanedRunReplay(run: RunSummary | undefined, events: RunEvent[]): boolean {
  return !!run?.cleaned && !events.some((event) => event.type === "cleanup" && event.resource === undefined);
}
