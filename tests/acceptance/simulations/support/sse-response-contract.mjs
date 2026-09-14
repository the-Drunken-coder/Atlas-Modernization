import { parseRunEvent } from "../../../../simulations/src/client/run-state.ts";

export function eventStreamResponseError(response) {
  const mediaType = response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (
    response.status === 200 &&
    mediaType === "text/event-stream" &&
    response.body
  ) {
    return undefined;
  }
  return `GET run events expected HTTP 200 with Content-Type text/event-stream, received HTTP ${response.status} with Content-Type ${mediaType ?? "missing"}`;
}

/**
 * Parse only frames the browser's EventSource `onmessage` handler would receive.
 */
export function parseBrowserRunEventFrame(frame) {
  const data = [];
  let eventType;
  for (const line of frame.split(/\r?\n/u)) {
    if (line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    const value =
      separator === -1 ? "" : line.slice(separator + 1).replace(/^ /u, "");
    if (field === "event") eventType = value;
    if (field === "data") data.push(value);
  }
  if (eventType !== undefined && eventType !== "" && eventType !== "message") {
    throw new Error(
      `Simulation event frame used EventSource-ignored type ${JSON.stringify(eventType)}`,
    );
  }
  return data.length > 0
    ? parseRunEvent(JSON.parse(data.join("\n")))
    : undefined;
}
