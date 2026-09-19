import type { TaskResource } from "@the-drunken-coder/atlas-sdk";
import type { MavLinkData } from "node-mavlink";
import { describe, expect, it } from "vitest";
import type { AssetConfig } from "./config.js";
import { AssetController, flightGateOpen, shouldRequestCoreLossRecovery } from "./controller.js";
import { type CoreGateway, type FlightTelemetry } from "./core-client.js";
import type { MavLink } from "./mavlink-link.js";
import { TaskEngine } from "./task-engine.js";
import { VehicleTracker } from "./vehicle.js";

const config: AssetConfig = {
  coreUrl: "http://127.0.0.1:8080",
  apiKey: "test",
  assetId: "quad-01",
  link: { transport: "tcp", host: "127.0.0.1", port: 5760 },
  vehicleSystemId: 1,
  vehicleComponentId: 1,
  coreLossGraceSeconds: 5,
  telemetryIntervalSeconds: 1,
  arrivalRadiusM: 1.5,
  altitudeToleranceM: 1.0,
  hoverSettleSeconds: 1,
  progressTimeoutSeconds: 3600,
  taskTimeoutSeconds: 7200,
  minBatteryPercent: 20,
  shutdownConfirmSeconds: 1
};

function message(
  name: string,
  fields: Record<string, number | string>
): { constructor: { MSG_NAME: string }; [key: string]: number | string | { MSG_NAME: string } } {
  return { constructor: { MSG_NAME: name }, ...fields };
}

describe("recovery decisions", () => {
  it("withholds flight work after restart until landed and disarmed", () => {
    expect(flightGateOpen({ initiallyLandedAndDisarmed: false, armed: true })).toBe(false);
    expect(flightGateOpen({ initiallyLandedAndDisarmed: false, armed: false, relativeAltitudeM: 12 })).toBe(false);
    expect(flightGateOpen({ initiallyLandedAndDisarmed: false, armed: false, relativeAltitudeM: 0 })).toBe(true);
    expect(flightGateOpen({ initiallyLandedAndDisarmed: true, armed: true, relativeAltitudeM: 12 })).toBe(true);
  });

  it("requests Core-loss RTL while Guided, including idle hold", () => {
    const base = { downMs: 6000, graceMs: 5000, guided: true, recoveryRunning: false } as const;
    expect(shouldRequestCoreLossRecovery({ ...base, activeCommand: "flight.takeoff" })).toBe(true);
    expect(shouldRequestCoreLossRecovery({ ...base, activeCommand: "flight.goto" })).toBe(true);
    expect(shouldRequestCoreLossRecovery({ ...base, activeCommand: undefined })).toBe(true);
    // An ongoing landing or RTL is preserved, never interrupted.
    expect(shouldRequestCoreLossRecovery({ ...base, activeCommand: "flight.land" })).toBe(false);
    expect(shouldRequestCoreLossRecovery({ ...base, activeCommand: "flight.return_to_launch" })).toBe(false);
    // Never overrides manual flight or repeats recovery.
    expect(shouldRequestCoreLossRecovery({ ...base, activeCommand: "flight.goto", guided: false })).toBe(false);
    expect(shouldRequestCoreLossRecovery({ ...base, activeCommand: "flight.goto", recoveryRunning: true })).toBe(false);
    // Grace period first.
    expect(shouldRequestCoreLossRecovery({ ...base, downMs: 1000, activeCommand: "flight.goto" })).toBe(false);
  });
});

describe("AssetController Core-loss recovery", () => {
  it("requests RTL after the grace period and never resumes the interrupted action", async () => {
    let now = 1_000_000;
    const sent: MavLinkData[] = [];
    const failed: { taskId: string; code: string; message: string }[] = [];
    const started: string[] = [];
    let coreDown = false;
    let readyCalls = 0;
    const tasks: TaskResource[] = [];

    const core: CoreGateway = {
      begin: async () => {},
      ready: async () => {
        readyCalls++;
      },
      fetchTasks: async () => {
        if (coreDown) throw new Error("connection refused");
        return tasks.filter((task) => task.status === "pending");
      },
      getTask: async (taskId) => {
        const task = tasks.find((candidate) => candidate.task_id === taskId);
        if (task === undefined) throw new Error(`task ${taskId} not found`);
        return task;
      },
      reportStart: async (taskId) => {
        started.push(taskId);
      },
      reportProgress: async () => {},
      reportComplete: async () => {},
      reportFail: async (taskId, code, message) => {
        failed.push({ taskId, code, message });
      },
      checkin: async (_telemetry: FlightTelemetry) => {
        if (coreDown) throw new Error("connection refused");
      }
    };

    let handler: ((message: never) => void) | undefined;
    const link = {
      sent,
      describe: () => "fake",
      send: async (message: MavLinkData) => {
        sent.push(message);
      },
      close: async () => {},
      onMessage: (callback: (message: never) => void) => {
        handler = callback;
        return () => {};
      }
    } as unknown as MavLink;

    const tracker = new VehicleTracker();
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
    const logs: string[] = [];
    const controller = new AssetController(config, {
      openLink: async () => link,
      core,
      engine,
      tracker,
      log: (_level, message) => {
        logs.push(message);
      },
      sleep: async (ms) => {
        now += ms;
        // Pace the loop in real time so fed vehicle state stays fresh.
        await new Promise((resolve) => setTimeout(resolve, 1));
      },
      now: () => now
    });

    const run = controller.start();
    // Wait for the link handler before feeding vehicle state.
    {
      const deadline = Date.now() + 15_000;
      while (handler === undefined) {
        if (Date.now() > deadline) throw new Error("timed out waiting for link open");
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
    const feed = (name: string, fields: Record<string, number | string>) => {
      if (handler === undefined) throw new Error("link handler not installed");
      handler({ sysid: 1, compid: 1, msgid: 0, message: message(name, fields) } as never);
    };
    const heartbeat = (armed: boolean, mode: number) =>
      feed("HEARTBEAT", {
        customMode: mode,
        baseMode: armed ? 128 : 0,
        autopilot: 3,
        type: 2
      });
    const position = (altMsl: number, relAlt: number) =>
      feed("GLOBAL_POSITION_INT", {
        lat: 377_749_000,
        lon: -1_224_194_000,
        alt: Math.round(altMsl * 1000),
        relativeAlt: Math.round(relAlt * 1000),
        vx: 0,
        vy: 0,
        vz: 0,
        hdg: 9000
      });

    async function waitFor(condition: () => boolean, what: string, armed: boolean): Promise<void> {
      const deadline = Date.now() + 15_000;
      while (!condition()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        // Feed fresh vehicle state so readiness and preconditions hold.
        heartbeat(armed, 4);
        position(560, 0);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }

    // Verify the vehicle: failsafe known, launch elevation stabilizes while
    // landed and disarmed (the restart barrier).
    feed("PARAM_VALUE", { paramId: "FS_GCS_ENABLE", paramValue: 1 });
    feed("SYS_STATUS", { batteryRemaining: 95 });
    await waitFor(() => readyCalls > 0, "runtime readiness", false);

    // A takeoff starts under Atlas control.
    tasks.push({
      task_id: "task-takeoff",
      asset_id: "quad-01",
      command: "flight.takeoff",
      input: { altitude_m: 570 },
      status: "pending",
      created_at: new Date(now).toISOString(),
      updated_at: new Date(now).toISOString()
    } as unknown as TaskResource);
    await waitFor(() => started.includes("task-takeoff"), "takeoff start", true);
    const takeoffSends = sent.length;
    expect(takeoffSends).toBeGreaterThan(0);

    // Core is lost: new starts stop and the grace period runs.
    coreDown = true;
    const rtlCount = () =>
      sent.filter((item) => (item.constructor as { MSG_NAME?: string }).MSG_NAME === "COMMAND_LONG").length;
    const before = rtlCount();
    const rtlWait = (async () => {
      const deadline = Date.now() + 15_000;
      while (!(rtlCount() > before)) {
        if (Date.now() > deadline) throw new Error("timed out waiting for Core-loss RTL");
        heartbeat(true, 4);
        position(560, 8);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    })();
    await rtlWait;
    // Recovery sends RTL exactly once no matter how long the outage lasts.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(rtlCount()).toBe(before + 1);

    // Core returns with the interrupted takeoff still open: it is failed, and
    // the action is never resumed even though Guided control continues.
    coreDown = false;
    tasks.length = 0;
    tasks.push({
      task_id: "task-takeoff",
      asset_id: "quad-01",
      command: "flight.takeoff",
      input: { altitude_m: 570 },
      status: "in_progress",
      created_at: new Date(now).toISOString(),
      updated_at: new Date(now).toISOString()
    } as unknown as TaskResource);
    await waitFor(() => failed.some((entry) => entry.taskId === "task-takeoff"), "interrupted task failure", true);
    const failure = failed.find((entry) => entry.taskId === "task-takeoff");
    expect(failure?.message).toMatch(/not resumed/);
    // No new flight commands after reconnect: heartbeats continue, but the
    // interrupted takeoff is never dispatched again.
    const commandsAfterReconnect = rtlCount();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(rtlCount()).toBe(commandsAfterReconnect);

    // Park the vehicle as RTL so shutdown preserves recovery instead of
    // requesting a new maneuver.
    heartbeat(true, 6);
    await controller.shutdown();
    await run;
    expect(logs.some((entry) => entry.includes("Core-loss"))).toBe(true);
  }, 60_000);
});
