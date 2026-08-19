import { isCommandManifest, type TaskResource } from "@the-drunken-coder/atlas-sdk";
import { describe, expect, it, vi } from "vitest";
import fixtureManifestJSON from "../../atlas_protocol/conformance/tasking/fixtures/manifest.json" with { type: "json" };
import schedulingCorpus from "../../atlas_protocol/conformance/tasking/scheduling.json" with { type: "json" };
import { type AtlasAssetClient, AtlasAssetRuntime } from "../src/index.js";

describe("shared Task scheduling fixtures", () => {
  it("form a valid runtime manifest with a handler for every advertised Command", () => {
    const manifest: unknown = fixtureManifestJSON;
    expect(isCommandManifest(manifest)).toBe(true);
    if (!isCommandManifest(manifest)) throw new Error("invalid shared fixture manifest");

    const queued = schedulingCorpus.cases.find((testCase) => testCase.scheduling === "queued");
    const immediate = schedulingCorpus.cases.find((testCase) => testCase.scheduling === "immediate");
    expect(queued?.expected_release_order).toEqual(["task-1", "task-2"]);
    expect(immediate?.expected_release_order).toEqual(["task-immediate"]);

    expect(
      () =>
        new AtlasAssetRuntime(emptyClient(), {
          entityId: "asset-1",
          manifest,
          handlers: {
            "fixture.queued": async () => ({ result: "done" }),
            "fixture.immediate": async () => undefined
          }
        })
    ).not.toThrow();
  });
});

function emptyClient(): AtlasAssetClient {
  const task = async (): Promise<TaskResource> => {
    throw new Error("not called");
  };
  return {
    handshake: vi.fn(async () => undefined),
    subscribe: vi.fn(async () => undefined),
    watch: vi.fn(() => () => undefined),
    sync: { start: vi.fn(async () => undefined), stop: vi.fn() },
    entities: { checkIn: vi.fn(async () => undefined) },
    runtime: {
      begin: vi.fn(async () => undefined),
      ready: vi.fn(async () => undefined),
      tasks: vi.fn(async () => ({ tasks: [] }))
    },
    tasks: {
      acknowledge: task,
      start: task,
      progress: task,
      complete: task,
      fail: task
    }
  };
}
