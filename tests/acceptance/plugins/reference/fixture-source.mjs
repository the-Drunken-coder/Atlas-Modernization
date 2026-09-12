import { createServer } from "node:http";

const observedAt = "2026-01-01T00:00:00Z";
const values = Object.freeze({
  alpha: { label: "Alpha fixture", count: 3 },
  bravo: { label: "Bravo fixture", count: 7 },
});
const observations = {
  malformed_requests: 0,
  slow_canceled: 0,
  slow_started: 0,
  source_error_requests: 0,
};

createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://fixture.invalid");
  if (request.method !== "GET" || url.pathname !== "/fixture") {
    response.writeHead(404).end();
    return;
  }

  const key = url.searchParams.get("key") ?? "";
  process.stdout.write(
    `${JSON.stringify({ event: "fixture_request", key })}\n`,
  );
  if (key === "source_error") {
    observations.source_error_requests += 1;
    writeJSON(response, 503, { error: "controlled_source_failure" }, key);
    return;
  }
  if (key === "malformed") {
    observations.malformed_requests += 1;
    response.writeHead(200, {
      "Content-Type": "application/json",
      "X-Fixture": key,
    });
    response.end('{"value":');
    return;
  }
  if (key === "slow") {
    observations.slow_started += 1;
    let completed = false;
    const timer = setTimeout(() => {
      completed = true;
      writeJSON(
        response,
        200,
        { value: { delayed: true }, observed_at: observedAt },
        key,
      );
    }, 4_000);
    response.once("close", () => {
      if (completed || response.writableEnded) return;
      clearTimeout(timer);
      observations.slow_canceled += 1;
      process.stdout.write(
        `${JSON.stringify({ event: "fixture_canceled", key })}\n`,
      );
    });
    return;
  }
  if (key === "probe") {
    writeJSON(
      response,
      200,
      { value: { ...observations }, observed_at: observedAt },
      key,
    );
    return;
  }

  const value = values[key];
  if (!value) {
    writeJSON(response, 404, { error: "fixture_not_found" }, key);
    return;
  }
  writeJSON(response, 200, { value, observed_at: observedAt }, key);
}).listen(8090, "0.0.0.0");

function writeJSON(response, status, value, key) {
  response.writeHead(status, {
    "Content-Type": "application/json",
    "X-Fixture": key,
  });
  response.end(JSON.stringify(value));
}
