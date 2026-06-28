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

export type AtlasClientFactory = (options?: { sync?: ClientMode; pollIntervalMs?: number }) => AtlasClientLike;

export function createAtlasClientFactory(config: SimulationConfig): AtlasClientFactory {
  return (options = {}) =>
    new AtlasClient({
      baseUrl: config.atlasBaseUrl,
      apiKey: config.atlasApiKey,
      sync: options.sync ?? false,
      pollIntervalMs: options.pollIntervalMs ?? 2_000
    } satisfies AtlasClientOptions);
}

export function isNotFoundError(error: unknown): boolean {
  return error instanceof AtlasAPIError && error.status === 404;
}
