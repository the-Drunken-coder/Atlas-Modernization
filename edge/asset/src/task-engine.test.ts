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

function setup() {
  const sent: MavLinkData[] = [];
  const reports: Report[] = [];
  const sender: CommandSender = {
    send: async (message) => {
      sent.push(message);
    }
  };
  const callbacks: EngineCallbacks = {
    reportStart: async (taskId) => {
      reports.push({ type: "start", taskId });
    },
    reportProgress: async (taskId, progress) => {
      reports.push({ type: "progress", taskId, progress });
    },
    reportComplete: async (taskId) => {
      reports.push({ type: "complete", taskId });
    },
    reportFail: async (taskId, code, message) => {
      reports.push({ type: "fail", taskId, code, message });
    }
  };
  return { engine: new TaskEngine(sender, callbacks, config), sent, reports };
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
    expect(reports).toEqual([{ type: "start", taskId: "task-1" }]);

    // Climbing: no completion yet.
    await engine.ingest(
      [{ ...target, status: "in_progress" }],
      guidedSnapshot({
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

    // At altitude: settle window starts, then completes.
    const atAltitude = guidedSnapshot({
      observation: {
        latitudeDeg: 37.7749,
        longitudeDeg: -122.4194,
        altitudeMslM: 570,
        relativeAltitudeM: 10,
        groundSpeedMS: 0.1,
        headingDeg: 90,
        observedAtMs: 1_010_000
      }
    });
    await engine.ingest([{ ...target, status: "in_progress" }], atAltitude, 1_010_000);
    await engine.ingest(
      [{ ...target, status: "in_progress" }],
      { ...atAltitude, observation: { ...atAltitude.observation!, observedAtMs: 1_014_000 } },
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

  it("establishes idle hold when go-to is cancelled", async () => {
    const { engine, sent } = setup();
    const goto = task("task-1", "flight.goto", { latitude: 37.78, longitude: -122.41, altitude_m: 590 });
    await engine.ingest([goto], guidedSnapshot(), 1_000_000);
    expect(sent).toHaveLength(1);
    await engine.ingest([{ ...goto, status: "cancelled", cancellationCode: "requested" }], guidedSnapshot(), 1_001_000);
    expect(sent).toHaveLength(2);
    expect(engine.hasActiveTask()).toBe(false);
  });

  it("requests land on failed takeoff while Guided and airborne", async () => {
    const { engine, sent, reports } = setup();
    const takeoff = task("task-1", "flight.takeoff", { altitude_m: 570 });
    await engine.ingest([takeoff], guidedSnapshot(), 1_000_000);
    // No progress past the timeout relative to the stuck position.
    await engine.ingest(
      [{ ...takeoff, status: "in_progress" }],
      guidedSnapshot({
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

  it("completes go-to on arrival at position and altitude", async () => {
    const { engine, reports } = setup();
    const goto = task("task-1", "flight.goto", { latitude: 37.7749, longitude: -122.4194, altitude_m: 560 });
    await engine.ingest([goto], guidedSnapshot(), 1_000_000);
    await engine.ingest([{ ...goto, status: "in_progress" }], guidedSnapshot(), 1_001_000);
    expect(reports).toContainEqual({ type: "complete", taskId: "task-1" });
  });
});
