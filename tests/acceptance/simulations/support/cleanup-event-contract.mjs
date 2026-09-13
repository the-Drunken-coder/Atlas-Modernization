import { isDeepStrictEqual } from "node:util";

export function assessCleanupResourceEvents(events, resources, preserved) {
  const expected = resources.map((resource) => ({
    type: resource.type,
    id: resource.id,
    message: preserved.has(resourceKey(resource))
      ? `${resource.type} ${resource.id} owned instance is no longer present`
      : `Deleted ${resource.type} ${resource.id}`,
  }));
  const actual = events
    .filter((event) => event.type === "cleanup" && event.resource)
    .map((event) => ({
      type: event.resource.type,
      id: event.resource.id,
      message: event.message,
    }));

  return {
    expected: sortCleanupEvents(expected),
    actual: sortCleanupEvents(actual),
    passed: isDeepStrictEqual(
      sortCleanupEvents(actual),
      sortCleanupEvents(expected),
    ),
  };
}

export function assessCreatedResourceEvents(events, resources) {
  const expected = resources.map((resource) => ({
    type: resource.type,
    id: resource.id,
    message: `Created ${resource.type} ${resource.id}`,
  }));
  const actual = events
    .filter((event) => event.type === "resource")
    .map((event) => ({
      type: event.resource.type,
      id: event.resource.id,
      message: event.message,
    }));
  return {
    expected: sortResourceEvents(expected),
    actual: sortResourceEvents(actual),
    passed: isDeepStrictEqual(
      sortResourceEvents(actual),
      sortResourceEvents(expected),
    ),
  };
}

export function assessCleanupCompletionOrder(events) {
  const resourceEventIndexes = [];
  const completionEventIndexes = [];
  events.forEach((event, index) => {
    if (event.type !== "cleanup") return;
    if (event.resource !== undefined) resourceEventIndexes.push(index);
    if (event.resource === undefined && event.message === "Cleanup complete") {
      completionEventIndexes.push(index);
    }
  });
  return {
    expected: { cleanup_complete_after_all_resource_messages: true },
    actual: {
      resource_event_indexes: resourceEventIndexes,
      completion_event_indexes: completionEventIndexes,
    },
    passed:
      resourceEventIndexes.length > 0 &&
      completionEventIndexes.length === 1 &&
      resourceEventIndexes.every((index) => index < completionEventIndexes[0]),
  };
}

export function resourceKey(resource) {
  return `${resource.type}:${resource.id}`;
}

function sortCleanupEvents(events) {
  return sortResourceEvents(events);
}

function sortResourceEvents(events) {
  return [...events].sort((left, right) =>
    resourceKey(left).localeCompare(resourceKey(right)),
  );
}
