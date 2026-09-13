import { isDeepStrictEqual } from "node:util";

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

function eventState(event) {
  if (event.type === "resource") {
    return {
      type: event.type,
      resource: `${event.resource.type}:${event.resource.id}`,
    };
  }
  return { type: event.type, message: event.message };
}
