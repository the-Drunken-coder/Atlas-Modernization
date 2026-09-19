import type { MavLinkData } from "node-mavlink";
import {
  gotoPositionCommand,
  holdPositionCommand,
  landCommand,
  returnToLaunchCommand,
  takeoffCommand
} from "./commands.js";
import type { AssetConfig } from "./config.js";
import { hasFreshControlTelemetry, type VehicleSnapshot } from "./vehicle.js";

export type FlightCommand = "flight.takeoff" | "flight.goto" | "flight.return_to_launch" | "flight.land";

export type AuthoritativeTask = {
  taskId: string;
  command: string;
  status: "pending" | "acknowledged" | "in_progress" | "completed" | "failed" | "cancelled";
  cancellationCode?: string;
  input: Record<string, unknown>;
};

export type FailureCode = "precondition_failed" | "execution_failed";

export type EngineCallbacks = {
  reportStart(taskId: string): Promise<void>;
  reportProgress(taskId: string, progress: number): Promise<void>;
  reportComplete(taskId: string): Promise<void>;
  reportFail(taskId: string, code: FailureCode, message: string): Promise<void>;
};

export type CommandSender = {
  send(message: MavLinkData): Promise<void>;
};

export type ControlState = {
  snapshot: VehicleSnapshot;
  nowMs: number;
};

export function isFlightCommand(command: string): command is FlightCommand {
  return (
    command === "flight.takeoff" ||
    command === "flight.goto" ||
    command === "flight.return_to_launch" ||
    command === "flight.land"
  );
}

type ActiveExecution = {
  task: AuthoritativeTask;
  startedAtMs: number;
  lastProgressAtMs: number;
  startRemainingM?: number;
  bestRemainingM: number;
  settleSinceMs?: number;
  expectedModes: string[];
};

type PendingTerminalReport =
  | { taskId: string; outcome: "complete" }
  | { taskId: string; outcome: "fail"; code: FailureCode; message: string };

export function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(a));
}

function numberInput(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Executes flight Tasks against one vehicle. The engine never queues: it acts
 * on the authoritative Core state it is given, enforces preconditions
 * (Guided authority, armed takeoff, no go-to during takeoff), and reports
 * physical outcomes — never mere acknowledgements — back through the
 * callbacks. Repeated delivery of the same Task never repeats execution.
 */
export class TaskEngine {
  private active: ActiveExecution | undefined;
  private finished = new Set<string>();
  private reholdOnGuided = false;
  private holdRequiredBeforeMovement = false;
  private pendingTerminalReport: PendingTerminalReport | undefined;
  private lastMode: string | undefined;

  constructor(
    private readonly sender: CommandSender,
    private readonly callbacks: EngineCallbacks,
    private readonly config: AssetConfig,
    private readonly getControlState: () => ControlState
  ) {}

  hasActiveTask(): boolean {
    return this.active !== undefined;
  }

  activeTaskId(): string | undefined {
    return this.active === undefined ? undefined : this.active.task.taskId;
  }

  /** Task whose authoritative state must be refreshed after Core reconnects. */
  reconciliationTaskId(): string | undefined {
    return this.pendingTerminalReport?.taskId ?? this.active?.task.taskId;
  }

  activeCommand(): FlightCommand | undefined {
    const command = this.active?.task.command;
    return command !== undefined && isFlightCommand(command) ? command : undefined;
  }

  needsRehold(): boolean {
    return this.reholdOnGuided;
  }

  /** Reconcile with authoritative Core state, then advance the active task. */
  async ingest(tasks: AuthoritativeTask[], snapshot: VehicleSnapshot, nowMs: number): Promise<void> {
    let current = { snapshot, nowMs };
    this.reconcileAuthoritative(tasks);
    if (this.pendingTerminalReport !== undefined) await this.flushTerminalReport();
    await this.observeMode(snapshot);
    if (this.reholdOnGuided) {
      if (!snapshot.guided) {
        await this.rejectPendingOutsideGuided(tasks, snapshot, nowMs);
        return;
      }
      if (!(await this.establishHold(snapshot, nowMs))) return;
      current = this.getControlState();
      this.reholdOnGuided = false;
    }
    await this.rejectGotoDuringTakeoff(tasks);
    if (this.holdRequiredBeforeMovement) {
      current = this.getControlState();
      if (!(await this.establishHold(current.snapshot, current.nowMs))) return;
      current = this.getControlState();
      this.holdRequiredBeforeMovement = false;
    }
    if (this.active === undefined) {
      current = (await this.adoptNext(tasks, current.snapshot, current.nowMs)) ?? current;
    }
    await this.advance(current.snapshot, current.nowMs);
  }

  /** Pilot took the aircraft out of Guided; fail the interrupted task. */
  async noteTakeover(mode: string): Promise<void> {
    if (this.active === undefined) return;
    if (this.active.expectedModes.includes(mode)) return;
    const taskId = this.active.task.taskId;
    this.active = undefined;
    this.finished.add(taskId);
    this.reholdOnGuided = true;
    await this.reportTerminal({
      taskId,
      outcome: "fail",
      code: "execution_failed",
      message: `Pilot takeover to ${mode}; Atlas no longer has control.`
    });
  }

  /** Returning to Guided holds the new position; old intent never resumes. */
  async noteGuidedReturn(snapshot: VehicleSnapshot, nowMs: number): Promise<void> {
    if (!this.reholdOnGuided) return;
    if (await this.establishHold(snapshot, nowMs)) this.reholdOnGuided = false;
  }

  /**
   * Drop the active task without vehicle action because an external recovery
   * (Core-loss RTL) already runs. Returns the abandoned task id so the caller
   * can report the outcome once Core is reachable again.
   */
  abandonActiveForRecovery(): string | undefined {
    if (this.active === undefined) return undefined;
    const taskId = this.active.task.taskId;
    this.active = undefined;
    this.finished.add(taskId);
    return taskId;
  }

  private async observeMode(snapshot: VehicleSnapshot): Promise<void> {
    const mode = snapshot.customMode === undefined ? undefined : snapshot.mode;
    if (mode === undefined || mode === this.lastMode) return;
    const previousMode = this.lastMode;
    this.lastMode = mode;
    const active = this.active;
    if (
      active !== undefined &&
      previousMode !== undefined &&
      active.expectedModes.includes(previousMode) &&
      !active.expectedModes.includes(mode)
    ) {
      await this.noteTakeover(mode);
    } else if (previousMode === "GUIDED" && mode !== "GUIDED") {
      await this.noteTakeover(mode);
    }
  }

  /** A new go-to must not interrupt the agreed takeoff behavior. */
  private async rejectGotoDuringTakeoff(tasks: AuthoritativeTask[]): Promise<void> {
    if (this.active?.task.command !== "flight.takeoff") return;
    for (const task of tasks) {
      if (
        task.command === "flight.goto" &&
        (task.status === "pending" || task.status === "acknowledged") &&
        !this.finished.has(task.taskId)
      ) {
        this.finished.add(task.taskId);
        await this.reportTerminal({
          taskId: task.taskId,
          outcome: "fail",
          code: "precondition_failed",
          message: "Go-to during takeoff is rejected."
        });
      }
    }
  }

  private async rejectPendingOutsideGuided(
    tasks: AuthoritativeTask[],
    snapshot: VehicleSnapshot,
    nowMs: number
  ): Promise<void> {
    for (const task of tasks) {
      if (
        !isFlightCommand(task.command) ||
        (task.status !== "pending" && task.status !== "acknowledged") ||
        this.finished.has(task.taskId)
      ) {
        continue;
      }
      this.finished.add(task.taskId);
      await this.reportTerminal({
        taskId: task.taskId,
        outcome: "fail",
        code: "precondition_failed",
        message: this.preconditions(task, snapshot, nowMs).join(" ")
      });
    }
  }

  private reconcileAuthoritative(tasks: AuthoritativeTask[]): void {
    const byId = new Map(tasks.map((task) => [task.taskId, task]));
    if (this.pendingTerminalReport !== undefined) {
      const authoritative = byId.get(this.pendingTerminalReport.taskId);
      if (
        authoritative?.status === "completed" ||
        authoritative?.status === "failed" ||
        authoritative?.status === "cancelled"
      ) {
        this.pendingTerminalReport = undefined;
      }
    }
    if (this.active !== undefined) {
      const authoritative = byId.get(this.active.task.taskId);
      if (authoritative === undefined) {
        // Runtime delivery only lists pending work. An in-progress Task is
        // absent from that list until we refresh it by ID, so missing here
        // is not cancellation.
      } else if (
        authoritative.status === "completed" ||
        authoritative.status === "failed" ||
        authoritative.status === "cancelled"
      ) {
        const taskId = authoritative.taskId;
        const command = this.active.task.command;
        this.active = undefined;
        this.finished.add(taskId);
        if (
          authoritative.status === "cancelled" &&
          authoritative.cancellationCode === "requested" &&
          command === "flight.goto"
        ) {
          this.holdRequiredBeforeMovement = true;
        }
      } else {
        this.active.task = authoritative;
      }
    }
    for (const task of tasks) {
      if (task.status === "completed" || task.status === "failed" || task.status === "cancelled") {
        this.finished.add(task.taskId);
      }
    }
  }

  private async adoptNext(
    tasks: AuthoritativeTask[],
    snapshot: VehicleSnapshot,
    nowMs: number
  ): Promise<ControlState | undefined> {
    // Delivery arrives in tasking order; the first actionable Task wins.
    // There is no queue: anything not adopted now is re-evaluated next tick.
    const candidate = tasks
      .filter((task) => isFlightCommand(task.command))
      .filter((task) => task.status === "pending" || task.status === "acknowledged")
      .filter((task) => !this.finished.has(task.taskId))[0];
    if (candidate === undefined) return undefined;
    const problems = this.preconditions(candidate, snapshot, nowMs);
    if (problems.length > 0) {
      this.finished.add(candidate.taskId);
      await this.reportTerminal({
        taskId: candidate.taskId,
        outcome: "fail",
        code: "precondition_failed",
        message: problems.join(" ")
      });
      return undefined;
    }
    try {
      await this.callbacks.reportStart(candidate.taskId);
    } catch (error) {
      this.finished.add(candidate.taskId);
      this.pendingTerminalReport = {
        taskId: candidate.taskId,
        outcome: "fail",
        code: "execution_failed",
        message: "Task start could not be confirmed; no aircraft command was sent."
      };
      throw error;
    }
    let current: ControlState;
    try {
      current = this.getControlState();
    } catch (error) {
      this.finished.add(candidate.taskId);
      throw error;
    }
    const currentProblems = this.preconditions(candidate, current.snapshot, current.nowMs);
    if (currentProblems.length > 0) {
      this.finished.add(candidate.taskId);
      await this.reportTerminal({
        taskId: candidate.taskId,
        outcome: "fail",
        code: "precondition_failed",
        message: currentProblems.join(" ")
      });
      return current;
    }
    const remaining = this.remaining(candidate, current.snapshot);
    const execution: ActiveExecution = {
      task: candidate,
      startedAtMs: current.nowMs,
      lastProgressAtMs: current.nowMs,
      bestRemainingM: remaining ?? Number.POSITIVE_INFINITY,
      expectedModes: expectedModesFor(candidate.command as FlightCommand)
    };
    if (remaining !== undefined) execution.startRemainingM = remaining;
    this.active = execution;
    try {
      await this.dispatch(candidate, current.snapshot);
    } catch (error) {
      this.active = undefined;
      this.finished.add(candidate.taskId);
      const message = error instanceof Error ? error.message : String(error);
      await this.reportTerminal({
        taskId: candidate.taskId,
        outcome: "fail",
        code: "execution_failed",
        message: `Failed to send flight command: ${message}`
      });
    }
    return current;
  }

  private preconditions(task: AuthoritativeTask, snapshot: VehicleSnapshot, nowMs: number): string[] {
    const problems: string[] = [];
    if (!snapshot.guided) {
      problems.push(`Requires Guided mode; aircraft is in ${snapshot.mode}. Atlas never forces Guided.`);
    }
    // Reconnecting the radio to a different aircraft must never silently
    // retask: identity is verified at every execution, not only at readiness.
    if (
      snapshot.identity === undefined ||
      snapshot.identity.systemId !== this.config.vehicleSystemId ||
      snapshot.identity.componentId !== this.config.vehicleComponentId
    ) {
      problems.push("Connected vehicle does not match the configured vehicle identity.");
    }
    if (!hasFreshControlTelemetry(snapshot, nowMs)) {
      problems.push("Requires fresh telemetry; heartbeat or position observations are stale.");
    }
    if (task.command === "flight.takeoff") {
      if (!snapshot.armed) problems.push("Takeoff requires an already-armed aircraft; Atlas never arms.");
      const target = numberInput(task.input, "altitude_m");
      if (target === undefined) {
        problems.push("Takeoff requires altitude_m in meters above mean sea level.");
      } else if (snapshot.launchElevationM === undefined || !snapshot.launchElevationVerified) {
        problems.push("Takeoff requires verified launch elevation to convert the MSL target.");
      } else if (target <= snapshot.launchElevationM + 0.3) {
        problems.push("Takeoff target must be above launch elevation.");
      }
    }
    if (task.command === "flight.goto") {
      if (
        numberInput(task.input, "latitude") === undefined ||
        numberInput(task.input, "longitude") === undefined ||
        numberInput(task.input, "altitude_m") === undefined
      ) {
        problems.push("Go-to requires latitude, longitude, and altitude_m in meters above mean sea level.");
      }
    }
    return problems;
  }

  private async dispatch(task: AuthoritativeTask, snapshot: VehicleSnapshot): Promise<void> {
    const sysid = this.config.vehicleSystemId;
    const compid = this.config.vehicleComponentId;
    switch (task.command) {
      case "flight.takeoff": {
        const target = numberInput(task.input, "altitude_m");
        const launch = snapshot.launchElevationM;
        if (target === undefined || launch === undefined) break;
        await this.sender.send(takeoffCommand(sysid, compid, target - launch));
        break;
      }
      case "flight.goto": {
        const observation = snapshot.observation;
        if (observation === undefined) break;
        await this.sender.send(
          gotoPositionCommand(
            sysid,
            compid,
            numberInput(task.input, "latitude") ?? observation.latitudeDeg,
            numberInput(task.input, "longitude") ?? observation.longitudeDeg,
            numberInput(task.input, "altitude_m") ?? observation.altitudeMslM
          )
        );
        break;
      }
      case "flight.return_to_launch":
        await this.sender.send(returnToLaunchCommand(sysid, compid));
        break;
      case "flight.land":
        await this.sender.send(landCommand(sysid, compid));
        break;
    }
  }

  private remaining(task: AuthoritativeTask, snapshot: VehicleSnapshot): number | undefined {
    const observation = snapshot.observation;
    if (observation === undefined) return undefined;
    if (task.command === "flight.takeoff") {
      const target = numberInput(task.input, "altitude_m");
      if (target === undefined) return undefined;
      return Math.abs(target - observation.altitudeMslM);
    }
    if (task.command === "flight.goto") {
      const latitude = numberInput(task.input, "latitude");
      const longitude = numberInput(task.input, "longitude");
      const altitude = numberInput(task.input, "altitude_m");
      if (latitude === undefined || longitude === undefined || altitude === undefined) return undefined;
      return Math.max(
        haversineM(observation.latitudeDeg, observation.longitudeDeg, latitude, longitude),
        Math.abs(altitude - observation.altitudeMslM)
      );
    }
    return undefined;
  }

  private async advance(snapshot: VehicleSnapshot, nowMs: number): Promise<void> {
    const active = this.active;
    if (active === undefined) return;
    if (nowMs - active.startedAtMs > this.config.taskTimeoutSeconds * 1000) {
      await this.failActive(
        "execution_failed",
        `No completion within ${this.config.taskTimeoutSeconds}s.`,
        snapshot,
        nowMs
      );
      return;
    }
    const remaining = this.remaining(active.task, snapshot);
    if (hasFreshControlTelemetry(snapshot, nowMs) && remaining !== undefined && remaining < active.bestRemainingM) {
      active.bestRemainingM = remaining;
      active.lastProgressAtMs = nowMs;
    } else if (nowMs - active.lastProgressAtMs > this.config.progressTimeoutSeconds * 1000) {
      await this.failActive(
        "execution_failed",
        `No progress for ${this.config.progressTimeoutSeconds}s.`,
        snapshot,
        nowMs
      );
      return;
    }
    if (this.isComplete(active, snapshot, nowMs)) {
      const taskId = active.task.taskId;
      this.active = undefined;
      this.finished.add(taskId);
      await this.reportTerminal({ taskId, outcome: "complete" });
    }
  }

  private isComplete(active: ActiveExecution, snapshot: VehicleSnapshot, nowMs: number): boolean {
    if (!hasFreshControlTelemetry(snapshot, nowMs)) return false;
    const observation = snapshot.observation;
    if (active.task.command === "flight.takeoff") {
      if (observation === undefined) return false;
      const target = numberInput(active.task.input, "altitude_m");
      if (target === undefined) return false;
      const arrived =
        snapshot.guided &&
        snapshot.armed &&
        Math.abs(target - observation.altitudeMslM) <= this.config.altitudeToleranceM &&
        observation.groundSpeedMS <= 0.5;
      if (!arrived) {
        delete active.settleSinceMs;
        return false;
      }
      active.settleSinceMs ??= nowMs;
      return nowMs - active.settleSinceMs >= this.config.hoverSettleSeconds * 1000;
    }
    if (active.task.command === "flight.goto") {
      if (observation === undefined) return false;
      const latitude = numberInput(active.task.input, "latitude");
      const longitude = numberInput(active.task.input, "longitude");
      const altitude = numberInput(active.task.input, "altitude_m");
      if (latitude === undefined || longitude === undefined || altitude === undefined) return false;
      return (
        haversineM(observation.latitudeDeg, observation.longitudeDeg, latitude, longitude) <=
          this.config.arrivalRadiusM && Math.abs(altitude - observation.altitudeMslM) <= this.config.altitudeToleranceM
      );
    }
    if (active.task.command === "flight.return_to_launch" || active.task.command === "flight.land") {
      if (observation === undefined) return false;
      const landed = !snapshot.armed && Math.abs(observation.relativeAltitudeM) <= 0.3;
      if (!landed) return false;
      if (active.task.command === "flight.land") return true;
      if (snapshot.launchLatitudeDeg === undefined || snapshot.launchLongitudeDeg === undefined) return false;
      return (
        haversineM(
          observation.latitudeDeg,
          observation.longitudeDeg,
          snapshot.launchLatitudeDeg,
          snapshot.launchLongitudeDeg
        ) <= this.config.arrivalRadiusM
      );
    }
    return false;
  }

  private async failActive(
    code: FailureCode,
    message: string,
    snapshot: VehicleSnapshot,
    nowMs: number
  ): Promise<void> {
    const active = this.active;
    if (active === undefined) return;
    const taskId = active.task.taskId;
    const command = active.task.command;
    this.active = undefined;
    this.finished.add(taskId);
    this.pendingTerminalReport = { taskId, outcome: "fail", code, message };
    // Action-specific recovery: a failed go-to holds while Guided with usable
    // telemetry; a failed takeoff requests Land while Guided and airborne. A
    // failed RTL or Land leaves the autopilot recovery running.
    if (
      (command === "flight.goto" || command === "flight.takeoff") &&
      snapshot.guided &&
      snapshot.armed &&
      hasFreshControlTelemetry(snapshot, nowMs)
    ) {
      if (command === "flight.goto") {
        await this.establishHold(snapshot, nowMs);
      } else if (snapshot.observation !== undefined && Math.abs(snapshot.observation.relativeAltitudeM) > 0.5) {
        await this.sender.send(landCommand(this.config.vehicleSystemId, this.config.vehicleComponentId));
      }
    }
    await this.flushTerminalReport();
  }

  private async reportTerminal(report: PendingTerminalReport): Promise<void> {
    this.pendingTerminalReport = report;
    await this.flushTerminalReport();
  }

  private async flushTerminalReport(): Promise<void> {
    const report = this.pendingTerminalReport;
    if (report === undefined) return;
    if (report.outcome === "complete") {
      await this.callbacks.reportComplete(report.taskId);
    } else {
      await this.callbacks.reportFail(report.taskId, report.code, report.message);
    }
    if (this.pendingTerminalReport === report) this.pendingTerminalReport = undefined;
  }

  private async establishHold(snapshot: VehicleSnapshot, nowMs: number): Promise<boolean> {
    const observation = snapshot.observation;
    // Never send corrective commands from stale observations or without
    // authority.
    if (observation === undefined || !snapshot.guided || !hasFreshControlTelemetry(snapshot, nowMs)) return false;
    await this.sender.send(
      holdPositionCommand(
        this.config.vehicleSystemId,
        this.config.vehicleComponentId,
        observation.latitudeDeg,
        observation.longitudeDeg,
        observation.altitudeMslM
      )
    );
    return true;
  }
}

function expectedModesFor(command: FlightCommand): string[] {
  // Native RTL and Land transitions under Atlas authority are expected, not
  // takeover. Takeoff and go-to never change the mode themselves.
  if (command === "flight.return_to_launch") return ["GUIDED", "RTL", "LAND"];
  if (command === "flight.land") return ["GUIDED", "LAND"];
  return ["GUIDED"];
}
