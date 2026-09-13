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

export function resourceKey(resource) {
  return `${resource.type}:${resource.id}`;
}

function sortCleanupEvents(events) {
  return [...events].sort((left, right) =>
    resourceKey(left).localeCompare(resourceKey(right)),
  );
}
