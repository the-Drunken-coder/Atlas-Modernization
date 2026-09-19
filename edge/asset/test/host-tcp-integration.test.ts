import type { TaskResource } from "@the-drunken-coder/atlas-sdk";
import { describe, expect, it } from "vitest";
import type { AssetConfig } from "../src/config.js";
import { AssetController } from "../src/controller.js";
import { type CoreGateway, type FlightTelemetry } from "../src/core-client.js";
import { openTcpLink } from "../src/mavlink-link.js";
import { TaskEngine } from "../src/task-engine.js";
import { VehicleTracker } from "../src/vehicle.js";
import { FakeArduCopter } from "./fake-arducopter.js";

function taskResource(taskId: string, command: string, input: Record<string, unknown>): TaskResource {
  const now = new Date().toISOString();
  return {
    task_id: taskId,
    asset_id: "quad-01",
    command,
    input,
    status: "pending",
    created_at: now,
    updated_at: now
  } as unknown as TaskResource;
}

async function waitFor(condition: () => boolean, what: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe("host to aircraft over TCP MAVLink", () => {
  it("flies takeoff, go-to replacement, and land through real MAVLink bytes", async () => {
    const vehicle = new FakeArduCopter();
    const port = await vehicle.listen();

    const config: AssetConfig = {
      coreUrl: "http://127.0.0.1:8080",
      apiKey: "test",
      assetId: "quad-01",
      link: { transport: "tcp", host: "127.0.0.1", port },
      vehicleSystemId: 1,
      vehicleComponentId: 1,
      coreLossGraceSeconds: 5,
      telemetryIntervalSeconds: 1,
      arrivalRadiusM: 2,
      altitudeToleranceM: 1,
      hoverSettleSeconds: 1,
      progressTimeoutSeconds: 120,
      taskTimeoutSeconds: 300,
      minBatteryPercent: 20,
      shutdownConfirmSeconds: 1
    };

    const tasks = new Map<string, TaskResource>();
    const started: string[] = [];
    const completed: string[] = [];
    const failed: string[] = [];
    const checkinAltitudes: number[] = [];
    const core: CoreGateway = {
      begin: async () => {},
      ready: async () => {},
      fetchTasks: async () => [...tasks.values()].filter((task) => task.status === "pending"),
      getTask: async (taskId) => {
        const task = tasks.get(taskId);
        if (task === undefined) throw new Error(`task ${taskId} not found`);
        return task;
      },
      reportStart: async (taskId) => {
        started.push(taskId);
        const task = tasks.get(taskId);
        if (task !== undefined) tasks.set(taskId, { ...task, status: "in_progress" } as unknown as TaskResource);
      },
      reportProgress: async () => {},
      reportComplete: async (taskId) => {
        completed.push(taskId);
        const task = tasks.get(taskId);
        if (task !== undefined) tasks.set(taskId, { ...task, status: "completed" } as unknown as TaskResource);
      },
      reportFail: async (taskId) => {
        failed.push(taskId);
      },
      checkin: async (telemetry: FlightTelemetry) => {
        if (telemetry.position !== undefined) checkinAltitudes.push(telemetry.position.altitudeMslM);
      }
    };

    const tracker = new VehicleTracker();
    const link = await openTcpLink("127.0.0.1", port, 255, 190);
    const engine = new TaskEngine(
      { send: async (message) => link.send(message) },
      {
        reportStart: (taskId) => core.reportStart(taskId),
        reportProgress: (taskId, progress) => core.reportProgress(taskId, progress),
        reportComplete: (taskId) => core.reportComplete(taskId),
        reportFail: (taskId, code, message) => core.reportFail(taskId, code, message)
      },
      config
    );
    const controller = new AssetController(config, {
      openLink: async () => link,
      core,
      engine,
      tracker,
      log: () => {}
    });

    const run = controller.start();
    try {
      await waitFor(() => controller.isReady(), "runtime readiness");
      // RC arming is separate from Atlas tasking.
      vehicle.arm();

      // Takeoff to 5m above launch through real command bytes.
      tasks.set("task-takeoff", taskResource("task-takeoff", "flight.takeoff", { altitude_m: 565 }));
      await waitFor(() => completed.includes("task-takeoff"), "takeoff completion");
      expect(vehicle.state.altitudeMslM).toBeCloseTo(565, 0);
      expect(Math.max(...checkinAltitudes)).toBeGreaterThan(563);

      // Go-to replacement: the first destination is superseded by the second.
      const home = { latitudeDeg: 37.7749, longitudeDeg: -122.4194 };
      tasks.set(
        "task-goto-1",
        taskResource("task-goto-1", "flight.goto", {
          latitude: home.latitudeDeg + 0.0003,
          longitude: home.longitudeDeg,
          altitude_m: 565
        })
      );
      await waitFor(() => started.includes("task-goto-1"), "first go-to start");
      const first = tasks.get("task-goto-1");
      if (first !== undefined) {
        tasks.set("task-goto-1", {
          ...first,
          status: "cancelled",
          cancellation: { code: "superseded", message: "replaced" }
        } as unknown as TaskResource);
      }
      tasks.set(
        "task-goto-2",
        taskResource("task-goto-2", "flight.goto", {
          latitude: home.latitudeDeg,
          longitude: home.longitudeDeg,
          altitude_m: 565
        })
      );
      await waitFor(() => completed.includes("task-goto-2"), "replacement go-to completion");
      expect(completed).not.toContain("task-goto-1");
      expect(vehicle.state.latitudeDeg).toBeCloseTo(home.latitudeDeg, 4);

      // Land at the current location and disarm.
      tasks.set("task-land", taskResource("task-land", "flight.land", {}));
      await waitFor(() => completed.includes("task-land"), "land completion");
      expect(vehicle.state.armed).toBe(false);
      expect(failed).toEqual([]);
    } finally {
      await controller.shutdown();
      await run;
      await link.close();
      await vehicle.close();
    }
  }, 120_000);
});
