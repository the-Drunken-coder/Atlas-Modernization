import { AtlasAssetRuntime } from "@the-drunken-coder/atlas-asset-runtime";
import { isCommandManifest } from "@the-drunken-coder/atlas-sdk";
import { describe, expect, it, vi } from "vitest";
import fixtureManifestJSON from "../../atlas_protocol/conformance/tasking/fixtures/manifest.json" with { type: "json" };
import { createFakeAtlasCore } from "./support/fake-atlas.js";

describe("fixture Command closed loop", () => {
  it("delivers a Task through the runtime and retains its completed history", async () => {
    const manifest: unknown = fixtureManifestJSON;
    if (!isCommandManifest(manifest)) throw new Error("invalid shared fixture manifest");
    const core = createFakeAtlasCore();
    const operator = core.factory();
    const asset = core.factory({ sync: "all" });
    await operator.entities.create({ entity_id: "asset-1", entity_type: "asset" });
    const runtime = new AtlasAssetRuntime(asset, {
      entityId: "asset-1",
      manifest,
      handlers: {
        "fixture.queued": async ({ reportProgress }) => {
          await reportProgress(0.5);
          return { result: "done" };
        },
        "fixture.immediate": async () => undefined
      }
    });

    await runtime.start();
    const task = await operator.tasks.create(
      { asset_id: "asset-1", command: "fixture.queued", input: { value: "closed-loop" } },
      { idempotencyKey: "closed-loop-attempt" }
    );
    asset.sync.status();

    await vi.waitFor(async () => {
      await expect(operator.tasks.get(task.task_id)).resolves.toMatchObject({
        status: "completed",
        progress: 0.5,
        output: { result: "done" }
      });
    });
    expect(core.state.tasks.size).toBe(1);
    await runtime.stop();
  });
});
