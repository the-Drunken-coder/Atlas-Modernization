import {
  AtlasAPIError,
  AtlasClient,
  type AtlasClientOptions
} from "../../../atlas_sdk/src/index.js";
import type { SimulationConfig } from "./config.js";

export type AtlasClientLike = Pick<AtlasClient, "watch" | "handshake"> & {
  entities: Pick<AtlasClient["entities"], "get" | "create" | "update" | "delete" | "checkIn">;
  tasks: Pick<AtlasClient["tasks"], "get" | "create" | "delete" | "acknowledge" | "complete" | "fail" | "setStatus">;
  objects: Pick<AtlasClient["objects"], "get" | "create" | "delete">;
  queries: Pick<AtlasClient["queries"], "full">;
  sync: Pick<AtlasClient["sync"], "start" | "stop" | "status">;
};

export type ClientMode = false | "all" | "selective";

export type AtlasClientFactory = (options?: { sync?: ClientMode; pollIntervalMs?: number; signal?: AbortSignal }) => AtlasClientLike;

export function createAtlasClientFactory(config: SimulationConfig): AtlasClientFactory {
  return (options = {}) =>
    new AtlasClient({
      baseUrl: config.atlasBaseUrl,
      apiKey: config.atlasApiKey,
      ...(options.signal ? { fetch: abortableFetch(options.signal) } : {}),
      sync: options.sync ?? false,
      pollIntervalMs: options.pollIntervalMs ?? 2_000
    } satisfies AtlasClientOptions);
}

export function isNotFoundError(error: unknown): boolean {
  return error instanceof AtlasAPIError && error.status === 404;
}

function abortableFetch(signal: AbortSignal): typeof fetch {
  return async (input, init = {}) => {
    const upstreamSignals = [signal, requestSignal(input), init.signal].filter((value): value is AbortSignal => value != null);
    const controller = new AbortController();
    const abort = () => controller.abort();
    for (const upstreamSignal of upstreamSignals) upstreamSignal.addEventListener("abort", abort, { once: true });
    if (upstreamSignals.some((upstreamSignal) => upstreamSignal.aborted)) abort();
    try {
      return await fetch(input, { ...init, signal: controller.signal });
    } finally {
      for (const upstreamSignal of upstreamSignals) upstreamSignal.removeEventListener("abort", abort);
    }
  };
}

function requestSignal(input: Parameters<typeof fetch>[0]): AbortSignal | undefined {
  return input instanceof Request ? input.signal : undefined;
}
