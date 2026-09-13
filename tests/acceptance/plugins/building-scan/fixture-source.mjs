import { createServer } from "node:http";

const fixtureMode = process.env.ATLAS_BUILDING_SCAN_FIXTURE_MODE ?? "required";

createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://fixture.invalid");
  if (request.method === "GET" && url.pathname === "/health") {
    writeJSON(response, 200, { status: "ok" });
    return;
  }
  if (request.method !== "POST" || url.pathname !== "/api/interpreter") {
    writeJSON(response, 404, { error: "fixture_route_not_found" });
    return;
  }

  let variant;
  try {
    variant = fixtureVariant(await requestBody(request));
  } catch (error) {
    writeJSON(response, 400, {
      error: "fixture_query_rejected",
      message: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  process.stdout.write(`${JSON.stringify({ event: "building_scan_fixture_request", variant })}\n`);

  if (variant === "source_failure") {
    writeJSON(response, 503, { error: "controlled_source_failure" });
    return;
  }
  if (variant === "malformed_geometry") {
    writeJSON(response, 200, malformedGeometry());
    return;
  }
  if (variant === "remark_timeout") {
    writeJSON(response, 200, {
      remark: "runtime error: Query timed out after 15 seconds.",
      elements: successfulBuildings().elements,
    });
    return;
  }
  if (variant === "source_busy") {
    writeJSON(response, 429, { error: "controlled_source_busy" });
    return;
  }
  if (variant === "slow") {
    const completion = setTimeout(() => writeJSON(response, 200, successfulBuildings()), 10_000);
    const cancel = () => clearTimeout(completion);
    request.once("aborted", cancel);
    response.once("close", cancel);
    return;
  }
  writeJSON(response, 200, successfulBuildings());
}).listen(8090, "0.0.0.0");

function fixtureVariant(body) {
  const query = new URLSearchParams(body).get("data");
  if (!query) throw new Error("missing Overpass data form field");
  const match = /way\["building"\]\(([^)]+)\)/u.exec(query);
  if (!match) throw new Error("missing building-way bounds");
  const [south, west, north, east] = match[1].split(",").map(Number);
  if (![south, west, north, east].every(Number.isFinite)) throw new Error("bounds must be finite numbers");
  if (!sameCoordinate(west, -71.01) || !sameCoordinate(east, -71) || !sameCoordinate(north, south + 0.01)) {
    throw new Error(`unexpected fixture bounds ${match[1]}`);
  }
  const variantBySouth = new Map([
    ["42.00", "success"],
    ["42.02", "malformed_geometry"],
    ["42.04", "source_failure"],
    ["42.06", "slow"],
    ["42.08", "source_busy"],
    ["42.10", "remark_timeout"],
  ]);
  const variant = variantBySouth.get(south.toFixed(2));
  if (!variant) throw new Error(`unexpected fixture south bound ${south}`);
  if (fixtureMode !== "nightly" && (variant === "source_busy" || variant === "remark_timeout")) {
    throw new Error(`fixture variant ${variant} is reserved for nightly coverage`);
  }
  return variant;
}

function sameCoordinate(left, right) {
  return Math.abs(left - right) < 1e-9;
}

function successfulBuildings() {
  return {
    version: 0.6,
    generator: "atlas-building-scan-acceptance-fixture",
    elements: [
      {
        type: "way",
        id: 101,
        version: 4,
        timestamp: "2026-09-12T00:00:00Z",
        changeset: 123,
        user: "Fixture Mapper",
        uid: 99,
        tags: {
          building: "office",
          name: "Fixture Hall",
          "addr:housenumber": "12",
          "addr:street": "Test Way",
        },
        geometry: [
          { lat: 42.001, lon: -71.001 },
          { lat: 42.001, lon: -71 },
          { lat: 42.002, lon: -71 },
          { lat: 42.002, lon: -71.001 },
          { lat: 42.001, lon: -71.001 },
        ],
      },
    ],
  };
}

function malformedGeometry() {
  return {
    elements: [
      {
        type: "way",
        id: 404,
        tags: { building: "yes" },
        geometry: [
          { lat: 42.021, lon: -71.001 },
          { lat: 42.021, lon: -71 },
          { lat: 42.022, lon: -71 },
          { lat: 42.022, lon: -71.001 },
        ],
      },
    ],
  };
}

function requestBody(request) {
  return new Promise((resolvePromise, rejectPromise) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.once("end", () => resolvePromise(body));
    request.once("error", rejectPromise);
    request.once("aborted", () => rejectPromise(new Error("fixture request aborted before its body completed")));
  });
}

function writeJSON(response, status, value) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}
