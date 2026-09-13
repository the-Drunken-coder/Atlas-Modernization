import { AtlasClient } from "@the-drunken-coder/atlas-sdk";

/**
 * Starts every reader before returning them to the scenario. If any reader
 * fails to initialize, wait for every concurrent start to settle before
 * stopping each reader that was created, so a successful poller cannot outlive
 * the failed setup.
 */
export async function startReaders({
  count,
  baseUrl,
  apiKey,
  signal,
  createClient = (options) => new AtlasClient(options),
}) {
  const readers = [];

  try {
    for (let index = 0; index < count; index += 1) {
      const readerTransport = { observing: false, requests: [] };
      const client = createClient({
        baseUrl,
        apiKey,
        sync: "all",
        pollIntervalMs: 0,
        requestTimeoutMs: 10_000,
        fetch: createObservedFetch(readerTransport),
      });
      const reader = {
        index: index + 1,
        client,
        seenVersions: new Map(),
        transport: readerTransport,
        unwatch: () => {},
      };
      readers.push(reader);
      reader.unwatch = client.watch(
        { filter: "type", resource_type: "entity" },
        (resource) => {
          if (resource?.entity_id) {
            reader.seenVersions.set(
              resource.entity_id,
              resource.metadata.version,
            );
          }
        },
      );
    }

    const results = await Promise.allSettled(
      readers.map(async (reader) => {
        signal.throwIfAborted();
        await reader.client.sync.start();
      }),
    );
    const failedStart = results.find((result) => result.status === "rejected");
    if (failedStart) throw failedStart.reason;
    return readers;
  } catch (startError) {
    const cleanupErrors = stopReaders(readers);
    if (cleanupErrors.length === 0) throw startError;
    throw new AggregateError(
      [startError, ...cleanupErrors],
      "A simulation sync reader failed to start and cleanup also failed",
      { cause: startError },
    );
  }
}

/**
 * Begins observing real SDK HTTP calls after feed startup and before the
 * scenario creates writer resources. The fetch hook delegates to the runtime
 * implementation; it never supplies a response itself.
 */
export function observeReaderTransport(readers) {
  for (const reader of readers) {
    reader.transport.requests.length = 0;
    reader.transport.observing = true;
  }
}

export function stopReaders(readers) {
  const cleanupErrors = [];
  for (const reader of readers) {
    try {
      reader.unwatch();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      reader.client.sync.stop();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  return cleanupErrors;
}

export function readerTeardownFailure(primaryFailure, teardownErrors) {
  if (teardownErrors.length === 0) return primaryFailure;
  const error =
    primaryFailure === undefined
      ? new AggregateError(
          teardownErrors,
          "External simulation reader teardown failed",
        )
      : new AggregateError(
          [primaryFailure, ...teardownErrors],
          "Simulation scenario failed and external reader teardown also failed",
          { cause: primaryFailure },
        );
  error.acceptanceEvidence = {
    ...(primaryFailure === undefined
      ? {}
      : { primary_failure: serializeReaderFailure(primaryFailure) }),
    reader_teardown_failures: teardownErrors.map(serializeReaderFailure),
  };
  return error;
}

function serializeReaderFailure(error) {
  if (!(error instanceof Error)) return { message: String(error) };
  return {
    name: error.name,
    message: error.message,
    ...(error.acceptanceEvidence === undefined
      ? {}
      : { evidence: error.acceptanceEvidence }),
  };
}

function createObservedFetch(transport) {
  return async (input, init) => {
    if (transport.observing) {
      transport.requests.push({
        method: requestMethod(input, init),
        path: requestPath(input),
      });
    }
    return fetch(input, init);
  };
}

function requestMethod(input, init) {
  if (init?.method) return init.method;
  if (typeof input === "object" && input && "method" in input) {
    return input.method;
  }
  return "GET";
}

function requestPath(input) {
  const url =
    typeof input === "string" || input instanceof URL
      ? String(input)
      : input.url;
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
}
