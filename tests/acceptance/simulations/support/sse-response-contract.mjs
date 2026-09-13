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
