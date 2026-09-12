import { AtlasClient, isAtlasAPIError } from "@the-drunken-coder/atlas-sdk";
import {
  runPluginAcceptance,
  waitForPluginStatus,
} from "../support/plugin-stack.mjs";

const pluginID = "reference";
const operationID = "inspect_fixture";
const operationPath = `/plugins/${pluginID}/operations/${operationID}`;
const reproduction = "node tests/acceptance/plugins/reference/scenario.mjs";

await runPluginAcceptance({
  name: "reference-plugin",
  reproduction,
  composeFile: "tests/acceptance/plugins/reference/compose.yml",
  fixtureVariant: "controlled-reference-source-v1",
  pluginService: "reference-plugin",
  run: async ({ baseUrl, apiKey, record, signal, pluginStack }) => {
    const client = new AtlasClient({
      baseUrl,
      apiKey,
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
        jsonEqual(available.operations, expectedOperations) &&
        isTimestamp(available.checked_at),
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
        passed: jsonEqual(result, expected),
      });
    }

    const invalidInput = await captureAPIError(() =>
      client.plugins.invoke(pluginID, operationID, { key: "" }, { signal }),
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

    const sourceFailure = await captureAPIError(() =>
      client.plugins.invoke(
        pluginID,
        operationID,
        { key: "source_error" },
        { signal },
      ),
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

    const malformedFailure = await captureAPIError(() =>
      client.plugins.invoke(
        pluginID,
        operationID,
        { key: "malformed" },
        { signal },
      ),
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
        jsonEqual(unavailable.operations, expectedOperations) &&
        isLaterTimestamp(unavailable.checked_at, available.checked_at),
    });
    const unavailableInvocation = await captureAPIError(() =>
      client.plugins.invoke(
        pluginID,
        operationID,
        { key: "alpha" },
        { signal },
      ),
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
        jsonEqual(recovered.operations, expectedOperations) &&
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
      passed: jsonEqual(recoveredResult, expectedRecoveredResult),
    });
  },
});

async function captureAPIError(operation) {
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
    status,
    error_code: errorCode,
    message,
    details,
    path: operationPath,
  };
  const response = actual.response;
  record({
    check,
    expected,
    actual,
    passed:
      actual.status === status &&
      actual.error_code === errorCode &&
      actual.message ===
        `Atlas request failed: ${status} ${errorCode}: ${message}` &&
      jsonEqual(actual.details, details) &&
      response?.success === false &&
      response.error_code === errorCode &&
      response.message === message &&
      response.path === operationPath &&
      jsonEqual(response.details, details) &&
      /^err_[0-9a-f]{12}$/u.test(response.error_id) &&
      isTimestamp(response.timestamp),
  });
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

function jsonEqual(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
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
