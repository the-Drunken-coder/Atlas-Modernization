import type { TaskResource } from "@the-drunken-coder/atlas-sdk";
import { ardupilotmega, common, type MavLinkData } from "node-mavlink";
import { describe, expect, it, onTestFinished } from "vitest";
import type { AssetConfig } from "./config.js";
import {
  AssetController,
  flightGateOpen,
  flightTelemetryForCheckin,
  isConfiguredVehicleMessage,
  shouldRequestCoreLossRecovery
} from "./controller.js";
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
    expect(flightGateOpen({ initiallyLandedAndDisarmed: false, armed: false })).toBe(false);
    expect(flightGateOpen({ initiallyLandedAndDisarmed: false, armed: false, relativeAltitudeM: 0 })).toBe(true);
    expect(flightGateOpen({ initiallyLandedAndDisarmed: true, armed: true, relativeAltitudeM: 12 })).toBe(true);
  });

  it("requests Core-loss RTL while Guided, including idle hold", () => {
    const base = {
      downMs: 6000,
      graceMs: 5000,
      guided: true,
      recoveryRunning: false,
      telemetryFresh: true
    } as const;
    expect(shouldRequestCoreLossRecovery({ ...base, activeCommand: "flight.takeoff" })).toBe(true);
    expect(shouldRequestCoreLossRecovery({ ...base, activeCommand: "flight.goto" })).toBe(true);
    expect(shouldRequestCoreLossRecovery({ ...base, activeCommand: undefined })).toBe(true);
    // An ongoing landing or RTL is preserved, never interrupted.
    expect(shouldRequestCoreLossRecovery({ ...base, activeCommand: "flight.land" })).toBe(false);
    expect(shouldRequestCoreLossRecovery({ ...base, activeCommand: "flight.return_to_launch" })).toBe(false);
    // Never overrides manual flight or repeats recovery.
    expect(shouldRequestCoreLossRecovery({ ...base, activeCommand: "flight.goto", guided: false })).toBe(false);
    expect(shouldRequestCoreLossRecovery({ ...base, activeCommand: "flight.goto", recoveryRunning: true })).toBe(false);
    expect(shouldRequestCoreLossRecovery({ ...base, activeCommand: "flight.goto", telemetryFresh: false })).toBe(false);
    // Grace period first.
    expect(shouldRequestCoreLossRecovery({ ...base, downMs: 1000, activeCommand: "flight.goto" })).toBe(false);
  });

  it("ignores MAVLink messages from every source except the configured vehicle", () => {
    expect(isConfiguredVehicleMessage(config, { sysid: 1, compid: 1 })).toBe(true);
    expect(isConfiguredVehicleMessage(config, { sysid: 2, compid: 1 })).toBe(false);
    expect(isConfiguredVehicleMessage(config, { sysid: 1, compid: 2 })).toBe(false);
  });

  it("publishes battery with fresh control telemetry and withholds stale aircraft state", () => {
    const tracker = new VehicleTracker();
    tracker.observeHeartbeat({
      systemId: 1,
      componentId: 1,
      vehicleType: 2,
      autopilot: 3,
      baseMode: 128,
      customMode: 4,
      receivedAtMs: 10_000
    });
    tracker.observePosition({
      latitudeDeg: 42.274,
      longitudeDeg: -71.806,
      altitudeMslM: 152,
      relativeAltitudeM: 12,
      groundSpeedMS: 3,
      headingDeg: 90,
      observedAtMs: 10_000
    });
    tracker.observeSysStatus(74);

    expect(flightTelemetryForCheckin(tracker.getSnapshot(), 10_500)).toMatchObject({
      batteryRemainingPercent: 74,
      position: { latitude: 42.274, longitude: -71.806 }
    });
    expect(flightTelemetryForCheckin(tracker.getSnapshot(), 13_001)).toBeUndefined();
  });
});

describe("AssetController Core-loss recovery", () => {
  it("surfaces a retained link failure during startup and closes the link once", async () => {
    const linkFailure = new Error("MAVLink TCP stream failed: connection reset");
    let linkStatus: ReturnType<MavLink["status"]> = { state: "open" };
    let closeCalls = 0;
    const link = {
      describe: () => "fake",
      status: () => linkStatus,
      send: async () => {
        linkStatus = { state: "failed", error: linkFailure };
      },
      close: async () => {
        closeCalls++;
        linkStatus = { state: "closed" };
      },
      onMessage: () => () => {}
    } as unknown as MavLink;
    const tracker = new VehicleTracker();
    const core: CoreGateway = {
      begin: async () => {},
      ready: async () => {},
      fetchTasks: async () => [],
      getTask: async () => {
        throw new Error("unexpected Task read");
      },
      reportStart: async () => {},
      reportProgress: async () => {},
      reportComplete: async () => {},
      reportFail: async () => {},
      checkin: async () => {}
    };
    const engine = new TaskEngine({ send: (item) => link.send(item) }, core, config, () => ({
      snapshot: tracker.getSnapshot(),
      nowMs: Date.now()
    }));
    const controller = new AssetController(config, {
      openLink: async () => link,
      core,
      engine,
      tracker
    });

    await expect(controller.start()).rejects.toBe(linkFailure);
    await Promise.all([controller.shutdown(), controller.shutdown()]);
    expect(closeCalls).toBe(1);
  });

  it.each(["ack", "mode", "reconnect", "LOITER", "SMART_RTL", "BRAKE"] as const)(
    "reconciles Core-loss RTL after %s without resuming interrupted work",
    async (confirmation) => {
      let now = 1_000_000;
      const sent: MavLinkData[] = [];
      const failed: { taskId: string; code: string; message: string }[] = [];
      const started: string[] = [];
      let coreDown = false;
      let activeRefreshDown = false;
      let activeRefreshAttempts = 0;
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
          activeRefreshAttempts++;
          if (activeRefreshDown) throw new Error("active Task read failed");
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
        status: () => ({ state: "open" }),
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
        config,
        () => ({ snapshot: tracker.getSnapshot(), nowMs: now })
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
      onTestFinished(async () => {
        await controller.shutdown();
        await run;
      });
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

      async function waitFor(
        condition: () => boolean,
        what: string,
        armed: boolean,
        mode = 4,
        relativeAltitudeM = 0
      ): Promise<void> {
        const deadline = Date.now() + 15_000;
        while (!condition()) {
          if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
          // Feed fresh vehicle state so readiness and preconditions hold.
          heartbeat(armed, mode);
          position(560 + relativeAltitudeM, relativeAltitudeM);
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      }

      // Verify the vehicle: failsafe known, launch elevation stabilizes while
      // landed and disarmed (the restart barrier).
      feed("PARAM_VALUE", { paramId: "FS_GCS_ENABLE", paramValue: 1 });
      feed("SYS_STATUS", { batteryRemaining: 95 });
      await waitFor(() => readyCalls > 0, "runtime readiness", false);

      // A takeoff starts under Atlas control.
      const takeoff = {
        task_id: "task-takeoff",
        asset_id: "quad-01",
        command: "flight.takeoff",
        input: { altitude_m: 570 },
        status: "pending",
        created_at: new Date(now).toISOString(),
        updated_at: new Date(now).toISOString()
      } satisfies TaskResource;
      tasks.push(takeoff);
      await waitFor(() => started.includes("task-takeoff"), "takeoff start", true);
      const takeoffSends = sent.length;
      expect(takeoffSends).toBeGreaterThan(0);

      // Core is lost: new starts stop and the grace period runs.
      coreDown = true;
      const rtlCount = () =>
        sent.filter((item) => item instanceof common.CommandLong && item.command === common.MavCmd.NAV_RETURN_TO_LAUNCH)
          .length;
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
      // A write or denial does not prove recovery. Unrelated acknowledgements
      // and another aircraft's acknowledgement cannot suppress retries either.
      feed("COMMAND_ACK", { command: common.MavCmd.NAV_RETURN_TO_LAUNCH, result: common.MavResult.DENIED });
      await waitFor(() => rtlCount() >= before + 2, "RTL retry after denial", true, 4, 8);
      feed("COMMAND_ACK", { command: common.MavCmd.NAV_LAND, result: common.MavResult.ACCEPTED });
      handler?.({
        sysid: 2,
        compid: 1,
        msgid: 77,
        message: message("COMMAND_ACK", {
          command: common.MavCmd.NAV_RETURN_TO_LAUNCH,
          result: common.MavResult.ACCEPTED
        })
      } as never);
      await waitFor(() => rtlCount() >= before + 3, "RTL retry without matching confirmation", true, 4, 8);
      const confirmedCount = rtlCount();
      if (confirmation === "reconnect") {
        for (const stale of [false, true]) {
          const beforeUncertainMode = rtlCount();
          const uncertainAt = now;
          while (now < uncertainAt + 4000) {
            tracker.observeHeartbeat({
              systemId: 1,
              componentId: 1,
              vehicleType: 2,
              autopilot: 3,
              baseMode: 128,
              customMode: stale ? ardupilotmega.CopterMode.LOITER : 999,
              receivedAtMs: stale ? now - 4000 : now
            });
            position(568, 8);
            await new Promise((resolve) => setTimeout(resolve, 1));
          }
          expect(rtlCount()).toBe(beforeUncertainMode);
          await waitFor(() => rtlCount() > beforeUncertainMode, "RTL retry after uncertain mode telemetry", true, 4, 8);
        }
      }
      if (confirmation === "LOITER" || confirmation === "SMART_RTL" || confirmation === "BRAKE") {
        const mode = ardupilotmega.CopterMode[confirmation];
        const flightCommands = () =>
          sent.filter(
            (item) => item instanceof common.CommandLong || item instanceof common.SetPositionTargetGlobalInt
          );
        heartbeat(true, mode);
        position(568, 8);
        const beforeTakeover = flightCommands();
        const takeoverAt = now;
        await waitFor(() => now >= takeoverAt + 6000, "takeover without RTL acknowledgement", true, mode, 8);
        expect(flightCommands()).toEqual(beforeTakeover);

        tasks.splice(0, tasks.length, {
          ...takeoff,
          status: "in_progress",
          acknowledged_at: new Date(now).toISOString(),
          started_at: new Date(now).toISOString()
        });
        coreDown = false;
        await waitFor(() => !controller.isCoreDown(), "Core reconnect in manual mode", true, mode, 8);
        tasks.push({ ...takeoff, task_id: "task-after-takeover" });
        const reconnectedAt = now;
        await waitFor(() => now >= reconnectedAt + 3000, "new task handling in manual mode", true, mode, 8);
        expect(failed).toContainEqual({
          taskId: "task-after-takeover",
          code: "precondition_failed",
          message: expect.stringContaining("Requires Guided")
        });
        expect(started).toEqual(["task-takeoff"]);
        expect(flightCommands()).toEqual(beforeTakeover);

        // Fresh Guided control holds the pilot's position, both on the ground
        // and in flight. It must never revive the old Core-loss RTL request.
        const armed = confirmation !== "LOITER";
        const guidedAt = now;
        await waitFor(() => now >= guidedAt + 3000, "Guided return after takeover", armed, 4, armed ? 8 : 0);
        const afterReturn = flightCommands().slice(beforeTakeover.length);
        expect(afterReturn).toHaveLength(1);
        expect(afterReturn[0]).toBeInstanceOf(common.SetPositionTargetGlobalInt);
        expect(afterReturn[0]).toMatchObject({ latInt: 377_749_000, lonInt: -1_224_194_000, alt: armed ? 568 : 560 });
        expect(rtlCount()).toBe(confirmedCount);
        expect(failed.filter((entry) => entry.taskId === "task-takeoff")).toHaveLength(1);
        return;
      }
      if (confirmation === "ack") {
        feed("COMMAND_ACK", { command: common.MavCmd.NAV_RETURN_TO_LAUNCH, result: common.MavResult.ACCEPTED });
      } else if (confirmation === "mode") {
        heartbeat(true, 6);
      }
      if (confirmation !== "reconnect") {
        const confirmedAt = now;
        await waitFor(() => now >= confirmedAt + 6000, "confirmed recovery", true, confirmation === "mode" ? 6 : 4, 8);
        expect(rtlCount()).toBe(confirmedCount);
      }

      // Core returns with the interrupted takeoff still open: it is failed, and
      // the action is never resumed even though Guided control continues.
      const refreshAttemptsBeforeRecovery = activeRefreshAttempts;
      activeRefreshDown = true;
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
      const refreshDeadline = Date.now() + 15_000;
      while (activeRefreshAttempts === refreshAttemptsBeforeRecovery || !controller.isCoreDown()) {
        if (Date.now() > refreshDeadline) throw new Error("timed out waiting for failed active Task refresh");
        heartbeat(true, 4);
        position(560, 8);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(controller.isCoreDown()).toBe(true);
      expect(failed).toEqual([]);

      activeRefreshDown = false;
      await waitFor(() => failed.some((entry) => entry.taskId === "task-takeoff"), "interrupted task failure", true);
      const failure = failed.find((entry) => entry.taskId === "task-takeoff");
      expect(failure?.message).toMatch(/not resumed/);
      if (confirmation === "reconnect") {
        const afterReconnect = rtlCount();
        await waitFor(() => rtlCount() > afterReconnect, "RTL retry after Core reconnects", true, 4, 8);
        feed("COMMAND_ACK", { command: common.MavCmd.NAV_RETURN_TO_LAUNCH, result: common.MavResult.ACCEPTED });
      }
      // No new flight commands after reconnect: heartbeats continue, but the
      // interrupted takeoff is never dispatched again.
      const commandsAfterReconnect = rtlCount();
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(rtlCount()).toBe(commandsAfterReconnect);

      // A just-dispatched Land must survive shutdown even before its native
      // mode heartbeat arrives.
      heartbeat(true, 4);
      position(568, 8);
      tasks.length = 0;
      tasks.push({
        task_id: "task-land",
        asset_id: "quad-01",
        command: "flight.land",
        input: {},
        status: "pending",
        created_at: new Date(now).toISOString(),
        updated_at: new Date(now).toISOString()
      } as unknown as TaskResource);
      await waitFor(() => engine.activeCommand() === "flight.land", "landing dispatch", true, 4, 8);
      const beforeShutdown = rtlCount();
      await controller.shutdown();
      await run;
      expect(rtlCount()).toBe(beforeShutdown);
      expect(logs.some((entry) => entry.includes("Core-loss"))).toBe(true);
    },
    60_000
  );
});
