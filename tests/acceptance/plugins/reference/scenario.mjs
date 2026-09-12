import { AtlasClient, isAtlasAPIError } from "@the-drunken-coder/atlas-sdk";
import { execFile } from "node:child_process";
import { isDeepStrictEqual, promisify } from "node:util";
import {
  runPluginAcceptance,
  waitForPluginStatus,
} from "../support/plugin-stack.mjs";

const pluginID = "reference";
const operationID = "inspect_fixture";
const operationPath = `/plugins/${pluginID}/operations/${operationID}`;
const reproduction = "node tests/acceptance/plugins/reference/scenario.mjs";
const executeFile = promisify(execFile);

await runPluginAcceptance({
  name: "reference-plugin",
  reproduction,
  composeFile: "tests/acceptance/plugins/reference/compose.yml",
  fixtureVariant: "controlled-reference-source-v1",
  pluginService: "reference-plugin",
  run: async ({ baseUrl, apiKey, record, runID, signal, pluginStack }) => {
    const wireResponses = createWireResponseCapture();
    const client = new AtlasClient({
      baseUrl,
      apiKey,
      fetch: wireResponses.fetch,
      sync: false,
      requestTimeoutMs: 8_000,
    });
    const available = await waitForPluginStatus(
      client,
      pluginID,
      "available",
      null,
      signal,
    );
    const expectedOperations = [
      {
        operation_id: operationID,
        display_name: "Inspect fixture",
        timeout_ms: 5_000,
      },
    ];
    record({
      check:
        "Core registered the Reference manifest and every declared Operation",
      expected: {
        plugin_id: pluginID,
        display_name: "Reference Fixture",
        status: "available",
        reason_code: null,
        operations: expectedOperations,
        tool_asset_id: null,
      },
      actual: available,
      passed:
        available.plugin_id === pluginID &&
        available.display_name === "Reference Fixture" &&
        available.status === "available" &&
        available.reason_code === null &&
        available.tool_asset_id === null &&
        structurallyEqual(available.operations, expectedOperations) &&
        isTimestamp(available.checked_at),
    });

    const directSource = await probeDirectSourceRoute(runID, signal);
    record({
      check:
        "Reference Plugin cannot reach the fixture source outside the Source Gateway network",
      expected: { reachable: false },
      actual: directSource,
      passed: directSource.reachable === false,
    });

    const successInputs = new Map([[operationID, { key: "alpha" }]]);
    for (const operation of available.operations) {
      const input = successInputs.get(operation.operation_id);
      record({
        check: `declared Operation ${operation.operation_id} has a success case`,
        expected: { covered: true },
        actual: { covered: input !== undefined },
        passed: input !== undefined,
      });
      const result = await client.plugins.invoke(
        pluginID,
        operation.operation_id,
        input,
        { signal },
      );
      const expected = {
        value: { label: "Alpha fixture", count: 3 },
        provenance: {
          connector_id: "reference",
          source: "atlas_reference_fixture",
        },
        freshness: { observed_at: "2026-01-01T00:00:00Z", stale: false },
      };
      record({
        check: `declared Operation ${operation.operation_id} returned fixture data through Core and Source Gateway`,
        expected,
        actual: result,
        passed: structurallyEqual(result, expected),
      });
    }

    const invalidInput = await captureAPIError(
      () =>
        client.plugins.invoke(pluginID, operationID, { key: "" }, { signal }),
      wireResponses,
    );
    recordPluginError({
      record,
      check: "Reference rejected invalid Operation input through Core",
      actual: invalidInput,
      status: 400,
      errorCode: "PLUGIN_INPUT_REJECTED",
      message: "Plugin rejected the Operation input",
      details: { plugin_code: "invalid_key" },
    });

    const sourceFailure = await captureAPIError(
      () =>
        client.plugins.invoke(
          pluginID,
          operationID,
          { key: "source_error" },
          { signal },
        ),
      wireResponses,
    );
    recordPluginError({
      record,
      check: "Reference surfaced the controlled source failure through Core",
      actual: sourceFailure,
      status: 502,
      errorCode: "PLUGIN_FAILURE",
      message: "Plugin Operation failed",
      details: { plugin_code: "operation_failed" },
    });

    const malformedFailure = await captureAPIError(
      () =>
        client.plugins.invoke(
          pluginID,
          operationID,
          { key: "malformed" },
          { signal },
        ),
      wireResponses,
    );
    recordPluginError({
      record,
      check:
        "Reference rejected a malformed controlled source response through Core",
      actual: malformedFailure,
      status: 502,
      errorCode: "PLUGIN_FAILURE",
      message: "Plugin Operation failed",
      details: { plugin_code: "operation_failed" },
    });

    const failureProbe = await fixtureProbe(client, signal);
    record({
      check: "controlled source observed both failure variants",
      expected: { source_error_requests: 1, malformed_requests: 1 },
      actual: failureProbe,
      passed:
        failureProbe.source_error_requests === 1 &&
        failureProbe.malformed_requests === 1,
    });

    const cancellationReason = new Error(
      "Reference acceptance canceled the Operation",
    );
    const cancellation = new AbortController();
    const operationSignal = AbortSignal.any([signal, cancellation.signal]);
    const pending = client.plugins.invoke(
      pluginID,
      operationID,
      { key: "slow" },
      { signal: operationSignal },
    );
    const startedProbe = await waitForFixtureProbe(
      client,
      (probe) => probe.slow_started === 1,
      signal,
    );
    record({
      check:
        "controlled source received the slow Operation before cancellation",
      expected: { slow_started: 1 },
      actual: startedProbe,
      passed: startedProbe.slow_started === 1,
    });
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
      check: "SDK cancellation crossed Core and retained the caller reason",
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
    const canceledProbe = await waitForFixtureProbe(
      client,
      (probe) => probe.slow_canceled === 1,
      signal,
    );
    record({
      check:
        "cancellation closed the Source Gateway request to the controlled source",
      expected: { slow_canceled: 1 },
      actual: canceledProbe,
      passed: canceledProbe.slow_canceled === 1,
    });

    const stopped = await pluginStack.stop();
    record({
      check: "test control stopped the owned Reference container",
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
    record({
      check: "Core observed Reference becoming unavailable",
      expected: {
        status: "unavailable",
        reason_code: "transport_unreachable",
        operations: expectedOperations,
      },
      actual: unavailable,
      passed:
        unavailable.status === "unavailable" &&
        unavailable.reason_code === "transport_unreachable" &&
        structurallyEqual(unavailable.operations, expectedOperations) &&
        isLaterTimestamp(unavailable.checked_at, available.checked_at),
    });
    const unavailableInvocation = await captureAPIError(
      () =>
        client.plugins.invoke(
          pluginID,
          operationID,
          { key: "alpha" },
          { signal },
        ),
      wireResponses,
    );
    recordPluginError({
      record,
      check: "Core rejected invocation while Reference was unavailable",
      actual: unavailableInvocation,
      status: 503,
      errorCode: "PLUGIN_UNAVAILABLE",
      message: "Plugin is unavailable",
      details: { reason_code: "transport_unreachable" },
    });

    const restarted = await pluginStack.start();
    record({
      check: "test control restarted the same owned Reference container",
      expected: { container_id: stopped.container_id, state: "running" },
      actual: restarted,
      passed:
        restarted.container_id === stopped.container_id &&
        restarted.state === "running",
    });
    const recovered = await waitForPluginStatus(
      client,
      pluginID,
      "available",
      null,
      signal,
    );
    record({
      check: "Core observed Reference recover after restart",
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
    const recoveredResult = await client.plugins.invoke(
      pluginID,
      operationID,
      { key: "bravo" },
      { signal },
    );
    const expectedRecoveredResult = {
      value: { label: "Bravo fixture", count: 7 },
      provenance: {
        connector_id: "reference",
        source: "atlas_reference_fixture",
      },
      freshness: { observed_at: "2026-01-01T00:00:00Z", stale: false },
    };
    record({
      check:
        "restarted Reference executed its declared Operation through Source Gateway",
      expected: expectedRecoveredResult,
      actual: recoveredResult,
      passed: structurallyEqual(recoveredResult, expectedRecoveredResult),
    });
  },
});

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

function recordPluginError({
  record,
  check,
  actual,
  status,
  errorCode,
  message,
  details,
}) {
  const expected = {
    sdk: {
      status,
      error_code: errorCode,
      message,
      optional_when_present: { details },
    },
    wire_response: {
      status,
      required: { success: false, error_code: errorCode, message },
      optional_when_present: {
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
      actual.message ===
        `Atlas request failed: ${status} ${errorCode}: ${message}` &&
      optionalMatches(actual.details, details, structurallyEqual) &&
      response?.success === false &&
      response.error_code === errorCode &&
      response.message === message &&
      optionalMatches(response.details, details, structurallyEqual) &&
      wireResponse?.status === status &&
      wirePayload?.success === false &&
      wirePayload.error_code === errorCode &&
      wirePayload.message === message &&
      optionalMatches(wirePayload.details, details, structurallyEqual) &&
      optionalMatches(wirePayload.path, operationPath) &&
      optionalMatches(wirePayload.error_id, undefined, (value) =>
        /^err_[0-9a-f]{12}$/u.test(value),
      ) &&
      optionalMatches(wirePayload.timestamp, undefined, isTimestamp),
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

function parseWirePayload(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function probeDirectSourceRoute(runID, signal) {
  const ownedPlugin = await executeFile(
    "docker",
    [
      "container",
      "ls",
      "--all",
      "--quiet",
      "--filter",
      `label=io.atlas.acceptance.run=${runID}`,
      "--filter",
      "label=com.docker.compose.service=reference-plugin",
    ],
    { encoding: "utf8", signal, timeout: 5_000 },
  );
  const containerIDs = ownedPlugin.stdout.trim().split(/\s+/u).filter(Boolean);
  if (containerIDs.length !== 1) {
    throw new Error(
      `expected one owned reference-plugin container, observed ${JSON.stringify(containerIDs)}`,
    );
  }
  try {
    const result = await executeFile(
      "docker",
      [
        "exec",
        containerIDs[0],
        "wget",
        "--timeout=2",
        "--quiet",
        "--output-document=-",
        "http://reference-source:8090/fixture?key=alpha",
      ],
      { encoding: "utf8", signal, timeout: 5_000 },
    );
    return { reachable: true, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    return {
      reachable: false,
      status: typeof error.code === "number" ? error.code : null,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    };
  }
}

async function fixtureProbe(client, signal) {
  const result = await client.plugins.invoke(
    pluginID,
    operationID,
    { key: "probe" },
    { signal },
  );
  if (
    !result ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    !("value" in result)
  ) {
    throw new Error(
      `fixture probe expected an object result, observed ${JSON.stringify(result)}`,
    );
  }
  return result.value;
}

async function waitForFixtureProbe(client, predicate, signal) {
  const deadline = Date.now() + 10_000;
  let observed;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    observed = await fixtureProbe(client, signal);
    if (predicate(observed)) return observed;
    await abortableDelay(50, signal);
  }
  throw new Error(
    `fixture probe expected matching cancellation state within 10000 ms, observed ${JSON.stringify(observed)}`,
  );
}

function structurallyEqual(actual, expected) {
  return isDeepStrictEqual(actual, expected, { skipPrototype: true });
}

function optionalMatches(
  actual,
  expected,
  comparison = (value, target) => value === target,
) {
  return actual === undefined || comparison(actual, expected);
}

function isTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isLaterTimestamp(actual, before) {
  return (
    isTimestamp(actual) &&
    isTimestamp(before) &&
    Date.parse(actual) > Date.parse(before)
  );
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
