import type { VirtualClock } from "./clock.js";
import { decodeFrame } from "./frame.js";
import type { LinkRadio, RadioPacket, RadioSendOptions } from "./radio.js";
import type { LinkMessageType, MessagePriority } from "./types.js";

export type ModemProfile = {
  name: string;
  bandwidth_khz: number;
  spreading_factor: number;
  coding_rate_denominator: number;
  preamble_symbols: number;
  mesh_overhead_bytes: number;
};

export const SHORT_FAST_MODEM: ModemProfile = {
  name: "SHORT_FAST",
  bandwidth_khz: 250,
  spreading_factor: 7,
  coding_rate_denominator: 5,
  preamble_symbols: 8,
  mesh_overhead_bytes: 32
};

export type PacketNetworkOptions = {
  seed: number;
  clock: VirtualClock;
  modem?: ModemProfile;
  hopLimit?: number;
  packetLoss?: number;
  duplicateChance?: number;
  propagationDelayMs?: number;
  relayDelayMs?: number;
  contentionWindowAirtimes?: number;
  carrierSense?: boolean;
};

export type PacketNetworkMetrics = {
  radio_submissions: number;
  mesh_transmissions: number;
  transmitted_bytes: number;
  modeled_airtime_ms: number;
  delivered_packets: number;
  lost_packets: number;
  collided_packets: number;
  duplicate_deliveries: number;
  modeled_airtime_ms_by_message_type: Record<LinkMessageType | "non_link", number>;
  modeled_airtime_ms_by_priority: Record<MessagePriority | "non_link", number>;
};

type ReceiveWindow = {
  start: number;
  end: number;
  collided: boolean;
  packetID: number;
};

type MediumWindow = {
  start: number;
  end: number;
  packetID?: number;
};

type MeshPacket = {
  id: number;
  source: SimulatedRadio;
  payload: Uint8Array;
  channel: number;
  destinationRadioNode?: number;
  publicKeyEncrypted: boolean;
  airtime: number;
  forwarded: Set<string>;
  delivered: Set<string>;
};

export class SimulatedPacketNetwork {
  private readonly clock: VirtualClock;
  private readonly modem: ModemProfile;
  private readonly hopLimit: number;
  private readonly packetLoss: number;
  private readonly duplicateChance: number;
  private readonly propagationDelayMs: number;
  private readonly relayDelayMs: number;
  private readonly contentionWindowAirtimes: number;
  private readonly carrierSense: boolean;
  private readonly random: () => number;
  private readonly radios = new Map<string, SimulatedRadio>();
  private readonly edges = new Map<string, Set<string>>();
  private readonly radioFreeAt = new Map<string, number>();
  private readonly carrierWindows = new Map<string, MediumWindow[]>();
  private readonly transmitWindows = new Map<string, MediumWindow[]>();
  private readonly receiveWindows = new Map<string, ReceiveWindow[]>();
  private nextPacketID = 0;
  private readonly mutableMetrics: PacketNetworkMetrics = {
    radio_submissions: 0,
    mesh_transmissions: 0,
    transmitted_bytes: 0,
    modeled_airtime_ms: 0,
    delivered_packets: 0,
    lost_packets: 0,
    collided_packets: 0,
    duplicate_deliveries: 0,
    modeled_airtime_ms_by_message_type: emptyMessageTypeCounter(),
    modeled_airtime_ms_by_priority: emptyPriorityCounter()
  };

  constructor(options: PacketNetworkOptions) {
    this.clock = options.clock;
    this.modem = options.modem ?? SHORT_FAST_MODEM;
    this.hopLimit = boundedInteger(options.hopLimit ?? 3, 1, 7, "hop limit");
    this.packetLoss = probability(options.packetLoss ?? 0, "packet loss");
    this.duplicateChance = probability(options.duplicateChance ?? 0, "duplicate chance");
    this.propagationDelayMs = nonNegative(options.propagationDelayMs ?? 2, "propagation delay");
    this.relayDelayMs = nonNegative(options.relayDelayMs ?? 20, "relay delay");
    this.contentionWindowAirtimes = nonNegative(options.contentionWindowAirtimes ?? 4, "contention window airtimes");
    this.carrierSense = options.carrierSense ?? true;
    this.random = seededRandom(options.seed);
  }

  addRadio(id: string, radioNodeNumber?: number): SimulatedRadio {
    if (!id || this.radios.has(id)) throw new Error(`simulated radio ${id || "<empty>"} already exists or is invalid`);
    const nodeNumber = radioNodeNumber ?? this.radios.size + 1;
    if ([...this.radios.values()].some((radio) => radio.radioNodeNumber === nodeNumber)) {
      throw new Error(`simulated radio node number ${nodeNumber} already exists`);
    }
    const radio = new SimulatedRadio(this, id, nodeNumber);
    this.radios.set(id, radio);
    this.edges.set(id, new Set());
    return radio;
  }

  connect(left: string, right: string): void {
    const leftEdges = this.edges.get(left);
    const rightEdges = this.edges.get(right);
    if (!leftEdges || !rightEdges || left === right)
      throw new Error("simulated links require two distinct known radios");
    leftEdges.add(right);
    rightEdges.add(left);
  }

  disconnect(left: string, right: string): void {
    this.edges.get(left)?.delete(right);
    this.edges.get(right)?.delete(left);
  }

  metrics(): PacketNetworkMetrics {
    return structuredClone(this.mutableMetrics);
  }

  airtimeMs(applicationBytes: number): number {
    return loraAirtimeMs(applicationBytes + this.modem.mesh_overhead_bytes, this.modem);
  }

  transmit(sourceID: string, payload: Uint8Array, options: RadioSendOptions): number {
    const source = this.radios.get(sourceID);
    if (!source) throw new Error(`unknown simulated source radio ${sourceID}`);
    const airtime = this.airtimeMs(payload.byteLength);
    this.mutableMetrics.radio_submissions++;
    const packet: MeshPacket = {
      id: this.nextPacketID++,
      source,
      payload: payload.slice(),
      channel: options.channel,
      ...(options.destination_radio_node === undefined ? {} : { destinationRadioNode: options.destination_radio_node }),
      publicKeyEncrypted: options.require_public_key === true,
      airtime,
      forwarded: new Set([sourceID]),
      delivered: new Set([sourceID])
    };
    const start = this.reserveTransmission(sourceID, this.clock.now(), airtime, packet.id);
    this.clock.schedule(start - this.clock.now(), () => this.transmitHop(packet, source, 0, start));
    return start + airtime + this.propagationDelayMs - this.clock.now();
  }

  private reserveTransmission(radioID: string, earliest: number, airtime: number, packetID: number): number {
    let start = Math.max(earliest, this.radioFreeAt.get(radioID) ?? 0);
    if (this.carrierSense) start = this.nextCarrierFreeStart(radioID, start, airtime);
    start += this.random() * airtime * this.contentionWindowAirtimes;
    if (this.carrierSense) start = this.nextCarrierFreeStart(radioID, start, airtime);
    const window = { start, end: start + airtime, packetID };
    this.radioFreeAt.set(radioID, window.end);
    this.addMediumWindow(this.transmitWindows, radioID, window);
    this.addMediumWindow(this.carrierWindows, radioID, window);
    for (const neighbor of this.edges.get(radioID) ?? []) {
      this.addMediumWindow(this.carrierWindows, neighbor, {
        start: window.start + this.propagationDelayMs,
        end: window.end + this.propagationDelayMs
      });
    }
    for (const receive of this.receiveWindows.get(radioID) ?? []) {
      if (overlaps(window, receive)) receive.collided = true;
    }
    return start;
  }

  private nextCarrierFreeStart(radioID: string, earliest: number, airtime: number): number {
    const windows = (this.carrierWindows.get(radioID) ?? []).filter((window) => window.end > this.clock.now());
    this.carrierWindows.set(radioID, windows);
    let start = earliest;
    for (const window of windows.sort((left, right) => left.start - right.start || left.end - right.end)) {
      if (window.start >= start + airtime) break;
      if (window.end > start) start = window.end;
    }
    return start;
  }

  private addMediumWindow(target: Map<string, MediumWindow[]>, radioID: string, window: MediumWindow): void {
    const windows = (target.get(radioID) ?? []).filter((candidate) => candidate.end > this.clock.now());
    windows.push(window);
    target.set(radioID, windows);
  }

  private transmitHop(packet: MeshPacket, transmitter: SimulatedRadio, hops: number, start: number): void {
    this.mutableMetrics.mesh_transmissions++;
    this.mutableMetrics.transmitted_bytes += packet.payload.byteLength;
    this.mutableMetrics.modeled_airtime_ms += packet.airtime;
    const traffic = classifyTraffic(packet.payload);
    this.mutableMetrics.modeled_airtime_ms_by_message_type[traffic.messageType] += packet.airtime;
    this.mutableMetrics.modeled_airtime_ms_by_priority[traffic.priority] += packet.airtime;
    for (const neighborID of [...(this.edges.get(transmitter.id) ?? [])].sort()) {
      const neighbor = this.radios.get(neighborID);
      if (!neighbor) continue;
      this.scheduleReception(packet, neighbor, hops + 1, start + this.propagationDelayMs);
    }
  }

  private scheduleReception(packet: MeshPacket, destination: SimulatedRadio, hops: number, start: number): void {
    if (this.random() < this.packetLoss) {
      this.mutableMetrics.lost_packets++;
      return;
    }
    const window: ReceiveWindow = { start, end: start + packet.airtime, collided: false, packetID: packet.id };
    const windows = this.receiveWindows.get(destination.id) ?? [];
    for (const current of windows) {
      if (current.packetID !== window.packetID && overlaps(current, window)) {
        if (current.start === window.start) {
          current.collided = true;
          window.collided = true;
        } else if (current.start < window.start) {
          window.collided = true;
        } else {
          current.collided = true;
        }
      }
    }
    if (
      (this.transmitWindows.get(destination.id) ?? []).some(
        (transmit) => transmit.packetID !== window.packetID && overlaps(transmit, window)
      )
    ) {
      window.collided = true;
    }
    windows.push(window);
    this.receiveWindows.set(destination.id, windows);
    this.clock.schedule(Math.max(0, window.end - this.clock.now()), () => {
      const active = this.receiveWindows.get(destination.id);
      if (active) {
        const index = active.indexOf(window);
        if (index >= 0) active.splice(index, 1);
      }
      if (window.collided) {
        this.mutableMetrics.collided_packets++;
        return;
      }
      if (!packet.delivered.has(destination.id) && this.shouldDeliver(packet, destination)) {
        packet.delivered.add(destination.id);
        this.deliver(packet, destination, false);
        if (this.random() < this.duplicateChance) {
          this.clock.schedule(this.propagationDelayMs, () => this.deliver(packet, destination, true));
        }
      }
      if (!this.shouldForward(packet, destination, hops)) return;
      packet.forwarded.add(destination.id);
      const relayStart = this.reserveTransmission(
        destination.id,
        this.clock.now() + this.relayDelayMs,
        packet.airtime,
        packet.id
      );
      this.clock.schedule(relayStart - this.clock.now(), () => this.transmitHop(packet, destination, hops, relayStart));
    });
  }

  private shouldDeliver(packet: MeshPacket, destination: SimulatedRadio): boolean {
    return packet.destinationRadioNode === undefined || packet.destinationRadioNode === destination.radioNodeNumber;
  }

  private shouldForward(packet: MeshPacket, destination: SimulatedRadio, hops: number): boolean {
    if (
      hops >= this.hopLimit ||
      packet.forwarded.has(destination.id) ||
      packet.destinationRadioNode === destination.radioNodeNumber
    ) {
      return false;
    }
    return [...(this.edges.get(destination.id) ?? [])].some((neighbor) => !packet.forwarded.has(neighbor));
  }

  private deliver(packet: MeshPacket, destination: SimulatedRadio, duplicate: boolean): void {
    if (duplicate) this.mutableMetrics.duplicate_deliveries++;
    this.mutableMetrics.delivered_packets++;
    destination.receive({
      payload: packet.payload.slice(),
      received_at: this.clock.now(),
      radio_source: packet.source.radioNodeNumber,
      channel: packet.channel,
      public_key_encrypted: packet.publicKeyEncrypted
    });
  }
}

export class SimulatedRadio implements LinkRadio {
  readonly max_payload_bytes = 233;
  private readonly handlers = new Set<(packet: RadioPacket) => void>();
  private closed = false;
  private lastPacingDelayMs = 0;

  constructor(
    private readonly network: SimulatedPacketNetwork,
    readonly id: string,
    readonly radioNodeNumber: number
  ) {}

  pacingDelayMs(_payload: Uint8Array): number {
    return this.lastPacingDelayMs;
  }

  async send(payload: Uint8Array, options: RadioSendOptions): Promise<void> {
    if (this.closed) throw new Error(`simulated radio ${this.id} is closed`);
    if (payload.byteLength > this.max_payload_bytes)
      throw new RangeError("simulated Meshtastic payload exceeds 233 bytes");
    this.lastPacingDelayMs = this.network.transmit(this.id, payload, options);
  }

  onPacket(handler: (packet: RadioPacket) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.handlers.clear();
  }

  receive(packet: RadioPacket): void {
    if (this.closed) return;
    for (const handler of this.handlers) handler(packet);
  }
}

export function loraAirtimeMs(payloadBytes: number, profile: ModemProfile = SHORT_FAST_MODEM): number {
  if (!Number.isSafeInteger(payloadBytes) || payloadBytes < 0)
    throw new RangeError("payload bytes must be non-negative");
  const spreadingFactor = profile.spreading_factor;
  const symbolSeconds = 2 ** spreadingFactor / (profile.bandwidth_khz * 1000);
  const lowDataRateOptimization = symbolSeconds > 0.016 ? 1 : 0;
  const numerator = 8 * payloadBytes - 4 * spreadingFactor + 28 + 16;
  const denominator = 4 * (spreadingFactor - 2 * lowDataRateOptimization);
  const payloadSymbols = 8 + Math.max(Math.ceil(numerator / denominator) * profile.coding_rate_denominator, 0);
  return (profile.preamble_symbols + 4.25 + payloadSymbols) * symbolSeconds * 1000;
}

function overlaps(left: MediumWindow, right: MediumWindow): boolean {
  return left.start < right.end && right.start < left.end;
}

function seededRandom(seed: number): () => number {
  if (!Number.isSafeInteger(seed)) throw new TypeError("simulation seed must be a safe integer");
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function probability(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new RangeError(`${name} must be between zero and one`);
  return value;
}

function nonNegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be non-negative`);
  return value;
}

function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function classifyTraffic(payload: Uint8Array): {
  messageType: LinkMessageType | "non_link";
  priority: MessagePriority | "non_link";
} {
  try {
    const frame = decodeFrame(payload);
    return { messageType: frame.message_type, priority: frame.priority };
  } catch {
    return { messageType: "non_link", priority: "non_link" };
  }
}

function emptyMessageTypeCounter(): Record<LinkMessageType | "non_link", number> {
  return {
    state: 0,
    task_delivery: 0,
    task_report: 0,
    data_request: 0,
    data_response: 0,
    resource_operation: 0,
    subscription: 0,
    object_content: 0,
    control: 0,
    non_link: 0
  };
}

function emptyPriorityCounter(): Record<MessagePriority | "non_link", number> {
  return { safety: 0, task: 0, request: 0, live_state: 0, resource: 0, object_content: 0, non_link: 0 };
}
