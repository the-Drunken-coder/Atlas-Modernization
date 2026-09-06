import { decodeFrame, type LinkFrame } from "../frame.js";
import type { LinkRadio, RadioPacket, RadioSendOptions } from "../radio.js";
import type { ReceiveFault } from "./config.js";

/** Controlled faults occur after firmware reception, before production Link reassembly. */
export class FaultRadio implements LinkRadio {
  readonly max_payload_bytes: number;
  readonly observations = {
    incoming_packets: 0,
    dropped_packets: 0,
    duplicate_packets_injected: 0,
    malformed_packets: 0
  };
  readonly sends = new Map<
    string,
    {
      operation_id: string;
      message_type: string;
      attempts: number;
      queue_acceptances: number;
      queue_rejections: number;
      unique_fragments_admitted: number;
      retransmission_admissions: number;
      admitted_bytes: number;
    }
  >();
  private readonly admittedFrames = new Set<string>();
  readonly applied: { rule: number; at_ms: number; operation_id: string; message_id: string; chunk: number }[] = [];
  private readonly used = new Map<number, number>();
  private readonly handlers = new Set<(packet: RadioPacket) => void>();
  private readonly unsubscribe: () => void;
  constructor(
    private readonly radio: LinkRadio,
    receiver: string,
    faults: ReceiveFault[],
    now: () => number,
    maxPayloadBytes = radio.max_payload_bytes
  ) {
    this.max_payload_bytes = maxPayloadBytes;
    this.unsubscribe = radio.onPacket((packet) => {
      this.observations.incoming_packets++;
      let frame: LinkFrame;
      try {
        frame = decodeFrame(packet.payload);
      } catch {
        this.observations.malformed_packets++;
        for (const handler of this.handlers) handler(packet);
        return;
      }
      const at = now();
      const index = faults.findIndex(
        (rule, index) =>
          rule.receiver === receiver &&
          rule.source === frame.source.id &&
          rule.message_type === frame.message_type &&
          (rule.operation_id === undefined || rule.operation_id === frame.operation_id) &&
          at >= rule.after_ms &&
          at < rule.before_ms &&
          (this.used.get(index) ?? 0) < rule.count
      );
      const rule = faults[index];
      if (rule) {
        this.used.set(index, (this.used.get(index) ?? 0) + 1);
        this.applied.push({
          rule: index,
          at_ms: at,
          operation_id: frame.operation_id,
          message_id: frame.message_id,
          chunk: frame.chunk_index
        });
        if (rule.action === "drop") {
          this.observations.dropped_packets++;
          return;
        }
        this.observations.duplicate_packets_injected++;
      }
      for (const handler of this.handlers) handler(packet);
      if (rule?.action === "duplicate") for (const handler of this.handlers) handler(packet);
    });
  }
  async send(payload: Uint8Array, options: RadioSendOptions) {
    const frame = decodeFrame(payload);
    const key = `${frame.source.id}:${frame.operation_id}`;
    let observation = this.sends.get(key);
    if (!observation) {
      observation = {
        operation_id: frame.operation_id,
        message_type: frame.message_type,
        attempts: 0,
        queue_acceptances: 0,
        queue_rejections: 0,
        unique_fragments_admitted: 0,
        retransmission_admissions: 0,
        admitted_bytes: 0
      };
      this.sends.set(key, observation);
    }
    observation.attempts++;
    try {
      await this.radio.send(payload, options);
    } catch (error) {
      observation.queue_rejections++;
      throw error;
    }
    observation.queue_acceptances++;
    observation.admitted_bytes += payload.byteLength;
    const frameKey = `${key}:${frame.message_id}:${frame.chunk_index}`;
    if (this.admittedFrames.has(frameKey)) observation.retransmission_admissions++;
    else {
      this.admittedFrames.add(frameKey);
      observation.unique_fragments_admitted++;
    }
  }
  pacingDelayMs(payload: Uint8Array) {
    return this.radio.pacingDelayMs?.(payload) ?? 0;
  }
  maxPayloadBytes(options: RadioSendOptions): number {
    return Math.min(this.max_payload_bytes, this.radio.maxPayloadBytes?.(options) ?? this.radio.max_payload_bytes);
  }
  onPacket(handler: (packet: RadioPacket) => void) {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }
  onDisconnect(handler: (reason: Error) => void) {
    return this.radio.onDisconnect?.(handler) ?? (() => undefined);
  }
  async close() {
    this.unsubscribe();
    this.handlers.clear();
    await this.radio.close();
  }
}
