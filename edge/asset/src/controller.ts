import type { TaskResource } from "@the-drunken-coder/atlas-sdk";
import { common, minimal } from "node-mavlink";
import { paramReadCommand, returnToLaunchCommand } from "./commands.js";
import type { AssetConfig } from "./config.js";
import type { CoreGateway } from "./core-client.js";
import { type FlightTelemetry } from "./core-client.js";
import { type MavLink, type ReceivedMessage } from "./mavlink-link.js";
import { checkFlightReadiness } from "./readiness.js";
import type { TaskEngine } from "./task-engine.js";
import { type AuthoritativeTask } from "./task-engine.js";
import { hasFreshControlTelemetry, type VehicleSnapshot, VehicleTracker } from "./vehicle.js";

type HeartbeatMessage = InstanceType<typeof minimal.Heartbeat>;
type GlobalPositionMessage = InstanceType<typeof common.GlobalPositionInt>;
type SysStatusMessage = InstanceType<typeof common.SysStatus>;
type ParamValueMessage = InstanceType<typeof common.ParamValue>;

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
  return snapshot.relativeAltitudeM !== undefined && Math.abs(snapshot.relativeAltitudeM) <= 0.5;
}

export function shouldRequestCoreLossRecovery(args: {
  downMs: number;
  graceMs: number;
  guided: boolean;
  activeCommand: "flight.takeoff" | "flight.goto" | "flight.return_to_launch" | "flight.land" | undefined;
  recoveryRunning: boolean;
  telemetryFresh: boolean;
}): boolean {
  if (args.recoveryRunning) return false;
  // After the grace period, request RTL while Atlas has control (Guided),
  // including idle hold. Preserve an ongoing landing or RTL. Never override
  // manual flight.
  if (args.activeCommand === "flight.land" || args.activeCommand === "flight.return_to_launch") return false;
  if (!args.guided || !args.telemetryFresh) return false;
  return args.downMs >= args.graceMs;
}

export function isConfiguredVehicleMessage(
  config: Pick<AssetConfig, "vehicleSystemId" | "vehicleComponentId">,
  message: Pick<ReceivedMessage, "sysid" | "compid">
): boolean {
  return message.sysid === config.vehicleSystemId && message.compid === config.vehicleComponentId;
}

export function flightTelemetryForCheckin(snapshot: VehicleSnapshot, nowMs: number): FlightTelemetry | undefined {
  if (!hasFreshControlTelemetry(snapshot, nowMs)) return undefined;
  const telemetry: FlightTelemetry = { armed: snapshot.armed };
  if (snapshot.batteryRemainingPercent !== undefined) {
    telemetry.batteryRemainingPercent = snapshot.batteryRemainingPercent;
  }
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
  return telemetry;
}

const GCS_TYPE = minimal.MavType.GCS;
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
  private recoveryTaskToFail: string | undefined;
  private telemetryStale = false;
  private shutdownPromise: Promise<void> | undefined;

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
    // A signal can arrive while the transport is opening, before shutdown has
    // a link to close. Close the newly opened link instead of continuing.
    if (!this.running) {
      await this.link.close();
      return;
    }
    this.log("info", `MAVLink link open: ${this.link.describe()}`);
    this.link.onMessage((message) => {
      this.handleMessage(message);
    });

    await this.deps.core.begin();
    if (!this.running) return;
    this.log("info", `Runtime registered for ${this.config.assetId}; verifying vehicle before readiness.`);
    await this.verifyGcsFailsafe();
    if (!this.running) return;
    await this.waitForInitialState();
    if (!this.running) return;
    await this.run();
  }

  shutdown(): Promise<void> {
    this.shutdownPromise ??= this.performShutdown();
    return this.shutdownPromise;
  }

  private async performShutdown(): Promise<void> {
    this.running = false;
    const snapshot = this.snapshot();
    const airborne = snapshot.armed || Math.abs(snapshot.observation?.relativeAltitudeM ?? 0) > 0.5;
    // Graceful shutdown requests RTL when airborne under Atlas control and
    // briefly awaits mode confirmation. Ongoing RTL, landing, or manual
    // control is preserved: exiting never interrupts those actions. The
    // runtime registration is intentionally left for the next process, whose
    // fresh identity drains stale work through the normal fencing rules.
    let failed = false;
    let failure: unknown;
    try {
      if (
        airborne &&
        snapshot.guided &&
        hasFreshControlTelemetry(snapshot, this.now()) &&
        this.link?.status().state === "open"
      ) {
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
    } catch (error) {
      failed = true;
      failure = error;
    }
    try {
      await this.link?.close();
    } catch (error) {
      if (!failed) {
        failed = true;
        failure = error;
      } else {
        this.log("warn", `MAVLink close also failed: ${shortError(error)}`);
      }
    }
    this.log("info", "Asset host stopped.");
    if (failed) throw failure;
  }

  private handleMessage(message: ReceivedMessage): void {
    if (!isConfiguredVehicleMessage(this.config, message)) return;
    const tracker = this.deps.tracker;
    const now = this.now();
    const name = (message.message.constructor as { MSG_NAME?: string }).MSG_NAME ?? "";
    switch (name) {
      case "HEARTBEAT": {
        const heartbeat = message.message as HeartbeatMessage;
        tracker.observeHeartbeat({
          systemId: message.sysid,
          componentId: message.compid,
          vehicleType: heartbeat.type,
          autopilot: heartbeat.autopilot,
          baseMode: heartbeat.baseMode,
          customMode: heartbeat.customMode,
          receivedAtMs: now
        });
        break;
      }
      case "GLOBAL_POSITION_INT": {
        const position = message.message as GlobalPositionMessage;
        const speedMS = Math.hypot(position.vx / 100, position.vy / 100, position.vz / 100);
        // MAVLink uses 65535 for unknown heading; Atlas heading_deg requires [0, 360).
        const headingDeg = position.hdg === 65535 ? 0 : (position.hdg / 100) % 360;
        tracker.observePosition({
          latitudeDeg: position.lat / 1e7,
          longitudeDeg: position.lon / 1e7,
          altitudeMslM: position.alt / 1000,
          relativeAltitudeM: position.relativeAlt / 1000,
          groundSpeedMS: speedMS,
          headingDeg,
          observedAtMs: now
        });
        break;
      }
      case "SYS_STATUS": {
        const status = message.message as SysStatusMessage;
        tracker.observeSysStatus(status.batteryRemaining === -1 ? undefined : status.batteryRemaining);
        break;
      }
      case "PARAM_VALUE": {
        const value = message.message as ParamValueMessage;
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
      this.assertLinkHealthy();
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
      this.assertLinkHealthy();
      const snapshot = this.snapshot();
      const relativeAltitudeM = snapshot.observation?.relativeAltitudeM;
      if (
        !this.initiallyLandedAndDisarmed &&
        !snapshot.armed &&
        relativeAltitudeM !== undefined &&
        Math.abs(relativeAltitudeM) <= 0.5
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
      this.assertLinkHealthy();
      const now = this.now();
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
        await this.reportTelemetry(this.snapshot());
      }
      // Polling and check-in are network awaits. Re-read aircraft state and
      // time so execution never acts on the pre-await authority snapshot.
      const controlNow = this.now();
      const controlSnapshot = this.snapshot();
      if (!this.isCoreDown()) {
        try {
          await this.deps.engine.ingest(this.lastTasks, controlSnapshot, controlNow);
        } catch (error) {
          if (this.coreDownSince === undefined) this.coreDownSince = controlNow;
          this.log("warn", `Task reconciliation paused after an execution report failed: ${shortError(error)}`);
        }
      } else {
        await this.watchCoreLossRecovery(controlSnapshot, controlNow);
      }
      await this.sleep(100);
    }
  }

  private async sendGcsHeartbeat(): Promise<void> {
    if (this.link === undefined) return;
    const heartbeat = new minimal.Heartbeat();
    heartbeat.type = GCS_TYPE;
    heartbeat.autopilot = 0;
    heartbeat.baseMode = 0 as never;
    heartbeat.customMode = 0;
    heartbeat.systemStatus = 0;
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
      const reconciliationTaskId = this.deps.engine.reconciliationTaskId() ?? this.recoveryTaskToFail;
      if (reconciliationTaskId !== undefined && !tasks.some((task) => task.task_id === reconciliationTaskId)) {
        tasks.push(await this.deps.core.getTask(reconciliationTaskId));
      }
      if (this.coreDownSince !== undefined) {
        this.log("info", "Core reachable again; reconciling authoritative state before continuing.");
        await this.reconcileAfterReconnect(tasks);
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

  private async reconcileAfterReconnect(tasks: TaskResource[]): Promise<void> {
    // The engine reconciles against the fresh authoritative list on its next
    // ingest. When recovery RTL already runs, reconnection leaves recovery
    // running: the interrupted action is finished locally and reported now,
    // never resumed.
    if (this.coreLossRecovery) {
      this.recoveryTaskToFail ??= this.deps.engine.abandonActiveForRecovery();
      if (this.recoveryTaskToFail !== undefined) {
        const recoveryTask = tasks.find((task) => task.task_id === this.recoveryTaskToFail);
        if (
          recoveryTask?.status !== "completed" &&
          recoveryTask?.status !== "failed" &&
          recoveryTask?.status !== "cancelled"
        ) {
          await this.deps.core.reportFail(
            this.recoveryTaskToFail,
            "execution_failed",
            "Core link lost; recovery RTL started and the interrupted action was not resumed."
          );
        }
        this.recoveryTaskToFail = undefined;
      } else {
        this.log("info", "Recovery RTL already runs; the interrupted action is not resumed.");
      }
      this.coreLossRecovery = false;
    }
  }

  private async watchCoreLossRecovery(snapshot: VehicleSnapshot, now: number): Promise<void> {
    const downMs = now - (this.coreDownSince ?? now);
    const shouldRecover = shouldRequestCoreLossRecovery({
      downMs,
      graceMs: this.config.coreLossGraceSeconds * 1000,
      guided: snapshot.guided,
      activeCommand: this.deps.engine.activeCommand(),
      recoveryRunning: this.coreLossRecovery,
      telemetryFresh: hasFreshControlTelemetry(snapshot, now)
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
    const telemetry = flightTelemetryForCheckin(snapshot, this.now());
    if (telemetry === undefined) {
      if (!this.telemetryStale) {
        this.telemetryStale = true;
        this.log("warn", "Aircraft control telemetry is stale; Core check-ins are paused until MAVLink recovers.");
      }
      return;
    }
    if (this.telemetryStale) {
      this.telemetryStale = false;
      this.log("info", "Aircraft control telemetry is fresh again; Core check-ins resumed.");
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

  private assertLinkHealthy(): void {
    const status = this.link?.status();
    if (status?.state === "failed") throw status.error;
    if (status?.state === "closed") throw new Error("MAVLink link closed while the Asset host was running.");
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
