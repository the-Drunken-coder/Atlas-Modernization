import { isDeepStrictEqual } from "node:util";

export function assessExpectedSuccessEvents(events, runID) {
  const errorEvents = events
    .filter((event) => event.type === "error")
    .map((event) => ({ sequence: event.sequence, message: event.message }));
  const runIDs = [...new Set(events.map((event) => event.runId))];
  const sequences = events.map((event) => event.sequence);
  return {
    expected: {
      run_id: runID,
      error_events: [],
      strictly_increasing_sequences: true,
    },
    actual: {
      run_ids: runIDs,
      error_events: errorEvents,
      sequences,
    },
    passed:
      events.length > 0 &&
      events.every(
        (event) => event.runId === runID && event.type !== "error",
      ) &&
      strictlyIncreasing(sequences),
  };
}

export function assessLifecycleStatusMessages(events, scenarioName, terminal) {
  const statuses = events.filter((event) => event.type === "status");
  const initial = statuses.at(0);
  const terminals = statuses.filter((event) => event.status !== "running");
  const expected = {
    initial: { status: "running", message: `${scenarioName} started` },
    ...(terminal === undefined ? { terminal_events: [] } : { terminal }),
  };
  const actual = {
    initial:
      initial === undefined
        ? undefined
        : { status: initial.status, message: initial.message },
    terminal_events: terminals.map((event) => ({
      status: event.status,
      message: event.message,
    })),
  };
  return {
    expected,
    actual,
    passed:
      initial?.status === "running" &&
      initial.message === `${scenarioName} started` &&
      (terminal === undefined
        ? terminals.length === 0
        : terminals.length === 1 &&
          terminals[0].status === terminal.status &&
          terminals[0].message === terminal.message),
  };
}

export function assessCompletedEventOrder(events) {
  const terminalEvents = events.flatMap((event, index) =>
    event.type === "status" && event.status !== "running"
      ? [{ index, status: event.status }]
      : [],
  );
  const evidenceIndexes = events.flatMap((event, index) =>
    ["resource", "log", "assertion"].includes(event.type) ? [index] : [],
  );
  return {
    expected: {
      completed_terminal:
        "exactly once after every resource, log, and assertion",
    },
    actual: {
      terminal_events: terminalEvents,
      evidence_indexes: evidenceIndexes,
    },
    passed:
      terminalEvents.length === 1 &&
      terminalEvents[0].status === "completed" &&
      terminalEvents[0].index === events.length - 1 &&
      evidenceIndexes.every((index) => index < terminalEvents[0].index),
  };
}

export function assessReplayAssertionParity(events, summaryAssertions) {
  const streamResults = orderAssertionResults(
    events
      .filter((event) => event.type === "assertion")
      .map((event) => event.assertion),
  );
  const summaryResults = orderAssertionResults(summaryAssertions);
  return {
    expected: "SSE and summary assertions have matching nonempty messages",
    actual: { stream_results: streamResults, summary_results: summaryResults },
    streamResults,
    summaryResults,
    passed:
      streamResults.every(hasNonemptyMessage) &&
      summaryResults.every(hasNonemptyMessage) &&
      isDeepStrictEqual(streamResults, summaryResults),
  };
}

export function orderAssertionResults(assertions) {
  return assertions
    .map((assertion) => ({
      id: assertion?.id,
      name: assertion?.name,
      passed: assertion?.passed,
      message: assertion?.message,
    }))
    .sort(
      (left, right) => assertionSequence(left.id) - assertionSequence(right.id),
    );
}

function assertionSequence(id) {
  const match = /^assert-([1-9]\d*)$/u.exec(id ?? "");
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

function hasNonemptyMessage(assertion) {
  return (
    typeof assertion.message === "string" && assertion.message.trim().length > 0
  );
}

function strictlyIncreasing(values) {
  return values.every(
    (value, index) => index === 0 || value > values[index - 1],
  );
}
