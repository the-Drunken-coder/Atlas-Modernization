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
      const client = createClient({
        baseUrl,
        apiKey,
        sync: "all",
        pollIntervalMs: 200,
        requestTimeoutMs: 10_000,
      });
      const reader = {
        index: index + 1,
        client,
        seenVersions: new Map(),
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
