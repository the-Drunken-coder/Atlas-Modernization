import { AtlasClient, isAtlasAPIError, isRFC3339Timestamp } from "@the-drunken-coder/atlas-sdk";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isDeepStrictEqual } from "node:util";
import { runPluginAcceptance, waitForPluginStatus } from "../support/plugin-stack.mjs";

const pluginID = "building_scan";
const operationID = "search_buildings";
const operationPath = `/plugins/${pluginID}/operations/${operationID}`;
const reproduction = "node tests/acceptance/plugins/building-scan/scenario.mjs";
const isNightly = process.env.ATLAS_BUILDING_SCAN_FIXTURE_MODE === "nightly";
const areas = {
  success: { west: -71.01, south: 42, east: -71, north: 42.01 },
  malformedGeometry: { west: -71.01, south: 42.02, east: -71, north: 42.03 },
  sourceFailure: { west: -71.01, south: 42.04, east: -71, north: 42.05 },
  slow: { west: -71.01, south: 42.06, east: -71, north: 42.07 },
  sourceBusy: { west: -71.01, south: 42.08, east: -71, north: 42.09 },
  timeoutRemark: { west: -71.01, south: 42.1, east: -71, north: 42.11 },
};

const controlledFixture = await createControlledFixture();
process.env.ATLAS_BUILDING_SCAN_SOURCE_CONNECTOR_FILE = controlledFixture.connectorPath;
process.env.ATLAS_BUILDING_SCAN_FIXTURE_EVENTS_DIRECTORY = controlledFixture.directory;

try {
await runPluginAcceptance({
  name: "building-scan-plugin",
  reproduction,
  composeFile: "tests/acceptance/plugins/building-scan/compose.yml",
  fixtureVariant: isNightly ? "controlled-building-scan-source-v1-nightly" : "controlled-building-scan-source-v1",
  pluginService: "building-scan-plugin",
  run: async ({ baseUrl, apiKey, artifacts, record, signal, pluginStack }) => {
    await copyFile(
      controlledFixture.connectorPath,
      join(artifacts, "building-scan-source-connector.json"),
    );
    record({
      check: "controlled source connector retained shipped route, limit, rate, and circuit policy",
      expected: controlledFixture.expectedConnector,
      actual: controlledFixture.connector,
      passed: structurallyEqual(controlledFixture.connector, controlledFixture.expectedConnector),
    });
    const wireResponses = createWireResponseCapture();
    const client = new AtlasClient({
      baseUrl,
      apiKey,
      fetch: wireResponses.fetch,
      sync: false,
      requestTimeoutMs: 8_000,
    });
    const expectedOperations = [
      {
        operation_id: operationID,
        display_name: "Search buildings",
        timeout_ms: 20_000,
        interaction: { kind: "map_area" },
      },
    ];
    const available = await waitForPluginStatus(client, pluginID, "available", null, signal);
    record({
      check: "Core registered the Building Scan manifest and every declared Operation",
      expected: {
        plugin_id: pluginID,
        display_name: "Building Scan",
        status: "available",
        reason_code: null,
        operations: expectedOperations,
        tool_asset_id: null,
      },
      actual: available,
      passed:
        available.plugin_id === pluginID &&
        available.display_name === "Building Scan" &&
        available.status === "available" &&
        available.reason_code === null &&
        available.tool_asset_id === null &&
        structurallyEqual(available.operations, expectedOperations) &&
        isTimestamp(available.checked_at),
    });

    const successInputs = new Map([[operationID, areas.success]]);
    for (const operation of available.operations) {
      const input = successInputs.get(operation.operation_id);
      record({
        check: `declared Operation ${operation.operation_id} has a success case`,
        expected: { covered: true },
        actual: { covered: input !== undefined },
        passed: input !== undefined,
      });
      const invocation = await invokeSpatial(client, operation.operation_id, input, signal);
      recordSuccessfulResult(record, operation.operation_id, invocation);
    }

    const invalidInput = await captureAPIError(
      () => client.plugins.invoke(pluginID, operationID, { ...areas.success, east: -71.01 }, { signal }),
      wireResponses,
    );
    recordPluginError({
      record,
      check: "Building Scan rejected an invalid map area through Core",
      actual: invalidInput,
      status: 400,
      errorCode: "PLUGIN_INPUT_REJECTED",
      message: "Plugin rejected the Operation input",
      details: { plugin_code: "invalid_map_area" },
    });

    await recordSpatialFailure({
      client,
      wireResponses,
      record,
      signal,
      check: "Building Scan rejected malformed geometry from the controlled source",
      area: areas.malformedGeometry,
      pluginCode: "malformed_source_response",
    });
    await recordSpatialFailure({
      client,
      wireResponses,
      record,
      signal,
      check: "Building Scan surfaced the controlled source failure through Core",
      area: areas.sourceFailure,
      pluginCode: "source_unavailable",
    });

    if (isNightly) {
      await recordSpatialFailure({
        client,
        wireResponses,
        record,
        signal,
        check: "Building Scan surfaced the bounded nightly source-busy response",
        area: areas.sourceBusy,
        pluginCode: "source_busy",
      });
      await recordSpatialFailure({
        client,
        wireResponses,
        record,
        signal,
        check: "Building Scan rejected the bounded nightly timeout remark",
        area: areas.timeoutRemark,
        pluginCode: "source_timeout",
      });
    }

    const cancellationReason = new Error("Building Scan acceptance canceled the Operation");
    const cancellation = new AbortController();
    const operationSignal = AbortSignal.any([signal, cancellation.signal]);
    const eventCountBeforeSlowRequest = (await readFixtureEvents(controlledFixture.eventsPath)).length;
    const pending = client.plugins.invokeSpatial(pluginID, operationID, areas.slow, { signal: operationSignal });
    try {
      const sourceStarted = await waitForFixtureEvent({
        eventsPath: controlledFixture.eventsPath,
        event: "slow_request_started",
        after: eventCountBeforeSlowRequest,
        signal,
      });
      record({
        check: "slow Building Scan request reached the controlled source before caller cancellation",
        expected: { event: "slow_request_started" },
        actual: sourceStarted,
        passed: sourceStarted.event === "slow_request_started",
      });

      const canceledAt = new Date();
      cancellation.abort(cancellationReason);
      let cancellationResult;
      try {
        cancellationResult = { returned: await pending };
      } catch (error) {
        cancellationResult = {
          same_reason: error === cancellationReason,
          name: error instanceof Error ? error.name : typeof error,
          message: error instanceof Error ? error.message : String(error),
        };
      }
      record({
        check: "SDK cancellation crossed Core during a slow Building Scan Operation",
        expected: {
          same_reason: true,
          name: "Error",
          message: cancellationReason.message,
        },
        actual: cancellationResult,
        passed:
          cancellationResult.same_reason === true &&
          cancellationResult.name === "Error" &&
          cancellationResult.message === cancellationReason.message,
      });

      const sourceClosed = await waitForFixtureEvent({
        eventsPath: controlledFixture.eventsPath,
        event: "slow_request_connection_closed",
        after: eventCountBeforeSlowRequest,
        signal,
      });
      record({
        check: "caller cancellation closed the controlled source connection",
        expected: { event: "slow_request_connection_closed", after: canceledAt.toISOString() },
        actual: sourceClosed,
        passed:
          sourceClosed.event === "slow_request_connection_closed" &&
          isTimestamp(sourceClosed.occurred_at) &&
          Date.parse(sourceClosed.occurred_at) >= canceledAt.getTime(),
      });
    } finally {
      await copyFile(controlledFixture.eventsPath, join(artifacts, "building-scan-source-events.jsonl"));
    }

    const availableAfterCancellation = await waitForPluginStatus(client, pluginID, "available", null, signal);
    record({
      check: "caller cancellation left Building Scan available",
      expected: { status: "available", reason_code: null, operations: expectedOperations },
      actual: availableAfterCancellation,
      passed:
        availableAfterCancellation.status === "available" &&
        availableAfterCancellation.reason_code === null &&
        structurallyEqual(availableAfterCancellation.operations, expectedOperations) &&
        isTimestamp(availableAfterCancellation.checked_at),
    });

    const stopStartedAt = new Date();
    const stopped = await pluginStack.stop();
    const stopCompletedAt = new Date();
    record({
      check: "test control stopped the owned Building Scan container",
      expected: { state: "exited" },
      actual: stopped,
      passed: stopped.state === "exited",
    });
    const unavailable = await waitForPluginStatus(
      client,
      pluginID,
      "unavailable",
      "transport_unreachable",
      signal,
    );
    const unavailableDetectedAt = new Date();
    record({
      check: "Core observed Building Scan becoming unavailable",
      expected: {
        status: "unavailable",
        reason_code: "transport_unreachable",
        operations: expectedOperations,
        checked_at: {
          format: "RFC3339 timestamp",
          not_before: stopStartedAt.toISOString(),
          not_after: unavailableDetectedAt.toISOString(),
        },
      },
      actual: {
        ...unavailable,
        stop: { started_at: stopStartedAt.toISOString(), completed_at: stopCompletedAt.toISOString() },
        unavailable_detected_at: unavailableDetectedAt.toISOString(),
      },
      passed:
        unavailable.status === "unavailable" &&
        unavailable.reason_code === "transport_unreachable" &&
        structurallyEqual(unavailable.operations, expectedOperations) &&
        isTimestampWithinWindow(unavailable.checked_at, stopStartedAt, unavailableDetectedAt),
    });
    const unavailableInvocation = await captureAPIError(
      () => client.plugins.invokeSpatial(pluginID, operationID, areas.success, { signal }),
      wireResponses,
    );
    recordPluginError({
      record,
      check: "Core rejected Building Scan invocation while the container was unavailable",
      actual: unavailableInvocation,
      status: 503,
      errorCode: "PLUGIN_UNAVAILABLE",
      message: "Plugin is unavailable",
      details: { reason_code: "transport_unreachable" },
    });

    const restarted = await pluginStack.start();
    record({
      check: "test control restarted the same owned Building Scan container",
      expected: { container_id: stopped.container_id, state: "running" },
      actual: restarted,
      passed: restarted.container_id === stopped.container_id && restarted.state === "running",
    });
    const recovered = await waitForPluginStatus(client, pluginID, "available", null, signal);
    record({
      check: "Core observed Building Scan recover after restart",
      expected: {
        status: "available",
        reason_code: null,
        operations: expectedOperations,
      },
      actual: recovered,
      passed:
        recovered.status === "available" &&
        recovered.reason_code === null &&
        structurallyEqual(recovered.operations, expectedOperations) &&
        isLaterTimestamp(recovered.checked_at, unavailable.checked_at),
    });
    const recoveredInvocation = await invokeSpatial(client, operationID, areas.success, signal);
    recordSuccessfulResult(
      record,
      operationID,
      recoveredInvocation,
      "restarted Building Scan routed the controlled source fixture",
    );
  },
});
} finally {
  delete process.env.ATLAS_BUILDING_SCAN_SOURCE_CONNECTOR_FILE;
  delete process.env.ATLAS_BUILDING_SCAN_FIXTURE_EVENTS_DIRECTORY;
  await rm(controlledFixture.directory, { force: true, recursive: true });
}

async function recordSpatialFailure({ client, wireResponses, record, signal, check, area, pluginCode }) {
  const failure = await captureAPIError(
    () => client.plugins.invokeSpatial(pluginID, operationID, area, { signal }),
    wireResponses,
  );
  recordPluginError({
    record,
    check,
    actual: failure,
    status: 502,
    errorCode: "PLUGIN_FAILURE",
    message: "Plugin Operation failed",
    details: { plugin_code: pluginCode },
  });
}

async function invokeSpatial(client, operation, input, signal) {
  const startedAt = new Date();
  const result = await client.plugins.invokeSpatial(pluginID, operation, input, { signal });
  return { completedAt: new Date(), result, startedAt };
}

function recordSuccessfulResult(record, operation, invocation, check = undefined) {
  const { completedAt, result, startedAt } = invocation;
  const expected = {
    attribution: {
      text: "Map data from OpenStreetMap",
      url: "https://www.openstreetmap.org/copyright",
    },
    provenance: {
      connector_id: "building_scan",
      source: "OpenStreetMap through an Overpass-compatible endpoint",
    },
    truncation: null,
    features: [
      {
        id: "way/101",
        title: "Fixture Hall",
        fields: [
          { label: "Address", value: "12 Test Way" },
          { label: "OSM version", value: "4" },
          { label: "Last edited", value: "2026-09-12T00:00:00Z" },
          { label: "Changeset", value: "123" },
          { label: "Contributor", value: "Fixture Mapper" },
          { label: "Contributor ID", value: "99" },
          { label: "addr:housenumber", value: "12" },
          { label: "addr:street", value: "Test Way" },
          { label: "building", value: "office" },
          { label: "name", value: "Fixture Hall" },
        ],
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [-71.001, 42.001],
              [-71, 42.001],
              [-71, 42.002],
              [-71.001, 42.002],
              [-71.001, 42.001],
            ],
          ],
        },
      },
    ],
  };
  const actual = {
    attribution: result.attribution,
    provenance: result.provenance,
    truncation: result.truncation,
    features: result.features,
    retrieved_at: result.retrieved_at,
  };
  record({
    check: check ?? `declared Operation ${operation} returned the controlled Building Scan fixture through Core and Source Gateway`,
    expected: {
      ...expected,
      retrieved_at: {
        format: "RFC3339 timestamp",
        not_before: startedAt.toISOString(),
        not_after: completedAt.toISOString(),
      },
    },
    actual: { ...actual, invocation: { started_at: startedAt.toISOString(), completed_at: completedAt.toISOString() } },
    passed:
      structurallyEqual({ ...actual, retrieved_at: undefined }, { ...expected, retrieved_at: undefined }) &&
      isTimestampWithinWindow(result.retrieved_at, startedAt, completedAt),
  });
}

async function captureAPIError(operation, wireResponses) {
  const marker = wireResponses.mark();
  try {
    return { returned: await operation() };
  } catch (error) {
    if (!isAtlasAPIError(error)) throw error;
    return {
      status: error.status,
      error_code: error.errorCode,
      details: error.details,
      message: error.message,
      response: error.response,
      wire_response: wireResponses.latestSince(marker),
    };
  }
}

function recordPluginError({ record, check, actual, status, errorCode, message, details }) {
  const expected = {
    sdk: {
      status,
      error_code: errorCode,
      message,
      details,
    },
    wire_response: {
      status,
      required: {
        success: false,
        error_code: errorCode,
        message,
        details,
        path: operationPath,
        error_id: "err_<12 lowercase hex characters>",
        timestamp: "RFC3339 timestamp",
      },
    },
  };
  const response = actual.response;
  const wireResponse = actual.wire_response;
  const wirePayload = wireResponse?.body;
  record({
    check,
    expected,
    actual,
    passed:
      actual.status === status &&
      actual.error_code === errorCode &&
      actual.message === `Atlas request failed: ${status} ${errorCode}: ${message}` &&
      structurallyEqual(actual.details, details) &&
      response?.success === false &&
      response.error_code === errorCode &&
      response.message === message &&
      structurallyEqual(response.details, details) &&
      wireResponse?.status === status &&
      wirePayload?.success === false &&
      wirePayload.error_code === errorCode &&
      wirePayload.message === message &&
      structurallyEqual(wirePayload.details, details) &&
      wirePayload.path === operationPath &&
      /^err_[0-9a-f]{12}$/u.test(wirePayload.error_id) &&
      isTimestamp(wirePayload.timestamp),
  });
}

function createWireResponseCapture() {
  const responses = [];
  return {
    fetch: async (input, init) => {
      const response = await fetch(input, init);
      responses.push({
        status: response.status,
        body: parseWirePayload(await response.clone().text()),
      });
      return response;
    },
    mark() {
      return responses.length;
    },
    latestSince(marker) {
      return responses.slice(marker).at(-1);
    },
  };
}

async function waitForFixtureEvent({ eventsPath, event, after, signal }) {
  const deadline = Date.now() + 25_000;
  let events = [];
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    events = await readFixtureEvents(eventsPath);
    const observed = events.slice(after).find((entry) => entry.event === event);
    if (observed) return observed;
    await abortableDelay(50, signal);
  }
  throw new Error(`fixture event ${event} was not observed within 25000 ms: ${JSON.stringify(events.slice(after))}`);
}

async function readFixtureEvents(eventsPath) {
  const content = await readFile(eventsPath, "utf8");
  return content
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function parseWirePayload(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function structurallyEqual(actual, expected) {
  return isDeepStrictEqual(actual, expected, { skipPrototype: true });
}

function isTimestamp(value) {
  return isRFC3339Timestamp(value);
}

function isTimestampWithinWindow(value, startedAt, completedAt) {
  if (!isTimestamp(value)) return false;
  const time = Date.parse(value);
  return time >= startedAt.getTime() && time <= completedAt.getTime();
}

function isLaterTimestamp(actual, before) {
  return isTimestamp(actual) && isTimestamp(before) && Date.parse(actual) > Date.parse(before);
}

function abortableDelay(milliseconds, signal) {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(finish, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      rejectPromise(signal.reason);
    };
    function finish() {
      signal.removeEventListener("abort", onAbort);
      resolvePromise();
    }
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function createControlledFixture() {
  const source = new URL("../../../../plugins/building_scan/source-connector.json", import.meta.url);
  const shipped = JSON.parse(await readFile(source, "utf8"));
  const connector = structuredClone(shipped);
  connector.origin = "http://building-scan-source:8090";
  connector.egress = { ...connector.egress, allow_private: true };
  const directory = await mkdtemp(join(tmpdir(), "atlas-building-scan-source-"));
  const connectorPath = join(directory, "building-scan-source-connector.json");
  const eventsPath = join(directory, "events.jsonl");
  await writeFile(connectorPath, `${JSON.stringify(connector, null, 2)}\n`);
  await writeFile(eventsPath, "");
  return {
    connector,
    directory,
    connectorPath,
    eventsPath,
    expectedConnector: {
      ...shipped,
      origin: connector.origin,
      egress: { ...shipped.egress, allow_private: true },
    },
  };
}
