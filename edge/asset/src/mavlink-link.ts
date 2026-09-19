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

/**
 * MAVLink v2 link over any duplex byte stream (serial SiK radio or TCP for
 * simulation). The same framing and message handling serves both transports;
 * simulation never bypasses the behavior under test with a fake executor.
 */
export class MavLink {
  private readonly protocol: MavLinkProtocolV2;
  private readonly handlers = new Set<MessageHandler>();

  constructor(
    private readonly stream: Duplex,
    sysid: number,
    compid: number,
    private readonly label: string
  ) {
    this.protocol = new MavLinkProtocolV2(sysid, compid);
    this.stream.on("error", () => {});
    const packets = createMavLinkStream(stream);
    packets.on("error", () => {});
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
    await sendMavlink(this.stream, message, this.protocol);
  }

  describe(): string {
    return this.label;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.stream.destroy();
      resolve();
    });
  }
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
