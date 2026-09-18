import { describe, expect, it, vi } from "vitest";
import { PluginOperationFailure } from "../src/operation-errors.js";
import type { LifecycleOperationProgress, PluginActivity } from "../src/operator.js";
import { createPreviewOperator } from "../src/tui-preview-operator.js";

function fixture(state: "degraded" | "not-initialized" | "ready" | "stopped" = "ready", pluginStepDelayMs = 0) {
  const output = { write: vi.fn() };
  return {
    operator: createPreviewOperator(state, output, { pluginStepDelayMs }),
    output
  };
}

describe("Atlas Core TUI preview operator", () => {
  it.each([
    ["ready", "ready"],
    ["stopped", "stopped"],
    ["degraded", "degraded"],
    ["not-initialized", "not-initialized"]
  ] as const)("implements the Plugin operator contract in the %s state", async (state, expectedStatus) => {
    const { operator } = fixture(state);

    expect(operator).toEqual(
      expect.objectContaining({
        pluginDisable: expect.any(Function),
        pluginEnable: expect.any(Function),
        pluginLogs: expect.any(Function),
        pluginStatuses: expect.any(Function),
        resumeAfterCancellation: expect.any(Function)
      })
    );
    await expect(operator.snapshot()).resolves.toMatchObject({
      status: expectedStatus,
      ...(state === "not-initialized" ? {} : { coreVersion: "0.1.5" })
    });
    await expect(operator.details()).resolves.toMatchObject({ snapshot: { status: expectedStatus } });
    await expect(operator.pluginStatuses()).resolves.toEqual([
      {
        pluginId: "demo_plugin",
        displayName: "Demo Plugin",
        lifecycle: "query_only",
        enabled: false,
        packaged: true
      }
    ]);
  });

  it("provides deterministic in-memory Plugin status, logs, enable, disable, and refresh behavior", async () => {
    const { operator, output } = fixture();
    const activity: PluginActivity[] = [];

    await expect(operator.pluginEnable("demo_plugin", (event) => activity.push(event))).resolves.toEqual({
      status: "success"
    });
    await expect(operator.pluginStatuses()).resolves.toEqual([
      {
        pluginId: "demo_plugin",
        displayName: "Demo Plugin",
        lifecycle: "query_only",
        enabled: true,
        packaged: true,
        state: "running",
        health: "healthy"
      }
    ]);

    await operator.pluginLogs("demo_plugin", false);
    expect(output.write).toHaveBeenCalledWith(expect.stringContaining("demo-plugin fixture query ready"));
    expect(activity).toContainEqual({
      level: "success",
      message: "Demo Plugin enabled in the fixture",
      stage: "operation"
    });

    await expect(operator.pluginDisable("demo_plugin")).resolves.toEqual({ status: "success" });
    await expect(operator.pluginStatuses()).resolves.toEqual([
      {
        pluginId: "demo_plugin",
        displayName: "Demo Plugin",
        lifecycle: "query_only",
        enabled: false,
        packaged: true
      }
    ]);
  });

  it("filters fixture logs by service", async () => {
    const { operator, output } = fixture();

    await operator.logs("api", false);
    const apiLogs = output.write.mock.calls.flat().join("");
    expect(apiLogs).toContain("core-api ready");
    expect(apiLogs).not.toContain("source-gateway no connectors configured");
    expect(apiLogs).not.toContain("postgres accepting connections");
    expect(apiLogs).not.toContain("minio bucket atlas ready");

    output.write.mockClear();
    await operator.logs(undefined, false);
    const allLogs = output.write.mock.calls.flat().join("");
    expect(allLogs).toContain("core-api ready");
    expect(allLogs).toContain("source-gateway no connectors configured");
    expect(allLogs).toContain("postgres accepting connections");
    expect(allLogs).toContain("minio bucket atlas ready");
  });

  it("reports invalid fixture Plugin operations", async () => {
    const uninitialized = fixture("not-initialized").operator;
    const enableFailure = await uninitialized.pluginEnable("demo_plugin").catch((error: unknown) => error);
    expect(enableFailure).toBeInstanceOf(PluginOperationFailure);
    expect(enableFailure).toMatchObject({
      outcome: "rejected",
      operationError: { message: "Atlas Core is not initialized. Run atlas-core init first." },
      pluginId: "demo_plugin"
    });
    await expect(uninitialized.pluginLogs("demo_plugin", false)).rejects.toThrow(
      "Atlas Core is not initialized. Run atlas-core init first."
    );

    const { operator } = fixture();
    await expect(operator.pluginEnable("missing_plugin")).rejects.toThrow("Unknown first-party Plugin: missing_plugin");
    await expect(operator.pluginLogs("demo_plugin", false)).rejects.toThrow("Plugin demo_plugin is not enabled.");
    await expect(operator.pluginLogs("missing_plugin", false)).rejects.toThrow("Plugin missing_plugin is not enabled.");
  });

  it("blocks state-changing Plugin operations while degraded", async () => {
    const { operator } = fixture("degraded");

    await expect(operator.pluginEnable("demo_plugin")).rejects.toThrow(
      "Plugin changes require the current deployment to be fully healthy: minio is unhealthy."
    );
    await expect(operator.pluginStatuses()).resolves.toEqual([
      expect.objectContaining({ pluginId: "demo_plugin", enabled: false })
    ]);
    await expect(operator.pluginDisable("demo_plugin")).resolves.toEqual({ status: "success" });
  });

  it("preserves the previous Plugin state when cancelled and works again after resume", async () => {
    const { operator } = fixture("ready", 25);
    const activity: PluginActivity[] = [];
    const enable = operator.pluginEnable("demo_plugin", (event) => activity.push(event));

    operator.cancelPending();
    await expect(enable).resolves.toEqual({ previousDeploymentPreserved: true, status: "cancelled" });
    await expect(operator.pluginStatuses()).resolves.toEqual([
      expect.objectContaining({ pluginId: "demo_plugin", enabled: false })
    ]);
    expect(activity).toContainEqual({
      level: "success",
      message: "Previous fixture Plugin state restored",
      stage: "rollback"
    });

    operator.resumeAfterCancellation();
    await expect(operator.pluginEnable("demo_plugin")).resolves.toEqual({ status: "success" });
    await expect(operator.pluginStatuses()).resolves.toEqual([
      expect.objectContaining({ pluginId: "demo_plugin", enabled: true })
    ]);
  });

  it("preserves a cancellation requested before a fixture Plugin update starts", async () => {
    const { operator } = fixture("ready", 25);
    await expect(operator.pluginInstall?.("demo_plugin", "0.1.0")).resolves.toEqual({ status: "success" });

    operator.cancelPending();
    await expect(operator.pluginUpdate?.("demo_plugin")).resolves.toEqual({
      previousDeploymentPreserved: true,
      status: "cancelled"
    });
    await expect(operator.pluginStatuses()).resolves.toEqual([
      expect.objectContaining({ pluginId: "demo_plugin", selectedVersion: "0.1.0" })
    ]);
    operator.resumeAfterCancellation();
  });

  it("rejects a preview Plugin update when any reviewed detail is stale", async () => {
    const { operator } = fixture("ready");
    await operator.pluginInstall?.("demo_plugin", "0.1.0");
    const reviewedPlan = await operator.pluginUpdatePlan?.("demo_plugin");
    if (!reviewedPlan || reviewedPlan.status !== "available") throw new Error("Expected an available update plan.");

    await expect(
      operator.pluginUpdate?.("demo_plugin", undefined, { ...reviewedPlan, displayName: "Another Plugin" })
    ).rejects.toThrow("reviewed Plugin update details changed");
    await expect(operator.pluginStatuses()).resolves.toEqual([
      expect.objectContaining({ pluginId: "demo_plugin", selectedVersion: "0.1.0" })
    ]);
  });

  it.each(["start", "stop", "restart"] as const)(
    "runs the fixture %s lifecycle operation with typed progress",
    async (operation) => {
      const { operator } = fixture(operation === "start" ? "stopped" : "ready");
      const progress: LifecycleOperationProgress[] = [];

      await expect(operator.runLifecycle(operation, (event) => progress.push(event))).resolves.toMatchObject({
        status: "success"
      });
      expect(progress.map((event) => event.stage)).toEqual(["operation", "operation", "operation"]);
      await expect(operator.snapshot()).resolves.toMatchObject({ status: operation === "stop" ? "stopped" : "ready" });
    }
  );

  it("initializes a not-initialized fixture through the shared operation flow", async () => {
    const { operator } = fixture("not-initialized");
    const progress: LifecycleOperationProgress[] = [];

    await expect(operator.runLifecycle("init", (event) => progress.push(event))).resolves.toEqual({
      status: "success",
      summary: "Atlas Core initialized. Choose Start Atlas Core when ready."
    });
    expect(progress.map((event) => event.stage)).toEqual(["operation", "operation", "operation"]);
    await expect(operator.snapshot()).resolves.toMatchObject({ status: "stopped" });
  });

  it("changes the admin password through the shared operation flow without exposing private input", async () => {
    const { operator, output } = fixture();
    const progress: LifecycleOperationProgress[] = [];
    const password = "correct-horse-battery-staple";

    await expect(operator.runLifecycle("configure", (event) => progress.push(event), { password })).resolves.toEqual({
      status: "success",
      summary: "Atlas Core admin password updated for username admin."
    });
    expect(progress.map((event) => event.message).join(" ")).not.toContain(password);
    expect(output.write.mock.calls.flat().join(" ")).not.toContain(password);
  });

  it("preserves a stopped deployment while changing the admin password", async () => {
    const { operator } = fixture("stopped");
    const progress: LifecycleOperationProgress[] = [];

    await expect(
      operator.runLifecycle("configure", (event) => progress.push(event), { password: "new-password" })
    ).resolves.toMatchObject({ status: "success" });
    expect(progress.map((event) => event.stage)).toEqual(["operation", "operation", "operation"]);
    await expect(operator.snapshot()).resolves.toMatchObject({ status: "stopped" });
  });

  it("requires confirmation before resetting a fixture and resets after confirmation", async () => {
    const { operator } = fixture("ready");

    await expect(operator.runLifecycle("reset")).resolves.toMatchObject({
      status: "failure",
      error: "Reset requires explicit confirmation."
    });
    await expect(operator.runLifecycle("reset", undefined, { resetConfirmed: true })).resolves.toEqual({
      status: "success",
      summary: "Atlas Core reset is complete. A new deployment is running."
    });
    await expect(operator.snapshot()).resolves.toMatchObject({ status: "ready" });
  });

  it("preserves fixture state when initialization is cancelled", async () => {
    const { operator } = fixture("not-initialized", 25);
    const pending = operator.runLifecycle("init");
    operator.cancelPending();

    await expect(pending).resolves.toMatchObject({ status: "cancelled" });
    await expect(operator.snapshot()).resolves.toMatchObject({ status: "not-initialized" });
    operator.resumeAfterCancellation();
  });

  it("preserves fixture state through lifecycle cancellation cleanup", async () => {
    const { operator } = fixture("ready", 0);
    const progress: LifecycleOperationProgress[] = [];
    const pending = operator.runLifecycle("stop", (event) => progress.push(event));
    operator.cancelPending();

    await expect(pending).resolves.toMatchObject({ status: "cancelled" });
    expect(progress.map((event) => event.stage)).toContain("cleanup");
    await expect(operator.snapshot()).resolves.toMatchObject({ status: "ready" });
    operator.resumeAfterCancellation();
  });

  it("rejects overlapping fixture lifecycle mutations", async () => {
    const { operator } = fixture("ready");
    const first = operator.runLifecycle("stop");

    await expect(operator.runLifecycle("restart")).resolves.toMatchObject({
      status: "failure",
      error: "Another lifecycle operation is already running."
    });
    operator.cancelPending();
    await expect(first).resolves.toMatchObject({ status: "cancelled" });
    operator.resumeAfterCancellation();
  });
});
