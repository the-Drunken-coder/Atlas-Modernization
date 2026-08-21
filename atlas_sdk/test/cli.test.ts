import { describe, expect, it, vi } from "vitest";
import { type CLIIO, isResourceType, parseFilter, RESOURCE_TYPE_VALUES, runCLI } from "../src/cli.js";
import { FakeCore, task } from "./support/fake-core.js";

describe("Atlas CLI", () => {
  it("prints help without opening a network connection", async () => {
    const io = captureIO();
    const fetchSpy = vi.fn(async () => {
      throw new Error("fetch should not be called for --help");
    });
    io.io.fetch = fetchSpy;
    await expect(runCLI(["--help"], io.io)).resolves.toBe(0);
    expect(io.stdout()).toContain("usage: atlas");
    expect(io.stderr()).toBe("");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects malformed commands and arguments before handshake", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("fetch should not be called for invalid CLI input");
    });

    const missingID = captureIO();
    missingID.io.fetch = fetchSpy;
    await expect(runCLI(["entities", "get"], missingID.io)).resolves.toBe(2);
    expect(missingID.stderr()).toContain("usage: invalid command");

    const badJSON = captureIO();
    badJSON.io.fetch = fetchSpy;
    await expect(runCLI(["tasks", "create", "{bad"], badJSON.io)).resolves.toBe(2);
    expect(badJSON.stderr()).toContain("invalid task JSON");

    const invalidTask = captureIO();
    invalidTask.io.fetch = fetchSpy;
    await expect(
      runCLI(["tasks", "create", '{"asset_id":"","command":"fixture.queued","input":{}}'], invalidTask.io)
    ).resolves.toBe(2);
    expect(invalidTask.stderr()).toContain("invalid task JSON");

    const missingIdempotencyKey = captureIO();
    missingIdempotencyKey.io.fetch = fetchSpy;
    await expect(
      runCLI(
        ["tasks", "create", '{"asset_id":"asset-1","command":"fixture.queued","input":{}}'],
        missingIdempotencyKey.io
      )
    ).resolves.toBe(2);
    expect(missingIdempotencyKey.stderr()).toContain("requires --idempotency-key");

    const badFilter = captureIO();
    badFilter.io.fetch = fetchSpy;
    await expect(runCLI(["watch", "--subscribe", "id:not-a-type:x"], badFilter.io)).resolves.toBe(2);
    expect(badFilter.stderr()).toContain("invalid subscription filter");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("creates tasks with Core request payloads and server defaults", async () => {
    const core = new FakeCore();
    const minimal = captureIO();
    minimal.io.fetch = core.fetch;

    await expect(
      runCLI(
        [
          "--base-url",
          "http://atlas.test",
          "--idempotency-key",
          "minimal",
          "tasks",
          "create",
          '{"asset_id":"asset-1","command":"fixture.queued","input":{}}'
        ],
        minimal.io
      )
    ).resolves.toBe(0);

    expect(JSON.parse(minimal.stdout())).toMatchObject({
      task_id: expect.stringMatching(/^task-/),
      status: "pending",
      asset_id: "asset-1",
      command: "fixture.queued",
      input: {}
    });

    const expanded = captureIO();
    expanded.io.fetch = core.fetch;
    await expect(
      runCLI(
        [
          "--base-url",
          "http://atlas.test",
          "--idempotency-key",
          "expanded",
          "tasks",
          "create",
          '{"asset_id":"asset-1","command":"fixture.queued","input":{"latitude":1,"priority":"high"}}'
        ],
        expanded.io
      )
    ).resolves.toBe(0);

    expect(JSON.parse(expanded.stdout())).toMatchObject({
      task_id: expect.stringMatching(/^task-/),
      status: "pending",
      asset_id: "asset-1",
      command: "fixture.queued",
      input: { latitude: 1, priority: "high" }
    });
  });

  it.each([
    '{"asset_id":"","command":"fixture.queued","input":{}}',
    '{"asset_id":"asset-1","command":"","input":{}}',
    '{"asset_id":"asset-1","command":"fixture.queued"}',
    '{"asset_id":"asset-1","command":"fixture.queued","input":{},"status":"pending"}',
    '{"asset_id":"asset-1","command":"fixture.queued","input":[],"extra":{}}'
  ])("rejects invalid task create request %s before handshake", async (body) => {
    const io = captureIO();

    await expect(runCLI(["--idempotency-key", "invalid", "tasks", "create", body], io.io)).resolves.toBe(2);

    expect(io.stderr()).toContain("invalid task JSON");
  });

  it("parses valid subscription filters", () => {
    expect(parseFilter("all")).toEqual({ filter: "all" });
    for (const resourceType of RESOURCE_TYPE_VALUES) {
      expect(isResourceType(resourceType)).toBe(true);
      expect(parseFilter(`type:${resourceType}`)).toEqual({ filter: "type", resource_type: resourceType });
      expect(parseFilter(`id:${resourceType}:${resourceType}-1`)).toEqual({
        filter: "id",
        resource_type: resourceType,
        id: `${resourceType}-1`
      });
    }
    expect(parseFilter("id:task:task:with:colons")).toEqual({
      filter: "id",
      resource_type: "task",
      id: "task:with:colons"
    });
    expect(parseFilter("id:task:::id")).toEqual({ filter: "id", resource_type: "task", id: "::id" });
    expect(parseFilter("tasks_for_asset:asset-1")).toEqual({ filter: "tasks_for_asset", asset_id: "asset-1" });
    expect(parseFilter("tasks_for_asset:asset:with:colons")).toEqual({
      filter: "tasks_for_asset",
      asset_id: "asset:with:colons"
    });
  });

  it("rejects invalid subscription filters", () => {
    expect(isResourceType("invalid")).toBe(false);
    expect(() => parseFilter("unknown_filter")).toThrow("invalid subscription filter");
    expect(() => parseFilter("type:invalid")).toThrow("invalid subscription filter");
    expect(() => parseFilter("id:task")).toThrow("invalid subscription filter");
    expect(() => parseFilter("id:task:")).toThrow("invalid subscription filter");
    expect(() => parseFilter("tasks_for_asset")).toThrow("invalid subscription filter");
  });

  it("requires --follow for watch subscriptions", async () => {
    const io = captureIO();

    await expect(runCLI(["watch", "--subscribe", "all"], io.io)).resolves.toBe(2);

    expect(io.stderr()).toContain("watch requires --follow");
  });

  it("requires --subscribe for watch", async () => {
    const io = captureIO();

    await expect(runCLI(["watch", "--follow"], io.io)).resolves.toBe(2);

    expect(io.stderr()).toContain("watch requires --subscribe");
  });

  it("runs watch mode through the sync engine and recovers dropped matching events", async () => {
    const core = new FakeCore();
    const captured = captureIO();
    captured.io.fetch = core.fetch;
    captured.io.WebSocket = core.attachWebSocketGlobal();
    captured.io.waitForExitSignal = async () => {
      const dropped = core.upsertTask(task("task-cli-dropped", "asset-1"));
      core.emit(
        {
          event: "update",
          resource_type: "task",
          id: dropped.task_id,
          version: dropped.metadata.version,
          resource: dropped
        },
        { dropForSockets: true, record: false }
      );
      const delivered = core.upsertTask(task("task-cli-delivered", "asset-1"));
      core.emit(
        {
          event: "update",
          resource_type: "task",
          id: delivered.task_id,
          version: delivered.metadata.version,
          resource: delivered
        },
        { record: false }
      );

      await vi.waitFor(() => {
        expect(captured.stdout()).toContain('"id":"task-cli-dropped"');
        expect(captured.stdout()).toContain('"id":"task-cli-delivered"');
      });
    };

    await expect(
      runCLI(["--base-url", "http://atlas.test", "watch", "--subscribe", "type:task", "--follow"], captured.io)
    ).resolves.toBe(0);

    expect(core.requests.some((request) => request.startsWith("/queries/full"))).toBe(true);
    expect(core.requests.some((request) => request.startsWith("/queries/changed-since?"))).toBe(true);
  });

  it("stops watch sync when follow exits with an error", async () => {
    const core = new FakeCore();
    const captured = captureIO();
    captured.io.fetch = core.fetch;
    captured.io.WebSocket = core.attachWebSocketGlobal();
    captured.io.waitForExitSignal = async () => {
      throw new Error("follow failed");
    };

    await expect(
      runCLI(["--base-url", "http://atlas.test", "watch", "--subscribe", "type:task", "--follow"], captured.io)
    ).resolves.toBe(1);

    expect(captured.stderr()).toContain("follow failed");
    expect(core.sockets.size).toBe(0);
  });

  it("prints non-Error failures without crashing", async () => {
    const core = new FakeCore();
    const captured = captureIO();
    captured.io.fetch = core.fetch;
    captured.io.WebSocket = core.attachWebSocketGlobal();
    captured.io.waitForExitSignal = async () => {
      throw "raw follow failure";
    };

    await expect(
      runCLI(["--base-url", "http://atlas.test", "watch", "--subscribe", "all", "--follow"], captured.io)
    ).resolves.toBe(1);

    expect(captured.stderr()).toContain("raw follow failure");
  });

  it("sanitizes failures before writing to stderr", async () => {
    const secret = "cli-canary-secret";
    const captured = captureIO();
    captured.io.fetch = async () => {
      throw new Error(`failed https://user:${secret}@core.test?api_key=${secret} Bearer ${secret} \u001b[31m`);
    };

    await expect(runCLI(["--base-url", "http://atlas.test", "entities", "get", "asset-1"], captured.io)).resolves.toBe(
      1
    );

    expect(captured.stderr()).not.toContain(secret);
    expect(captured.stderr()).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/);
    expect(captured.stderr()).toContain("[redacted]");
  });
});

function captureIO(): { io: CLIIO; stdout: () => string; stderr: () => string } {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout: { write: (data: string) => (stdout += data) },
      stderr: { write: (data: string) => (stderr += data) },
      env: {}
    },
    stdout: () => stdout,
    stderr: () => stderr
  };
}
