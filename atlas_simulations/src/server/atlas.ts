import {
  AtlasAPIError,
  AtlasClient,
  type AtlasClientOptions
} from "@the-drunken-coder/atlas-sdk";
import type { AtlasTargetConfig, SimulationConfig } from "./config.js";

export type AtlasClientLike = Pick<AtlasClient, "watch" | "handshake"> & {
  entities: Pick<AtlasClient["entities"], "get" | "create" | "update" | "delete" | "checkIn">;
  tasks: Pick<AtlasClient["tasks"], "get" | "create" | "delete" | "acknowledge" | "complete" | "fail" | "setStatus">;
  objects: Pick<AtlasClient["objects"], "get" | "create" | "delete">;
  queries: Pick<AtlasClient["queries"], "full">;
  sync: Pick<AtlasClient["sync"], "start" | "stop" | "status">;
};

export type ClientMode = false | "all";

export type AtlasClientFactory = (options?: { sync?: ClientMode; pollIntervalMs?: number; signal?: AbortSignal }) => AtlasClientLike;

const ATLAS_REQUEST_TIMEOUT_MS = 10_000;

type AtlasClientConfig = SimulationConfig | AtlasTargetConfig;

export function createAtlasClientFactory(config: AtlasClientConfig): AtlasClientFactory {
  const baseUrl = "baseUrl" in config ? config.baseUrl : config.atlasBaseUrl;
  const apiKey = "baseUrl" in config ? config.apiKey : config.atlasApiKey;
  return (options = {}) =>
    new AtlasClient({
      baseUrl,
      apiKey,
      fetch: abortableFetch(options.signal),
      sync: options.sync ?? false,
      pollIntervalMs: options.pollIntervalMs ?? 2_000
    } satisfies AtlasClientOptions);
}

export function isNotFoundError(error: unknown): boolean {
  return error instanceof AtlasAPIError && error.status === 404;
}

function abortableFetch(signal?: AbortSignal): typeof fetch {
  return async (input, init = {}) => {
    const upstreamSignals = [signal, requestSignal(input), init.signal].filter((value): value is AbortSignal => value != null);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error(`Atlas request timed out after ${ATLAS_REQUEST_TIMEOUT_MS}ms`)), ATLAS_REQUEST_TIMEOUT_MS);
    const abort = (event: Event) => controller.abort((event.target as AbortSignal).reason);
    for (const upstreamSignal of upstreamSignals) upstreamSignal.addEventListener("abort", abort, { once: true });
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearTimeout(timeout);
      for (const upstreamSignal of upstreamSignals) upstreamSignal.removeEventListener("abort", abort);
    };
    const abortedSignal = upstreamSignals.find((upstreamSignal) => upstreamSignal.aborted);
    if (abortedSignal) controller.abort(abortedSignal.reason);
    try {
      const response = await fetch(input, { ...init, signal: controller.signal });
      return responseWithCleanup(response, cleanup);
    } catch (error) {
      cleanup();
      throw error;
    }
  };
}

function responseWithCleanup(response: Response, cleanup: () => void): Response {
  if (!response.body) {
    cleanup();
    return response;
  }
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          cleanup();
          controller.close();
          return;
        }
        controller.enqueue(result.value);
      } catch (error) {
        cleanup();
        controller.error(error);
      }
    },
    async cancel(reason) {
      cleanup();
      await reader.cancel(reason);
    }
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  });
}

function requestSignal(input: Parameters<typeof fetch>[0]): AbortSignal | undefined {
  return input instanceof Request ? input.signal : undefined;
}
