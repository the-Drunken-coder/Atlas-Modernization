import { AtlasClient, type AtlasClientOptions } from "../../src";
import type { FakeCore } from "./fake-core.js";

type FakeCoreClientOptions = Omit<AtlasClientOptions, "baseUrl">;

export function createAtlasClient(core: FakeCore, options: FakeCoreClientOptions = {}): AtlasClient {
  return new AtlasClient({ baseUrl: "http://atlas.test", fetch: core.fetch, ...options });
}
