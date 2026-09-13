import { isDeepStrictEqual } from "node:util";

/**
 * A cancelled run may replay its terminal status in one SSE chunk and late
 * events in another. The bounded stream window must retain the cancelled
 * marker without adding an observation log or resource event.
 */
export function assessCancelledObservationWindow(
  snapshots,
  expectedResources,
  expectedObservationLogs,
) {
  const states = snapshots.map((snapshot) => snapshotState(snapshot.events));

  return {
    states,
    passed:
      states.length > 0 &&
      states.every(
        (state) =>
          state.hasCancelledMarker &&
          isDeepStrictEqual(state.resources, expectedResources) &&
          isDeepStrictEqual(state.observationLogs, expectedObservationLogs) &&
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

  return {
    hasCancelledMarker: cancelledIndex !== -1,
    resources: events
      .filter((event) => event.type === "resource")
      .map((event) => `${event.resource.type}:${event.resource.id}`)
      .sort(),
    observationLogs: events
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
