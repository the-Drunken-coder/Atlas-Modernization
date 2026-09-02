import { describe, expect, it, vi } from "vitest";
import type { PluginActivity } from "../src/terminal-ui.js";
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
    await expect(operator.snapshot()).resolves.toMatchObject({ status: expectedStatus });
    await expect(operator.pluginStatuses()).resolves.toEqual([
      {
        pluginId: "building_scan",
        displayName: "Building Scan",
        lifecycle: "query_only",
        enabled: false,
        packaged: true
      }
    ]);
  });

  it("provides deterministic in-memory Plugin status, logs, enable, disable, and refresh behavior", async () => {
    const { operator, output } = fixture();
    const activity: PluginActivity[] = [];

    await expect(operator.pluginEnable("building_scan", (event) => activity.push(event))).resolves.toEqual({
      status: "success"
    });
    await expect(operator.pluginStatuses()).resolves.toEqual([
      {
        pluginId: "building_scan",
        displayName: "Building Scan",
        lifecycle: "query_only",
        enabled: true,
        packaged: true,
        state: "running",
        health: "healthy"
      }
    ]);

    await operator.pluginLogs("building_scan", false);
    expect(output.write).toHaveBeenCalledWith(expect.stringContaining("building-scan-plugin fixture query ready"));
    expect(activity).toContainEqual({
      level: "success",
      message: "Building Scan enabled in the fixture",
      stage: "operation"
    });

    await expect(operator.pluginDisable("building_scan")).resolves.toEqual({ status: "success" });
    await expect(operator.pluginStatuses()).resolves.toEqual([
      {
        pluginId: "building_scan",
        displayName: "Building Scan",
        lifecycle: "query_only",
        enabled: false,
        packaged: true
      }
    ]);
  });

  it("reports invalid fixture Plugin operations", async () => {
    const uninitialized = fixture("not-initialized").operator;
    await expect(uninitialized.pluginEnable("building_scan")).rejects.toThrow(
      "Atlas Core is not initialized. Run atlas-core init first."
    );
    await expect(uninitialized.pluginLogs("building_scan", false)).rejects.toThrow(
      "Atlas Core is not initialized. Run atlas-core init first."
    );

    const { operator } = fixture();
    await expect(operator.pluginEnable("missing_plugin")).rejects.toThrow("Unknown first-party Plugin: missing_plugin");
    await expect(operator.pluginLogs("building_scan", false)).rejects.toThrow("Plugin building_scan is not enabled.");
    await expect(operator.pluginLogs("missing_plugin", false)).rejects.toThrow("Plugin missing_plugin is not enabled.");
  });

  it("blocks state-changing Plugin operations while degraded", async () => {
    const { operator } = fixture("degraded");

    await expect(operator.pluginEnable("building_scan")).rejects.toThrow(
      "Plugin changes require the current deployment to be fully healthy: minio is unhealthy."
    );
    await expect(operator.pluginStatuses()).resolves.toEqual([
      expect.objectContaining({ pluginId: "building_scan", enabled: false })
    ]);
    await expect(operator.pluginDisable("building_scan")).resolves.toEqual({ status: "success" });
  });

  it("preserves the previous Plugin state when cancelled and works again after resume", async () => {
    const { operator } = fixture("ready", 25);
    const activity: PluginActivity[] = [];
    const enable = operator.pluginEnable("building_scan", (event) => activity.push(event));

    operator.cancelPending();
    await expect(enable).resolves.toEqual({ previousDeploymentPreserved: true, status: "cancelled" });
    await expect(operator.pluginStatuses()).resolves.toEqual([
      expect.objectContaining({ pluginId: "building_scan", enabled: false })
    ]);
    expect(activity).toContainEqual({
      level: "success",
      message: "Previous fixture Plugin state restored",
      stage: "rollback"
    });

    operator.resumeAfterCancellation();
    await expect(operator.pluginEnable("building_scan")).resolves.toEqual({ status: "success" });
    await expect(operator.pluginStatuses()).resolves.toEqual([
      expect.objectContaining({ pluginId: "building_scan", enabled: true })
    ]);
  });
});
