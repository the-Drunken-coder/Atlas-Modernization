import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const fixture = JSON.parse(readFileSync(new URL("./fixture.json", import.meta.url), "utf8"));

const server = createServer((request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    writeJSON(response, 200, { status: "ok" });
    return;
  }
  if (request.method === "GET" && request.url === "/manifest") {
    writeJSON(response, 200, fixture.manifest);
    return;
  }
  if (request.method === "POST" && request.url === "/operations/inspect_map_windows") {
    void respondToSpatialOperation(request, response);
    return;
  }
  writeJSON(response, 404, { code: "route_not_found" });
});

server.listen(8080, "0.0.0.0");

async function respondToSpatialOperation(request, response) {
  let actual;
  try {
    actual = await readJSON(request);
  } catch {
    writeJSON(response, 400, { code: "invalid_json" });
    return;
  }
  if (!matchesExpectedArea(actual, fixture.expected_request)) {
    writeJSON(response, 422, {
      code: "unexpected_map_area",
      expected: fixture.expected_request,
      actual
    });
    return;
  }
  writeJSON(response, 200, fixture.result);
}

async function readJSON(request) {
  request.setEncoding("utf8");
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 16_384) throw new Error("request body is too large");
  }
  return JSON.parse(body);
}

function matchesExpectedArea(actual, expectedRequest) {
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
  const keys = Object.keys(actual).sort();
  if (keys.join(",") !== "east,north,south,west") return false;
  return keys.every(
    (key) =>
      typeof actual[key] === "number" &&
      Number.isFinite(actual[key]) &&
      Math.abs(actual[key] - expectedRequest.area[key]) <= expectedRequest.coordinate_tolerance
  );
}

function writeJSON(response, status, body) {
  const serialized = `${JSON.stringify(body)}\n`;
  response.writeHead(status, {
    "Content-Length": Buffer.byteLength(serialized),
    "Content-Type": "application/json; charset=utf-8"
  });
  response.end(serialized);
}
