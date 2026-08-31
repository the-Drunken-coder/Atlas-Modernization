export function formatSpatialReason(reason: string): string {
  return reason.replaceAll("_", " ");
}

export function formatSpatialRetrievalTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? value
    : date.toLocaleTimeString(undefined, {
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit"
      });
}
