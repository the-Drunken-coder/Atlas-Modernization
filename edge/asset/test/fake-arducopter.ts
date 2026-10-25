import { createServer, type Server, type Socket } from "node:net";
import {
  ardupilotmega,
  common,
  MavLinkPacketParser,
  MavLinkPacketSplitter,
  MavLinkProtocolV2,
  minimal,
  send as sendMavlink
} from "node-mavlink";

/**
 * Minimal fake ArduCopter for host integration tests. Speaks real MAVLink v2
 * bytes over TCP (the same framing the host uses for the serial SiK link) and
 * simulates guided flight: takeoff climb, position travel, RTL return, land
 * descend, and disarm. It is a test vehicle, not a physics model.
 */
export type FakeVehicleState = {
  latitudeDeg: number;
  longitudeDeg: number;
  altitudeMslM: number;
  launchElevationM: number;
  armed: boolean;
  customMode: number;
  batteryRemaining: number;
};

export class FakeArduCopter {
  private server?: Server;
  private socket?: Socket;
  private timer?: NodeJS.Timeout;
  private readonly protocol = new MavLinkProtocolV2(1, 1);
  readonly state: FakeVehicleState;
  private target: { latitudeDeg: number; longitudeDeg: number; altitudeMslM: number } | undefined;
  private takeoffTarget: number | undefined;

  constructor(initial?: Partial<FakeVehicleState>) {
    this.state = {
      latitudeDeg: 37.7749,
      longitudeDeg: -122.4194,
      altitudeMslM: 560,
      launchElevationM: 560,
      armed: false,
      customMode: lookup(ardupilotmega.CopterMode as unknown as Record<string, number>, "GUIDED"),
      batteryRemaining: 95,
      ...initial
    };
  }

  async listen(): Promise<number> {
    this.server = createServer((socket) => {
      this.socket = socket;
      const packets = socket.pipe(new MavLinkPacketSplitter()).pipe(new MavLinkPacketParser());
      packets.on("data", (packet) => {
        this.handlePacket(packet).catch(() => {});
      });
    });
    await new Promise<void>((resolve) => this.server?.listen(0, "127.0.0.1", resolve));
    const address = this.server?.address();
    if (typeof address !== "object" || address === null) throw new Error("fake vehicle did not bind");
    this.timer = setInterval(() => {
      this.tick(0.05).catch(() => {});
    }, 50);
    return address.port;
  }

  async close(): Promise<void> {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.socket?.destroy();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  arm(): void {
    this.state.armed = true;
  }

  disarm(): void {
    this.state.armed = false;
  }

  private async handlePacket(packet: {
    header: { sysid: number; compid: number; msgid: number };
    payload: Buffer;
  }): Promise<void> {
    const registry = {
      ...minimal.REGISTRY,
      ...common.REGISTRY,
      ...ardupilotmega.REGISTRY
    };
    const clazz = registry[packet.header.msgid];
    if (clazz === undefined || this.socket === undefined) return;
    const message = this.protocol.data(packet.payload, clazz) as { constructor: { MSG_NAME?: string } } & Record<
      string,
      number | string
    >;
    const name = (message.constructor as { MSG_NAME?: string }).MSG_NAME ?? "";
    if (name === "COMMAND_LONG") {
      await this.handleCommand(message);
    } else if (name === "SET_POSITION_TARGET_GLOBAL_INT") {
      this.target = {
        latitudeDeg: Number(message["latInt"]) / 1e7,
        longitudeDeg: Number(message["lonInt"]) / 1e7,
        altitudeMslM: Number(message["alt"])
      };
      this.takeoffTarget = undefined;
      await this.ack(message, 1);
    } else if (name === "PARAM_REQUEST_READ") {
      await this.sendParam(message["paramId"] as string);
    }
  }

  private async handleCommand(message: Record<string, number | string>): Promise<void> {
    const commands = common.MavCmd as unknown as Record<string, number>;
    const modes = ardupilotmega.CopterMode as unknown as Record<string, number>;
    const command = Number(message["command"]);
    if (command === lookup(commands, "NAV_TAKEOFF")) {
      if (!this.state.armed || this.state.customMode !== lookup(modes, "GUIDED")) {
        await this.ack(message, 4);
        return;
      }
      // ArduCopter Guided takeoff param7 is height above home.
      this.takeoffTarget = this.state.launchElevationM + Number(message["_param7"]);
      this.target = undefined;
      await this.ack(message, 1);
    } else if (command === lookup(commands, "NAV_RETURN_TO_LAUNCH")) {
      this.state.customMode = lookup(modes, "RTL");
      this.target = {
        latitudeDeg: 37.7749,
        longitudeDeg: -122.4194,
        altitudeMslM: this.state.launchElevationM
      };
      this.takeoffTarget = undefined;
      await this.ack(message, 1);
    } else if (command === lookup(commands, "NAV_LAND")) {
      this.state.customMode = lookup(modes, "LAND");
      this.target = {
        latitudeDeg: this.state.latitudeDeg,
        longitudeDeg: this.state.longitudeDeg,
        altitudeMslM: this.state.launchElevationM
      };
      this.takeoffTarget = undefined;
      await this.ack(message, 1);
    } else if (command === lookup(commands, "DO_SET_MODE")) {
      this.state.customMode = Number(message["_param2"]);
      await this.ack(message, 1);
    } else {
      await this.ack(message, 1);
    }
  }

  private async ack(command: Record<string, number | string>, result: number): Promise<void> {
    if (this.socket === undefined) return;
    const ack = new common.CommandAck();
    ack.command = Number(command["command"]);
    ack.result = result as never;
    await sendMavlink(this.socket, ack, new MavLinkProtocolV2(1, 1));
  }

  private async sendParam(paramId: string): Promise<void> {
    if (this.socket === undefined) return;
    const value = new common.ParamValue();
    value.paramId = paramId;
    value.paramValue = paramId === "FS_GCS_ENABLE" ? 1 : 0;
    value.paramCount = 1;
    value.paramIndex = 0;
    value.paramType = 9;
    await sendMavlink(this.socket, value, new MavLinkProtocolV2(1, 1));
  }

  private async tick(dtSeconds: number): Promise<void> {
    if (this.socket === undefined || this.socket.destroyed) return;
    const modes = ardupilotmega.CopterMode as unknown as Record<string, number>;
    const guidedMode = lookup(modes, "GUIDED");
    const rtlMode = lookup(modes, "RTL");
    const landMode = lookup(modes, "LAND");
    const climbRate = 5;
    const cruiseRate = 10;
    const guided = this.state.customMode === guidedMode;

    if (this.takeoffTarget !== undefined && guided && this.state.armed) {
      const error = this.takeoffTarget - this.state.altitudeMslM;
      const step = Math.sign(error) * Math.min(Math.abs(error), climbRate * dtSeconds);
      this.state.altitudeMslM += step;
    } else if (this.target !== undefined && this.state.armed) {
      const dLat = (this.target.latitudeDeg - this.state.latitudeDeg) * 111_320;
      const dLon =
        (this.target.longitudeDeg - this.state.longitudeDeg) *
        111_320 *
        Math.cos((this.state.latitudeDeg * Math.PI) / 180);
      const horizontal = Math.hypot(dLat, dLon);
      const vertical = this.target.altitudeMslM - this.state.altitudeMslM;
      if (this.state.customMode === rtlMode || this.state.customMode === landMode) {
        // Descend toward the ground, then disarm on touchdown.
        if (horizontal > 1) {
          const step = Math.min(horizontal, cruiseRate * dtSeconds);
          this.state.latitudeDeg += ((this.target.latitudeDeg - this.state.latitudeDeg) * step) / horizontal;
          this.state.longitudeDeg += ((this.target.longitudeDeg - this.state.longitudeDeg) * step) / horizontal;
        } else {
          this.state.altitudeMslM += Math.sign(vertical) * Math.min(Math.abs(vertical), 2 * dtSeconds);
          if (Math.abs(this.state.altitudeMslM - this.state.launchElevationM) < 0.1) {
            this.state.altitudeMslM = this.state.launchElevationM;
            this.state.armed = false;
            this.state.customMode = guidedMode;
            this.target = undefined;
          }
        }
      } else if (guided) {
        const distance = Math.hypot(horizontal, vertical);
        if (distance > 0.05) {
          const step = Math.min(distance, cruiseRate * dtSeconds);
          this.state.latitudeDeg += ((this.target.latitudeDeg - this.state.latitudeDeg) * step) / distance;
          this.state.longitudeDeg += ((this.target.longitudeDeg - this.state.longitudeDeg) * step) / distance;
          this.state.altitudeMslM += ((this.target.altitudeMslM - this.state.altitudeMslM) * step) / distance;
        }
      }
    }
    await this.sendTelemetry();
  }

  private async sendTelemetry(): Promise<void> {
    if (this.socket === undefined) return;
    const protocol = new MavLinkProtocolV2(1, 1);
    const heartbeat = new minimal.Heartbeat();
    heartbeat.type = lookup(minimal.MavType as unknown as Record<string, number>, "QUADROTOR") as never;
    heartbeat.autopilot = lookup(minimal.MavAutopilot as unknown as Record<string, number>, "ARDUPILOTMEGA") as never;
    heartbeat.baseMode = (this.state.armed ? 128 : 0) as never;
    heartbeat.customMode = this.state.customMode;
    heartbeat.systemStatus = 4 as never;
    heartbeat.mavlinkVersion = 3;
    await sendMavlink(this.socket, heartbeat, protocol);

    const position = new common.GlobalPositionInt();
    position.timeBootMs = 0;
    position.lat = Math.round(this.state.latitudeDeg * 1e7);
    position.lon = Math.round(this.state.longitudeDeg * 1e7);
    position.alt = Math.round(this.state.altitudeMslM * 1000);
    position.relativeAlt = Math.round((this.state.altitudeMslM - this.state.launchElevationM) * 1000);
    position.vx = 0;
    position.vy = 0;
    position.vz = 0;
    position.hdg = 9000;
    await sendMavlink(this.socket, position, protocol);

    const status = new common.SysStatus();
    status.batteryRemaining = this.state.batteryRemaining as never;
    await sendMavlink(this.socket, status, protocol);
  }
}

function lookup(table: Record<string, number>, key: string): number {
  const value = table[key];
  if (value === undefined) throw new Error(`Missing MAVLink constant ${key}`);
  return value;
}
