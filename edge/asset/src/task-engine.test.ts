import type { MavLinkData } from "node-mavlink";
import { describe, expect, it } from "vitest";
import type { AssetConfig } from "./config.js";
import {
  type AuthoritativeTask,
  type CommandSender,
  type EngineCallbacks,
  type FailureCode,
  TaskEngine
} from "./task-engine.js";
import { emptySnapshot, type VehicleSnapshot } from "./vehicle.js";

const config = {
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
  hoverSettleSeconds: 3,
  progressTimeoutSeconds: 30,
  taskTimeoutSeconds: 300,
  minBatteryPercent: 20,
  shutdownConfirmSeconds: 5
} satisfies AssetConfig;

type Report =
  | { type: "start"; taskId: string }
  | { type: "progress"; taskId: string; progress: number }
  | { type: "complete"; taskId: string }
  | { type: "fail"; taskId: string; code: FailureCode; message: string };

function guidedSnapshot(overrides: Partial<VehicleSnapshot> = {}): VehicleSnapshot {
  return {
    ...emptySnapshot(),
    armed: true,
    mode: "GUIDED",
    customMode: 4,
    guided: true,
    identity: { systemId: 1, componentId: 1, vehicleType: 2, autopilot: 3 },
    launchElevationM: 560,
    launchLatitudeDeg: 37.7749,
    launchLongitudeDeg: -122.4194,
    launchElevationVerified: true,
    observation: {
      latitudeDeg: 37.7749,
      longitudeDeg: -122.4194,
      altitudeMslM: 560,
      relativeAltitudeM: 0,
      groundSpeedMS: 0,
      headingDeg: 90,
      observedAtMs: 1_000_000
    },
    lastHeartbeatMs: 1_000_000,
    ...overrides
  };
}

function setup(
  overrides: {
    send?: CommandSender["send"];
    reportStart?: EngineCallbacks["reportStart"];
    reportComplete?: EngineCallbacks["reportComplete"];
    reportFail?: EngineCallbacks["reportFail"];
  } = {}
) {
  const sent: MavLinkData[] = [];
  const reports: Report[] = [];
  let controlState = { snapshot: guidedSnapshot(), nowMs: 1_000_000 };
  const sender: CommandSender = {
    send:
      overrides.send ??
      (async (message) => {
        sent.push(message);
      })
  };
  const callbacks: EngineCallbacks = {
    reportStart:
      overrides.reportStart ??
      (async (taskId) => {
        reports.push({ type: "start", taskId });
      }),
    reportProgress: async (taskId, progress) => {
      reports.push({ type: "progress", taskId, progress });
    },
    reportComplete:
      overrides.reportComplete ??
      (async (taskId) => {
        reports.push({ type: "complete", taskId });
      }),
    reportFail:
      overrides.reportFail ??
      (async (taskId, code, message) => {
        reports.push({ type: "fail", taskId, code, message });
      })
  };
  return {
    engine: new TaskEngine(sender, callbacks, config, () => controlState),
    sent,
    reports,
    setControlState(snapshot: VehicleSnapshot, nowMs: number) {
      controlState = { snapshot, nowMs };
    }
  };
}

function task(taskId: string, command: string, input: Record<string, unknown>): AuthoritativeTask {
  return { taskId, command, status: "pending", input };
}

describe("TaskEngine", () => {
  it("completes takeoff after reaching altitude and settling into hover", async () => {
    const { engine, sent, reports } = setup();
    const target = task("task-1", "flight.takeoff", { altitude_m: 570 });
    await engine.ingest([target], guidedSnapshot(), 1_000_000);
    expect(sent).toHaveLength(1);
    expect((sent[0] as { _param7?: number })._param7).toBeCloseTo(10, 5);
    expect(reports).toEqual([{ type: "start", taskId: "task-1" }]);

    // Climbing: no completion yet.
    await engine.ingest(
      [{ ...target, status: "in_progress" }],
      guidedSnapshot({
        lastHeartbeatMs: 1_005_000,
        observation: {
          latitudeDeg: 37.7749,
          longitudeDeg: -122.4194,
          altitudeMslM: 565,
          relativeAltitudeM: 5,
          groundSpeedMS: 1,
          headingDeg: 90,
          observedAtMs: 1_005_000
        }
      }),
      1_005_000
    );
    expect(reports.filter((report) => report.type === "complete")).toHaveLength(0);

    // Reaching altitude while still moving is not a settled hover.
    const atAltitude = guidedSnapshot({
      lastHeartbeatMs: 1_010_000,
      observation: {
        latitudeDeg: 37.7749,
        longitudeDeg: -122.4194,
        altitudeMslM: 570,
        relativeAltitudeM: 10,
        groundSpeedMS: 1,
        headingDeg: 90,
        observedAtMs: 1_010_000
      }
    });
    await engine.ingest([{ ...target, status: "in_progress" }], atAltitude, 1_010_000);
    expect(reports.filter((report) => report.type === "complete")).toHaveLength(0);

    const hovering = {
      ...atAltitude,
      observation: { ...atAltitude.observation!, groundSpeedMS: 0.1 }
    };
    await engine.ingest([{ ...target, status: "in_progress" }], hovering, 1_010_000);
    await engine.ingest(
      [{ ...target, status: "in_progress" }],
      {
        ...hovering,
        lastHeartbeatMs: 1_014_000,
        observation: { ...hovering.observation!, observedAtMs: 1_014_000 }
      },
      1_014_000
    );
    expect(reports).toContainEqual({ type: "complete", taskId: "task-1" });
  });

  it("rejects takeoff for a disarmed aircraft instead of arming", async () => {
    const { engine, sent, reports } = setup();
    await engine.ingest(
      [task("task-1", "flight.takeoff", { altitude_m: 570 })],
      guidedSnapshot({ armed: false }),
      1_000_000
    );
    expect(sent).toHaveLength(0);
    expect(reports).toEqual([
      { type: "fail", taskId: "task-1", code: "precondition_failed", message: expect.stringContaining("armed") }
    ]);
  });

  it("rejects flight actions outside Guided rather than saving them", async () => {
    const { engine, sent, reports } = setup();
    await engine.ingest(
      [task("task-1", "flight.goto", { latitude: 37.78, longitude: -122.41, altitude_m: 590 })],
      guidedSnapshot({ mode: "LOITER", customMode: 5, guided: false }),
      1_000_000
    );
    expect(sent).toHaveLength(0);
    expect(reports[0]).toMatchObject({ type: "fail", taskId: "task-1", code: "precondition_failed" });
  });

  it("rejects flight actions from an unexpected vehicle identity", async () => {
    const { engine, sent, reports } = setup();
    await engine.ingest(
      [task("task-1", "flight.goto", { latitude: 37.78, longitude: -122.41, altitude_m: 590 })],
      guidedSnapshot({ identity: { systemId: 2, componentId: 1, vehicleType: 2, autopilot: 3 } }),
      1_000_000
    );
    expect(sent).toHaveLength(0);
    expect(reports[0]).toMatchObject({ type: "fail", taskId: "task-1", code: "precondition_failed" });
  });

  it("sends no vehicle command when the Core start result is uncertain", async () => {
    const { engine, sent, reports } = setup({
      reportStart: async () => {
        throw new Error("Core rejected start");
      }
    });
    const goto = task("task-1", "flight.goto", { latitude: 37.78, longitude: -122.41, altitude_m: 590 });

    await expect(engine.ingest([goto], guidedSnapshot(), 1_000_000)).rejects.toThrow("Core rejected start");
    expect(sent).toHaveLength(0);
    expect(engine.hasActiveTask()).toBe(false);
    expect(engine.reconciliationTaskId()).toBe("task-1");

    await engine.ingest(
      [{ ...goto, status: "in_progress" }],
      guidedSnapshot({ lastHeartbeatMs: 1_001_000 }),
      1_001_000
    );
    expect(reports).toContainEqual({
      type: "fail",
      taskId: "task-1",
      code: "execution_failed",
      message: expect.stringContaining("no aircraft command was sent")
    });
    expect(engine.reconciliationTaskId()).toBeUndefined();
    expect(sent).toHaveLength(0);
  });

  it("rechecks authority and freshness after Core accepts the start", async () => {
    let setControlState: (snapshot: VehicleSnapshot, nowMs: number) => void = () => undefined;
    const harness = setup({
      reportStart: async (taskId) => {
        harness.reports.push({ type: "start", taskId });
        setControlState(
          guidedSnapshot({
            mode: "STABILIZE",
            customMode: 0,
            guided: false,
            lastHeartbeatMs: 999_000,
            observation: { ...guidedSnapshot().observation!, observedAtMs: 990_000 }
          }),
          1_010_000
        );
      }
    });
    setControlState = harness.setControlState;

    await harness.engine.ingest(
      [task("task-1", "flight.goto", { latitude: 37.78, longitude: -122.41, altitude_m: 590 })],
      guidedSnapshot(),
      1_000_000
    );

    expect(harness.sent).toHaveLength(0);
    expect(harness.reports).toContainEqual({
      type: "fail",
      taskId: "task-1",
      code: "precondition_failed",
      message: expect.stringContaining("Requires Guided mode")
    });
  });

  it("keeps executing when runtime delivery omits the in-progress Task", async () => {
    const { engine, reports } = setup();
    const takeoff = task("task-1", "flight.takeoff", { altitude_m: 570 });
    await engine.ingest([takeoff], guidedSnapshot(), 1_000_000);
    await engine.ingest([], guidedSnapshot(), 1_001_000);
    expect(engine.activeTaskId()).toBe("task-1");
    expect(reports.filter((report) => report.type === "fail")).toHaveLength(0);
    expect(reports.filter((report) => report.type === "complete")).toHaveLength(0);
  });

  it("replaces an active go-to without repeating physical execution", async () => {
    const { engine, sent, reports } = setup();
    const first = task("task-1", "flight.goto", { latitude: 37.78, longitude: -122.41, altitude_m: 590 });
    await engine.ingest([first], guidedSnapshot(), 1_000_000);
    expect(sent).toHaveLength(1);

    // Core supersedes the first go-to; the replacement arrives authoritatively.
    const second = task("task-2", "flight.goto", { latitude: 37.79, longitude: -122.4, altitude_m: 595 });
    await engine.ingest(
      [{ ...first, status: "cancelled", cancellationCode: "superseded" }, second],
      guidedSnapshot(),
      1_001_000
    );
    expect(sent).toHaveLength(2);
    expect(reports).toContainEqual({ type: "start", taskId: "task-2" });

    // Repeated delivery of both tasks changes nothing.
    await engine.ingest(
      [
        { ...first, status: "cancelled", cancellationCode: "superseded" },
        { ...second, status: "in_progress" }
      ],
      guidedSnapshot(),
      1_002_000
    );
    expect(sent).toHaveLength(2);
    expect(reports.filter((report) => report.type === "start")).toHaveLength(2);
  });

  it("rejects go-to during takeoff", async () => {
    const { engine, reports } = setup();
    const takeoff = task("task-1", "flight.takeoff", { altitude_m: 570 });
    await engine.ingest([takeoff], guidedSnapshot(), 1_000_000);
    await engine.ingest(
      [takeoff, task("task-2", "flight.goto", { latitude: 37.78, longitude: -122.41, altitude_m: 590 })],
      guidedSnapshot(),
      1_001_000
    );
    expect(reports).toContainEqual({
      type: "fail",
      taskId: "task-2",
      code: "precondition_failed",
      message: "Go-to during takeoff is rejected."
    });
    expect(engine.activeTaskId()).toBe("task-1");
  });

  it("fails the interrupted task on pilot takeover and holds on return to Guided", async () => {
    const { engine, sent, reports } = setup();
    const goto = task("task-1", "flight.goto", { latitude: 37.78, longitude: -122.41, altitude_m: 590 });
    const guided = guidedSnapshot();
    await engine.ingest([goto], guided, 1_000_000);
    expect(sent).toHaveLength(1);

    // Pilot switches to Stabilize: takeover fails the task.
    const manual = guidedSnapshot({ mode: "STABILIZE", customMode: 0, guided: false });
    await engine.ingest([{ ...goto, status: "in_progress" }], manual, 1_001_000);
    expect(reports).toContainEqual({
      type: "fail",
      taskId: "task-1",
      code: "execution_failed",
      message: expect.stringContaining("takeover")
    });
    expect(engine.needsRehold()).toBe(true);

    // Returning to Guided holds the new position and awaits fresh tasking.
    const returned = guidedSnapshot({
      observation: { ...guided.observation!, latitudeDeg: 37.7755, observedAtMs: 1_002_000 }
    });
    await engine.ingest([], returned, 1_002_000);
    expect(sent).toHaveLength(2);
    expect(engine.hasActiveTask()).toBe(false);
    expect(engine.needsRehold()).toBe(false);
  });

  it("rejects new manual-mode work after takeover instead of running it on Guided return", async () => {
    const { engine, sent, reports } = setup();
    const first = task("task-1", "flight.goto", { latitude: 37.78, longitude: -122.41, altitude_m: 590 });
    await engine.ingest([first], guidedSnapshot(), 1_000_000);
    const second = task("task-2", "flight.goto", { latitude: 37.79, longitude: -122.4, altitude_m: 595 });
    const manual = guidedSnapshot({ mode: "STABILIZE", customMode: 0, guided: false, lastHeartbeatMs: 1_001_000 });

    await engine.ingest([{ ...first, status: "in_progress" }, second], manual, 1_001_000);
    expect(reports).toContainEqual({
      type: "fail",
      taskId: "task-2",
      code: "precondition_failed",
      message: expect.stringContaining("Requires Guided mode")
    });

    await engine.ingest([second], guidedSnapshot({ lastHeartbeatMs: 1_002_000 }), 1_002_000);
    expect(sent).toHaveLength(2);
    expect(reports).not.toContainEqual({ type: "start", taskId: "task-2" });
  });

  it("treats expected RTL and Land transitions as observation, not takeover", async () => {
    const { engine, reports } = setup();
    const rtl = task("task-1", "flight.return_to_launch", {});
    await engine.ingest([rtl], guidedSnapshot(), 1_000_000);
    await engine.ingest(
      [{ ...rtl, status: "in_progress" }],
      guidedSnapshot({ mode: "RTL", customMode: 6, guided: false }),
      1_001_000
    );
    expect(reports.filter((report) => report.type === "fail")).toHaveLength(0);
    expect(engine.hasActiveTask()).toBe(true);

    // Landing and disarming completes recovery at launch.
    await engine.ingest(
      [{ ...rtl, status: "in_progress" }],
      guidedSnapshot({
        armed: false,
        mode: "RTL",
        customMode: 6,
        guided: false,
        observation: {
          latitudeDeg: 37.7749,
          longitudeDeg: -122.4194,
          altitudeMslM: 560,
          relativeAltitudeM: 0,
          groundSpeedMS: 0,
          headingDeg: 90,
          observedAtMs: 1_002_000
        }
      }),
      1_002_000
    );
    expect(reports).toContainEqual({ type: "complete", taskId: "task-1" });
  });

  it.each([
    ["flight.return_to_launch", "RTL", 6],
    ["flight.land", "LAND", 9]
  ] as const)("fails %s when the pilot leaves its expected native modes", async (command, expectedMode, customMode) => {
    const { engine, reports } = setup();
    const recovery = task("task-1", command, {});
    await engine.ingest([recovery], guidedSnapshot(), 1_000_000);
    await engine.ingest(
      [{ ...recovery, status: "in_progress" }],
      guidedSnapshot({ mode: expectedMode, customMode, guided: false, lastHeartbeatMs: 1_001_000 }),
      1_001_000
    );
    await engine.ingest(
      [{ ...recovery, status: "in_progress" }],
      guidedSnapshot({ mode: "STABILIZE", customMode: 0, guided: false, lastHeartbeatMs: 1_002_000 }),
      1_002_000
    );

    expect(reports).toContainEqual({
      type: "fail",
      taskId: "task-1",
      code: "execution_failed",
      message: expect.stringContaining("takeover")
    });
  });

  it("does not complete RTL after landing away from launch", async () => {
    const { engine, reports } = setup();
    const rtl = task("task-1", "flight.return_to_launch", {});
    await engine.ingest([rtl], guidedSnapshot(), 1_000_000);
    await engine.ingest(
      [{ ...rtl, status: "in_progress" }],
      guidedSnapshot({
        armed: false,
        mode: "RTL",
        customMode: 6,
        guided: false,
        lastHeartbeatMs: 1_002_000,
        observation: {
          ...guidedSnapshot().observation!,
          latitudeDeg: 37.7759,
          observedAtMs: 1_002_000
        }
      }),
      1_002_000
    );

    expect(reports.filter((report) => report.type === "complete")).toHaveLength(0);
    expect(engine.hasActiveTask()).toBe(true);
  });

  it("awaits cancellation hold before starting replacement movement", async () => {
    let sendCount = 0;
    let markHoldStarted: () => void = () => undefined;
    let releaseHold: () => void = () => undefined;
    const holdStarted = new Promise<void>((resolve) => {
      markHoldStarted = resolve;
    });
    const holdReleased = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    const { engine, reports } = setup({
      send: async () => {
        sendCount += 1;
        if (sendCount === 2) {
          markHoldStarted();
          await holdReleased;
        }
      }
    });
    const goto = task("task-1", "flight.goto", { latitude: 37.78, longitude: -122.41, altitude_m: 590 });
    await engine.ingest([goto], guidedSnapshot(), 1_000_000);
    const replacement = task("task-2", "flight.goto", {
      latitude: 37.79,
      longitude: -122.4,
      altitude_m: 595
    });

    const ingest = engine.ingest(
      [{ ...goto, status: "cancelled", cancellationCode: "requested" }, replacement],
      guidedSnapshot({ lastHeartbeatMs: 1_001_000 }),
      1_001_000
    );
    await holdStarted;
    expect(sendCount).toBe(2);
    expect(reports).not.toContainEqual({ type: "start", taskId: "task-2" });

    releaseHold();
    await ingest;
    expect(sendCount).toBe(3);
    expect(reports).toContainEqual({ type: "start", taskId: "task-2" });
  });

  it("does not start replacement movement when cancellation hold fails", async () => {
    let sendCount = 0;
    const { engine, reports } = setup({
      send: async () => {
        sendCount += 1;
        if (sendCount > 1) throw new Error("vehicle link unavailable");
      }
    });
    const goto = task("task-1", "flight.goto", { latitude: 37.78, longitude: -122.41, altitude_m: 590 });
    const replacement = task("task-2", "flight.goto", {
      latitude: 37.79,
      longitude: -122.4,
      altitude_m: 595
    });
    await engine.ingest([goto], guidedSnapshot(), 1_000_000);

    await expect(
      engine.ingest(
        [{ ...goto, status: "cancelled", cancellationCode: "requested" }, replacement],
        guidedSnapshot({ lastHeartbeatMs: 1_001_000 }),
        1_001_000
      )
    ).rejects.toThrow("vehicle link unavailable");
    expect(sendCount).toBe(2);
    expect(reports).not.toContainEqual({ type: "start", taskId: "task-2" });
  });

  it("uses neither stale heartbeat nor stale position to complete or correct movement", async () => {
    const { engine, reports, sent, setControlState } = setup();
    const goto = task("task-1", "flight.goto", { latitude: 37.7759, longitude: -122.4194, altitude_m: 560 });
    await engine.ingest([goto], guidedSnapshot(), 1_000_000);
    const stale = guidedSnapshot({
      lastHeartbeatMs: 990_000,
      observation: { ...guidedSnapshot().observation!, latitudeDeg: 37.7759, observedAtMs: 990_000 }
    });
    setControlState(stale, 1_020_000);

    await engine.ingest([{ ...goto, status: "in_progress" }], stale, 1_020_000);
    expect(reports.filter((report) => report.type === "complete")).toHaveLength(0);

    await engine.ingest([{ ...goto, status: "cancelled", cancellationCode: "requested" }], stale, 1_020_000);
    expect(sent).toHaveLength(1);
  });

  it("requests land on failed takeoff while Guided and airborne", async () => {
    const { engine, sent, reports } = setup();
    const takeoff = task("task-1", "flight.takeoff", { altitude_m: 570 });
    await engine.ingest([takeoff], guidedSnapshot(), 1_000_000);
    // No progress past the timeout relative to the stuck position.
    await engine.ingest(
      [{ ...takeoff, status: "in_progress" }],
      guidedSnapshot({
        lastHeartbeatMs: 1_000_000 + 301_000,
        observation: {
          latitudeDeg: 37.7749,
          longitudeDeg: -122.4194,
          altitudeMslM: 560,
          relativeAltitudeM: 8,
          groundSpeedMS: 0,
          headingDeg: 90,
          observedAtMs: 1_000_000 + 301_000
        }
      }),
      1_000_000 + 301_000
    );
    expect(reports).toContainEqual({
      type: "fail",
      taskId: "task-1",
      code: "execution_failed",
      message: expect.stringContaining("No completion")
    });
    expect(sent).toHaveLength(2);
  });

  it("retains task failure when the corrective Land command cannot be sent", async () => {
    let sendCount = 0;
    const { engine, reports } = setup({
      send: async () => {
        sendCount += 1;
        if (sendCount === 2) throw new Error("vehicle link unavailable");
      }
    });
    const takeoff = task("task-1", "flight.takeoff", { altitude_m: 570 });
    await engine.ingest([takeoff], guidedSnapshot(), 1_000_000);
    const timedOut = guidedSnapshot({
      lastHeartbeatMs: 1_301_000,
      observation: {
        ...guidedSnapshot().observation!,
        relativeAltitudeM: 8,
        observedAtMs: 1_301_000
      }
    });

    await expect(engine.ingest([{ ...takeoff, status: "in_progress" }], timedOut, 1_301_000)).rejects.toThrow(
      "vehicle link unavailable"
    );
    expect(engine.reconciliationTaskId()).toBe("task-1");
    expect(sendCount).toBe(2);

    await engine.ingest([{ ...takeoff, status: "in_progress" }], timedOut, 1_302_000);
    expect(reports).toContainEqual({
      type: "fail",
      taskId: "task-1",
      code: "execution_failed",
      message: expect.stringContaining("No completion")
    });
    expect(engine.reconciliationTaskId()).toBeUndefined();
    expect(sendCount).toBe(2);
  });

  it("retries a failed completion report without repeating the vehicle command", async () => {
    let completeAttempts = 0;
    const { engine, sent } = setup({
      reportComplete: async () => {
        completeAttempts += 1;
        if (completeAttempts === 1) throw new Error("Core unavailable");
      }
    });
    const goto = task("task-1", "flight.goto", { latitude: 37.7749, longitude: -122.4194, altitude_m: 560 });

    await expect(engine.ingest([goto], guidedSnapshot(), 1_000_000)).rejects.toThrow("Core unavailable");
    expect(engine.reconciliationTaskId()).toBe("task-1");
    expect(sent).toHaveLength(1);

    await engine.ingest(
      [{ ...goto, status: "in_progress" }],
      guidedSnapshot({ lastHeartbeatMs: 1_001_000 }),
      1_001_000
    );
    expect(completeAttempts).toBe(2);
    expect(engine.reconciliationTaskId()).toBeUndefined();
    expect(sent).toHaveLength(1);
  });

  it("retries a failed takeover report without repeating the vehicle command", async () => {
    let failAttempts = 0;
    const { engine, sent } = setup({
      reportFail: async () => {
        failAttempts += 1;
        if (failAttempts === 1) throw new Error("Core unavailable");
      }
    });
    const goto = task("task-1", "flight.goto", { latitude: 37.78, longitude: -122.41, altitude_m: 590 });
    await engine.ingest([goto], guidedSnapshot(), 1_000_000);
    const manual = guidedSnapshot({ mode: "STABILIZE", customMode: 0, guided: false, lastHeartbeatMs: 1_001_000 });

    await expect(engine.ingest([{ ...goto, status: "in_progress" }], manual, 1_001_000)).rejects.toThrow(
      "Core unavailable"
    );
    expect(engine.reconciliationTaskId()).toBe("task-1");
    expect(sent).toHaveLength(1);

    await engine.ingest([{ ...goto, status: "in_progress" }], manual, 1_002_000);
    expect(failAttempts).toBe(2);
    expect(engine.reconciliationTaskId()).toBeUndefined();
    expect(sent).toHaveLength(1);
  });

  it("completes go-to on arrival at position and altitude", async () => {
    const { engine, reports } = setup();
    const goto = task("task-1", "flight.goto", { latitude: 37.7749, longitude: -122.4194, altitude_m: 560 });
    await engine.ingest([goto], guidedSnapshot(), 1_000_000);
    await engine.ingest([{ ...goto, status: "in_progress" }], guidedSnapshot(), 1_001_000);
    expect(reports).toContainEqual({ type: "complete", taskId: "task-1" });
  });
});
