import type { Duplex } from "node:stream";
import {
  ardupilotmega,
  common,
  createMavLinkStream,
  MavLinkData,
  MavLinkPacket,
  MavLinkProtocolV2,
  minimal,
  send as sendMavlink,
  standard
} from "node-mavlink";

export type { MavLinkData };

const PACKET_REGISTRY = {
  ...minimal.REGISTRY,
  ...standard.REGISTRY,
  ...common.REGISTRY,
  ...ardupilotmega.REGISTRY
};

export type ReceivedMessage = {
  sysid: number;
  compid: number;
  msgid: number;
  message: MavLinkData;
};

export function decodePacket(packet: MavLinkPacket): ReceivedMessage | undefined {
  const clazz = PACKET_REGISTRY[packet.header.msgid];
  if (clazz === undefined) return undefined;
  return {
    sysid: packet.header.sysid,
    compid: packet.header.compid,
    msgid: packet.header.msgid,
    message: packet.protocol.data(packet.payload, clazz)
  };
}

export type MessageHandler = (message: ReceivedMessage) => void;

export type MavLinkStatus = { state: "open" } | { state: "closed" } | { state: "failed"; error: Error };

/**
 * MAVLink v2 link over any duplex byte stream (serial SiK radio or TCP for
 * simulation). The same framing and message handling serves both transports;
 * simulation never bypasses the behavior under test with a fake executor.
 */
export class MavLink {
  private readonly protocol: MavLinkProtocolV2;
  private readonly handlers = new Set<MessageHandler>();
  private closed = false;
  private failure: Error | undefined;

  constructor(
    private readonly stream: Duplex,
    sysid: number,
    compid: number,
    private readonly label: string
  ) {
    this.protocol = new MavLinkProtocolV2(sysid, compid);
    stream.on("error", (error: Error) => this.recordFailure(error, "transport"));
    stream.on("close", () => {
      this.closed = true;
    });
    const packets = createMavLinkStream(stream);
    packets.on("error", (error: Error) => this.recordFailure(error, "packet parser"));
    packets.on("data", (packet: MavLinkPacket) => {
      let decoded: ReceivedMessage | undefined;
      try {
        decoded = decodePacket(packet);
      } catch {
        return;
      }
      if (decoded === undefined) return;
      for (const handler of this.handlers) handler(decoded);
    });
  }

  onMessage(handler: MessageHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  async send(message: MavLinkData): Promise<void> {
    this.throwIfUnavailable();
    try {
      await sendMavlink(this.stream, message, this.protocol);
    } catch (error) {
      this.recordFailure(asError(error), "send");
      this.throwIfUnavailable();
    }
  }

  describe(): string {
    return this.label;
  }

  status(): MavLinkStatus {
    if (this.failure !== undefined) return { state: "failed", error: this.failure };
    if (this.closed) return { state: "closed" };
    return { state: "open" };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.stream.destroy();
  }

  private recordFailure(error: Error, source: string): void {
    if (this.failure !== undefined) return;
    this.failure = new Error(`MAVLink ${this.label} ${source} failed: ${error.message}`, { cause: error });
  }

  private throwIfUnavailable(): void {
    if (this.failure !== undefined) throw this.failure;
    if (this.closed) throw new Error(`MAVLink ${this.label} is closed`);
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/** Open the production serial SiK radio link (macOS device path). */
export async function openSerialLink(port: string, baud: number, sysid: number, compid: number): Promise<MavLink> {
  const { SerialPort } = await import("serialport");
  const stream = new SerialPort({ path: port, baudRate: baud, autoOpen: false });
  await new Promise<void>((resolve, reject) => {
    stream.open((error) => {
      if (error) reject(new Error(`Cannot open serial port ${port}: ${error.message}`));
      else resolve();
    });
  });
  return new MavLink(stream, sysid, compid, `serial ${port}@${baud}`);
}

/** Open a TCP MAVLink link. Used for ArduCopter SITL simulation. */
export async function openTcpLink(host: string, port: number, sysid: number, compid: number): Promise<MavLink> {
  const { Socket } = await import("node:net");
  const socket = new Socket();
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.connect(port, host, () => {
      socket.off("error", reject);
      resolve();
    });
  });
  return new MavLink(socket, sysid, compid, `tcp ${host}:${port}`);
}
