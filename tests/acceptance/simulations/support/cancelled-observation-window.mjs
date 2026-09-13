import { isDeepStrictEqual } from "node:util";
import {
  assessReplayAssertionParity,
  orderAssertionResults,
} from "./run-event-replay-contract.mjs";

/**
 * A cancelled run may replay its terminal status in one SSE chunk and late
 * events in another. The bounded stream window must retain the cancelled
 * marker without adding an observation log or resource event.
 */
export function assessCancelledObservationWindow(snapshots) {
  const states = snapshots.map((snapshot) => snapshotState(snapshot.events));
  const baseline = states.find((state) => state.hasCancelledMarker);

  return {
    baseline,
    states,
    passed:
      baseline !== undefined &&
      states.every(
        (state) =>
          state.hasCancelledMarker &&
          isDeepStrictEqual(state.resources, baseline.resources) &&
          isDeepStrictEqual(state.observationLogs, baseline.observationLogs) &&
          state.lateActivity.length === 0,
      ),
  };
}

export function assessCancelledObservationAssertions({
  progressEvents,
  postStopEvents,
  stoppedAssertions,
  rereadAssertions,
  observationCount,
  verifierAssertions,
}) {
  const progress = orderAssertionResults(
    progressEvents
      .filter((event) => event.type === "assertion")
      .map((event) => event.assertion),
  );
  const stopped = orderAssertionResults(stoppedAssertions);
  const reread = orderAssertionResults(rereadAssertions);
  const cancelledPrefix = eventsThroughCancelledMarker(postStopEvents);
  const assertionsAfterCancelled = postStopEvents
    .slice(
      cancelledPrefix.marker === undefined
        ? postStopEvents.length
        : cancelledPrefix.marker + 1,
    )
    .filter((event) => event.type === "assertion")
    .map((event) => event.assertion);
  const observationPairs = observedObservationPairs(cancelledPrefix.events);
  const allObservationPairsRecorded =
    observationPairs.length === observationCount &&
    observationPairs.every((observation, index) => observation === index + 1);
  const allowedAssertions = allObservationPairsRecorded
    ? (assertions) =>
        assertions.length === 0 ||
        isDeepStrictEqual(assertions, verifierAssertions)
    : (assertions) => assertions.length === 0;
  const postStopReplay = assessReplayAssertionParity(
    postStopEvents,
    rereadAssertions,
  );
  return {
    expected: {
      cancelled_marker: "exactly once",
      observation_pairs_before_cancelled: observationCount,
      assertion_events_after_cancelled: [],
      ...(allObservationPairsRecorded
        ? { allowed_assertions: [[], verifierAssertions] }
        : { allowed_assertions: [] }),
      pre_stop_assertions_retained_by_stop_summary: true,
      stop_assertions_retained_by_cancelled_summary: true,
      post_stop_replay_matches_cancelled_summary: postStopReplay.expected,
    },
    actual: {
      cancelled_marker_indexes: cancelledPrefix.indexes,
      observation_pairs_before_cancelled: observationPairs,
      assertion_events_after_cancelled: orderAssertionResults(
        assertionsAfterCancelled,
      ),
      pre_stop_assertions: progress,
      stop_summary_assertions: stopped,
      cancelled_summary_assertions: reread,
      post_stop_replay: postStopReplay.actual,
    },
    passed:
      cancelledPrefix.indexes.length === 1 &&
      assertionsAfterCancelled.length === 0 &&
      hasUniqueAssertionIDs(progress) &&
      hasUniqueAssertionIDs(stopped) &&
      hasUniqueAssertionIDs(reread) &&
      allowedAssertions(progress) &&
      allowedAssertions(stopped) &&
      allowedAssertions(reread) &&
      assertionResultsAreSubset(progress, stopped) &&
      assertionResultsAreSubset(stopped, reread) &&
      postStopReplay.passed,
  };
}

function snapshotState(events) {
  const cancelledIndex = events.findIndex(
    (event) => event.type === "status" && event.status === "cancelled",
  );
  const lateActivity =
    cancelledIndex === -1
      ? []
      : events
          .slice(cancelledIndex + 1)
          .filter(
            (event) =>
              event.type === "resource" ||
              (event.type === "log" &&
                event.message.startsWith("Observation ")),
          )
          .map(eventState);
  const prefix =
    cancelledIndex === -1 ? [] : events.slice(0, cancelledIndex + 1);

  return {
    hasCancelledMarker: cancelledIndex !== -1,
    resources: prefix
      .filter((event) => event.type === "resource")
      .map((event) => `${event.resource.type}:${event.resource.id}`)
      .sort(),
    observationLogs: prefix
      .filter(
        (event) =>
          event.type === "log" && event.message.startsWith("Observation "),
      )
      .map((event) => event.message),
    lateActivity,
  };
}

function eventsThroughCancelledMarker(events) {
  const indexes = events.flatMap((event, index) =>
    event.type === "status" && event.status === "cancelled" ? [index] : [],
  );
  const marker = indexes[0];
  return {
    indexes,
    marker,
    events: marker === undefined ? [] : events.slice(0, marker + 1),
  };
}

function observedObservationPairs(events) {
  return [
    ...new Set(
      events.flatMap((event) => {
        if (event.type !== "log") return [];
        const match = /^Observation ([1-9]\d*) linked /u.exec(event.message);
        return match ? [Number(match[1])] : [];
      }),
    ),
  ].sort((left, right) => left - right);
}

function assertionResultsAreSubset(expected, actual) {
  const actualByID = new Map(
    actual.map((assertion) => [assertion.id, assertion]),
  );
  return expected.every((assertion) =>
    isDeepStrictEqual(actualByID.get(assertion.id), assertion),
  );
}

function hasUniqueAssertionIDs(assertions) {
  return (
    new Set(assertions.map((assertion) => assertion.id)).size ===
    assertions.length
  );
}

function eventState(event) {
  if (event.type === "resource") {
    return {
      type: event.type,
      resource: `${event.resource.type}:${event.resource.id}`,
    };
  }
  return { type: event.type, message: event.message };
}
