import { describe, expect, it } from "vitest";

import lifecycleCorpus from "../../atlas_protocol/conformance/tasking/lifecycle.json" with { type: "json" };
import { AtlasClient } from "../src";
import { FakeCore } from "./support/fake-core.js";

describe("Task lifecycle SDK requests", () => {
  for (const testCase of lifecycleCorpus.cases) {
    it(testCase.name, async () => {
      const core = new FakeCore();
      const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: core.fetch });
      const task = await client.tasks.create(
        { asset_id: "asset-1", command: testCase.command, input: { value: testCase.name } },
        { idempotencyKey: `conformance-${testCase.command}` }
      );

      const statuses: string[] = [];
      for (const operation of testCase.operations) {
        const updated = await applyLifecycleOperation(client, task.task_id, operation);
        statuses.push(updated.status);
      }

      expect(statuses).toEqual(testCase.statuses);
      const runtimeRequests = core.requestHeaders.filter((request) =>
        testCase.operations.some((operation) => request.path.endsWith(`/${operation}`))
      );
      expect(runtimeRequests.every((request) => request.runtimeId === "runtime-1")).toBe(true);
    });
  }
});

async function applyLifecycleOperation(client: AtlasClient, taskId: string, operation: string) {
  switch (operation) {
    case "acknowledge":
      return client.tasks.acknowledge(taskId, { runtimeId: "runtime-1" });
    case "start":
      return client.tasks.start(taskId, { runtimeId: "runtime-1" });
    case "progress":
      return client.tasks.progress(taskId, { progress: 0.5 }, { runtimeId: "runtime-1" });
    case "complete":
      return client.tasks.complete(taskId, { runtimeId: "runtime-1", output: { result: "done" } });
    default:
      throw new Error(`unsupported conformance operation ${operation}`);
  }
}
