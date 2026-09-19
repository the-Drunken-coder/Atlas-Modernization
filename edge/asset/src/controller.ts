import type { TaskResource } from "@the-drunken-coder/atlas-sdk";
import { minimal } from "node-mavlink";
import { paramReadCommand, returnToLaunchCommand } from "./commands.js";
import type { AssetConfig } from "./config.js";
import type { CoreGateway } from "./core-client.js";
import { type FlightTelemetry } from "./core-client.js";
import { type MavLink, type ReceivedMessage } from "./mavlink-link.js";
import { checkFlightReadiness } from "./readiness.js";
import type { TaskEngine } from "./task-engine.js";
import { type AuthoritativeTask } from "./task-engine.js";
import { type VehicleSnapshot, VehicleTracker } from "./vehicle.js";

export type { AuthoritativeTask };

export type ControllerLog = (level: "info" | "warn" | "error", message: string) => void;

export type ControllerDeps = {
  openLink: () => Promise<MavLink>;
  core: CoreGateway;
  engine: TaskEngine;
  tracker: VehicleTracker;
  log?: ControllerLog;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

export function flightGateOpen(snapshot: {
  initiallyLandedAndDisarmed: boolean;
  armed: boolean;
  relativeAltitudeM?: number;
}): boolean {
  if (snapshot.initiallyLandedAndDisarmed) return true;
  // A restarted process never resumes stale airborne work: flight readiness
  // waits for confirmed landed and disarmed state.
  if (snapshot.armed) return false;
  if (snapshot.relativeAltitudeM !== undefined && Math.abs(snapshot.relativeAltitudeM) > 0.5) return false;
  return true;
}

export function shouldRequestCoreLossRecovery(args: {
  downMs: number;
  graceMs: number;
  guided: boolean;
  activeCommand: "flight.takeoff" | "flight.goto" | "flight.return_to_launch" | "flight.land" | undefined;
  recoveryRunning: boolean;
}): boolean {
  if (args.recoveryRunning) return false;
  // Recovery interrupts takeoff or go-to only. An ongoing landing or RTL is
  // preserved, and Core loss never overrides manual flight.
  if (args.activeCommand !== "flight.takeoff" && args.activeCommand !== "flight.goto") return false;
  if (!args.guided) return false;
  return args.downMs >= args.graceMs;
}

const GCS_TYPE = (minimal.MavType as unknown as Record<string, number>)["GCS"] ?? 6;
const FS_GCS_PARAM = "FS_GCS_ENABLE";
const PARAM_VERIFY_TIMEOUT_MS = 10_000;

/**
 * One Asset Host process for one quadcopter. Orchestrates the MAVLink link,
 * Core attachment, flight execution, and the agreed safety policies: Guided
 * authority, Core-loss grace with recovery RTL, fresh-runtime restart
 * barrier, and bounded graceful shutdown.
 */
export class AssetController {
  private readonly log: ControllerLog;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private link: MavLink | undefined;
  private running = false;
  private coreDownSince: number | undefined;
  private coreLossRecovery = false;
  private initiallyLandedAndDisarmed = false;
  private ready = false;
  private gcsFailsafeChecked = false;
  private lastTasks: AuthoritativeTask[] = [];

  constructor(
    private readonly config: AssetConfig,
    private readonly deps: ControllerDeps
  ) {
    this.log = deps.log ?? (() => {});
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = deps.now ?? (() => Date.now());
  }

  snapshot(): VehicleSnapshot {
    return this.deps.tracker.getSnapshot();
  }

  isReady(): boolean {
    return this.ready;
  }

  isCoreDown(): boolean {
    return this.coreDownSince !== undefined;
  }

  async start(): Promise<void> {
    this.running = true;
    this.link = await this.deps.openLink();
    this.log("info", `MAVLink link open: ${this.link.describe()}`);
    this.link.onMessage((message) => {
      this.handleMessage(message);
    });

    await this.deps.core.begin();
    this.log("info", `Runtime registered for ${this.config.assetId}; verifying vehicle before readiness.`);
    await this.verifyGcsFailsafe();
    await this.waitForInitialState();
    await this.run();
  }

  async shutdown(): Promise<void> {
    this.running = false;
    const snapshot = this.snapshot();
    const airborne = snapshot.armed || Math.abs(snapshot.observation?.relativeAltitudeM ?? 0) > 0.5;
    // Graceful shutdown requests RTL when airborne under Atlas control and
    // briefly awaits mode confirmation. Ongoing RTL, landing, or manual
    // control is preserved: exiting never interrupts those actions. The
    // runtime registration is intentionally left for the next process, whose
    // fresh identity drains stale work through the normal fencing rules.
    if (airborne && snapshot.guided && this.link !== undefined) {
      await this.link.send(returnToLaunchCommand(this.config.vehicleSystemId, this.config.vehicleComponentId));
      this.log("info", "Shutdown RTL requested; awaiting mode confirmation.");
      const deadline = this.now() + this.config.shutdownConfirmSeconds * 1000;
      while (this.now() < deadline) {
        if (this.snapshot().mode === "RTL") {
          this.log("info", "Shutdown RTL confirmed.");
          break;
        }
        await this.sleep(250);
      }
    }
    if (this.link !== undefined) {
      await this.link.close();
    }
    this.log("info", "Asset host stopped.");
  }

  private handleMessage(message: ReceivedMessage): void {
    const tracker = this.deps.tracker;
    const now = this.now();
    const name = (message.message.constructor as { MSG_NAME?: string }).MSG_NAME ?? "";
    switch (name) {
      case "HEARTBEAT": {
        const heartbeat = message.message as unknown as {
          customMode: number;
          baseMode: number;
          autopilot: number;
        };
        const type = (message.message as unknown as { type: number }).type;
        tracker.observeHeartbeat({
          systemId: message.sysid,
          componentId: message.compid,
          vehicleType: type,
          autopilot: heartbeat.autopilot,
          baseMode: heartbeat.baseMode,
          customMode: heartbeat.customMode,
          receivedAtMs: now
        });
        break;
      }
      case "GLOBAL_POSITION_INT": {
        const position = message.message as unknown as {
          lat: number;
          lon: number;
          alt: number;
          relativeAlt: number;
          vx: number;
          vy: number;
          vz: number;
          hdg: number;
        };
        const speedMS = Math.hypot(position.vx / 100, position.vy / 100, position.vz / 100);
        tracker.observePosition({
          latitudeDeg: position.lat / 1e7,
          longitudeDeg: position.lon / 1e7,
          altitudeMslM: position.alt / 1000,
          relativeAltitudeM: position.relativeAlt / 1000,
          groundSpeedMS: speedMS,
          headingDeg: position.hdg / 100,
          observedAtMs: now
        });
        break;
      }
      case "SYS_STATUS": {
        const status = message.message as unknown as { batteryRemaining: number };
        tracker.observeSysStatus(status.batteryRemaining === -1 ? undefined : status.batteryRemaining);
        break;
      }
      case "PARAM_VALUE": {
        const value = message.message as unknown as { paramId: string; paramValue: number };
        if (value.paramId === FS_GCS_PARAM) {
          tracker.observeGcsFailsafe(value.paramValue !== 0);
          this.gcsFailsafeChecked = true;
        }
        break;
      }
    }
  }

  private async verifyGcsFailsafe(): Promise<void> {
    if (this.link === undefined) return;
    await this.link.send(paramReadCommand(this.config.vehicleSystemId, this.config.vehicleComponentId, FS_GCS_PARAM));
    const deadline = this.now() + PARAM_VERIFY_TIMEOUT_MS;
    while (!this.gcsFailsafeChecked && this.now() < deadline && this.running) {
      await this.sleep(100);
    }
    if (!this.gcsFailsafeChecked) {
      this.log(
        "warn",
        `Could not verify ${FS_GCS_PARAM} on the aircraft; flight readiness is withheld until the failsafe state is known.`
      );
    }
  }

  private async waitForInitialState(): Promise<void> {
    // Telemetry reports from the start; flight readiness waits for a known,
    // verified vehicle, and a restarted process additionally waits for landed
    // and disarmed state before any flight work.
    while (this.running) {
      const snapshot = this.snapshot();
      const relativeAltitudeM = snapshot.observation?.relativeAltitudeM;
      if (
        !this.initiallyLandedAndDisarmed &&
        snapshot.identity !== undefined &&
        snapshot.observation !== undefined &&
        !snapshot.armed &&
        Math.abs(snapshot.observation.relativeAltitudeM) <= 0.5
      ) {
        this.initiallyLandedAndDisarmed = true;
      }
      const readiness = checkFlightReadiness(snapshot, this.config, this.now());
      const gateArgs: { initiallyLandedAndDisarmed: boolean; armed: boolean; relativeAltitudeM?: number } = {
        initiallyLandedAndDisarmed: this.initiallyLandedAndDisarmed,
        armed: snapshot.armed
      };
      if (relativeAltitudeM !== undefined) gateArgs.relativeAltitudeM = relativeAltitudeM;
      const gateOpen = flightGateOpen(gateArgs);
      if (readiness.ready && gateOpen && this.gcsFailsafeChecked) {
        await this.deps.core.ready();
        this.ready = true;
        this.log("info", "Vehicle verified; runtime ready for flight Tasks.");
        return;
      }
      for (const failure of readiness.failures) {
        this.log("warn", `Readiness: ${failure.message}`);
      }
      if (!gateOpen) {
        this.log("warn", "Restart barrier: flight readiness withheld until landed and disarmed.");
      }
      await this.reportTelemetry(snapshot);
      await this.sleep(1000);
    }
  }

  private async run(): Promise<void> {
    let lastTelemetry = 0;
    let lastHeartbeat = 0;
    let lastPoll = 0;
    while (this.running) {
      const now = this.now();
      const snapshot = this.snapshot();
      if (now - lastHeartbeat >= 1000) {
        lastHeartbeat = now;
        await this.sendGcsHeartbeat();
      }
      if (now - lastPoll >= 1000) {
        lastPoll = now;
        await this.pollCore(now);
      }
      if (now - lastTelemetry >= this.config.telemetryIntervalSeconds * 1000) {
        lastTelemetry = now;
        await this.reportTelemetry(snapshot);
      }
      if (!this.isCoreDown()) {
        await this.deps.engine.ingest(this.lastTasks, snapshot, now);
      } else {
        await this.watchCoreLossRecovery(snapshot, now);
      }
      await this.sleep(100);
    }
  }

  private async sendGcsHeartbeat(): Promise<void> {
    if (this.link === undefined) return;
    const heartbeat = new minimal.Heartbeat();
    heartbeat.type = GCS_TYPE as never;
    heartbeat.autopilot = 0 as never;
    heartbeat.baseMode = 0 as never;
    heartbeat.customMode = 0;
    heartbeat.systemStatus = 0 as never;
    heartbeat.mavlinkVersion = 3;
    try {
      await this.link.send(heartbeat);
    } catch (error) {
      this.log("warn", `GCS heartbeat send failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async pollCore(now: number): Promise<void> {
    try {
      const tasks = await this.deps.core.fetchTasks();
      if (this.coreDownSince !== undefined) {
        this.log("info", "Core reachable again; reconciling authoritative state before continuing.");
        await this.reconcileAfterReconnect(tasks, now);
      }
      this.lastTasks = toAuthoritative(tasks);
      this.coreDownSince = undefined;
    } catch (error) {
      if (this.coreDownSince === undefined) {
        this.coreDownSince = now;
        this.log("warn", `Core unreachable; new action starts stop now: ${shortError(error)}`);
      }
    }
  }

  private async reconcileAfterReconnect(tasks: TaskResource[], _now: number): Promise<void> {
    // The engine reconciles against the fresh authoritative list on its next
    // ingest. When recovery RTL already runs, reconnection leaves recovery
    // running: the interrupted action is finished locally and reported now,
    // never resumed.
    if (this.coreLossRecovery) {
      const abandoned = this.deps.engine.abandonActiveForRecovery();
      if (abandoned !== undefined) {
        try {
          await this.deps.core.reportFail(
            abandoned,
            "execution_failed",
            "Core link lost; recovery RTL started and the interrupted action was not resumed."
          );
        } catch (error) {
          this.log("warn", `Could not report interrupted task: ${shortError(error)}`);
        }
      } else {
        this.log("info", "Recovery RTL already runs; the interrupted action is not resumed.");
      }
      this.coreLossRecovery = false;
    }
    void tasks;
  }

  private async watchCoreLossRecovery(snapshot: VehicleSnapshot, now: number): Promise<void> {
    const downMs = now - (this.coreDownSince ?? now);
    const shouldRecover = shouldRequestCoreLossRecovery({
      downMs,
      graceMs: this.config.coreLossGraceSeconds * 1000,
      guided: snapshot.guided,
      activeCommand: this.deps.engine.activeCommand(),
      recoveryRunning: this.coreLossRecovery
    });
    if (!shouldRecover || this.link === undefined) return;
    try {
      await this.link.send(returnToLaunchCommand(this.config.vehicleSystemId, this.config.vehicleComponentId));
    } catch (error) {
      this.log("warn", `Core-loss RTL send failed: ${shortError(error)}`);
      return;
    }
    this.coreLossRecovery = true;
    this.log("warn", "Core-loss grace expired under Atlas control; recovery RTL requested.");
  }

  private async reportTelemetry(snapshot: VehicleSnapshot): Promise<void> {
    const telemetry: FlightTelemetry = { armed: snapshot.armed };
    if (snapshot.customMode !== undefined) telemetry.flightMode = snapshot.mode;
    if (snapshot.launchElevationVerified && snapshot.launchElevationM !== undefined) {
      telemetry.launchElevationM = snapshot.launchElevationM;
    }
    if (snapshot.observation !== undefined) {
      telemetry.position = {
        latitude: snapshot.observation.latitudeDeg,
        longitude: snapshot.observation.longitudeDeg,
        altitudeMslM: snapshot.observation.altitudeMslM,
        speedMS: snapshot.observation.groundSpeedMS,
        headingDeg: snapshot.observation.headingDeg
      };
    }
    try {
      await this.deps.core.checkin(telemetry);
    } catch (error) {
      if (this.coreDownSince === undefined) {
        this.coreDownSince = this.now();
      }
      this.log("warn", `Telemetry check-in failed: ${shortError(error)}`);
    }
  }
}

function toAuthoritative(tasks: TaskResource[]): AuthoritativeTask[] {
  return tasks.map((task) => {
    const authoritative: AuthoritativeTask = {
      taskId: task.task_id,
      command: task.command,
      status: task.status as AuthoritativeTask["status"],
      input: (task.input ?? {}) as Record<string, unknown>
    };
    if (task.cancellation !== undefined) authoritative.cancellationCode = task.cancellation.code;
    return authoritative;
  });
}

function shortError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
