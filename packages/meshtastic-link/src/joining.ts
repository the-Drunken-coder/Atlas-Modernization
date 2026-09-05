import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { decodeJSON, encodeCanonicalJSON } from "./canonical-json.js";
import type { Clock, TimerHandle } from "./clock.js";
import { LINK_PROTOCOL_REVISION, RADIO_CONTRACT_REVISION } from "./contract.js";
import { MESHTASTIC_APPLICATION_PAYLOAD_BYTES } from "./frame.js";
import type { GatewayMembershipStore } from "./membership.js";
import type { PrivateChannelMembership } from "./profile.js";
import type { LinkRadio, RadioPacket } from "./radio.js";

const JOIN_MARKER = "AJ1";
const REQUIRED_CAPABILITIES = 0b111;
const MAX_PENDING_JOINS = 256;
const PENDING_JOIN_RETENTION_MS = 2 * 60_000;
const MAX_COMPLETED_JOINS = 256;
const COMPLETED_JOIN_RETENTION_MS = 5 * 60_000;

export type DiscoveryBeacon = {
  type: "discovery";
  join_attempt_id: string;
  radio_node_id: number;
  asset_id: string;
  service_session: string;
  link_revision: typeof LINK_PROTOCOL_REVISION;
  radio_contract_revision: typeof RADIO_CONTRACT_REVISION;
  capabilities: readonly ["json", "fragmentation", "confirmation"];
};

export type JoinChallenge = {
  type: "challenge";
  join_attempt_id: string;
  challenge: string;
  gateway_proof: string;
};

export type JoinResponse = {
  type: "response";
  join_attempt_id: string;
  response: string;
};

export type JoinAcceptance = PrivateChannelMembership & {
  type: "accept";
  join_attempt_id: string;
  gateway_node_id: string;
  source_generation: number;
  radio_contract_revision: typeof RADIO_CONTRACT_REVISION;
};

export type JoinWireMessage = DiscoveryBeacon | JoinChallenge | JoinResponse | JoinAcceptance;

export interface GatewayAuthenticationPolicy {
  challenge(beacon: DiscoveryBeacon): Promise<string>;
  prove(beacon: DiscoveryBeacon, challenge: string): Promise<string>;
  verify(beacon: DiscoveryBeacon, challenge: string, response: string): Promise<boolean>;
}

export interface AssetAuthenticationPolicy {
  answer(challenge: string): Promise<string>;
  verifyGateway(beacon: DiscoveryBeacon, challenge: string, proof: string): Promise<boolean>;
}

export type SourceAdmission = {
  source: { role: "asset"; id: string };
  source_generation: number;
  service_session: string;
};

export class CooperativeAuthenticationPolicy implements GatewayAuthenticationPolicy, AssetAuthenticationPolicy {
  async challenge(_beacon: DiscoveryBeacon): Promise<string> {
    return compactID();
  }

  async verify(_beacon: DiscoveryBeacon, challenge: string, response: string): Promise<boolean> {
    return challenge === response;
  }

  async prove(_beacon: DiscoveryBeacon, challenge: string): Promise<string> {
    return challenge;
  }

  async answer(challenge: string): Promise<string> {
    return challenge;
  }

  async verifyGateway(_beacon: DiscoveryBeacon, challenge: string, proof: string): Promise<boolean> {
    return challenge === proof;
  }
}

export class PreSharedKeyAuthenticationPolicy implements GatewayAuthenticationPolicy, AssetAuthenticationPolicy {
  private readonly key: Buffer;

  constructor(key: Uint8Array | string) {
    this.key = typeof key === "string" ? Buffer.from(key, "utf8") : Buffer.from(key);
    if (this.key.byteLength < 32) throw new TypeError("join authentication key must contain at least 32 bytes");
  }

  async challenge(_beacon: DiscoveryBeacon): Promise<string> {
    return compactID();
  }

  async verify(_beacon: DiscoveryBeacon, challenge: string, response: string): Promise<boolean> {
    const expected = this.signature("asset", challenge);
    const actual = Buffer.from(response, "base64url");
    return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
  }

  async prove(beacon: DiscoveryBeacon, challenge: string): Promise<string> {
    return this.signature("gateway", gatewayProofInput(beacon, challenge)).toString("base64url");
  }

  async answer(challenge: string): Promise<string> {
    return this.signature("asset", challenge).toString("base64url");
  }

  async verifyGateway(beacon: DiscoveryBeacon, challenge: string, proof: string): Promise<boolean> {
    const expected = this.signature("gateway", gatewayProofInput(beacon, challenge));
    const actual = Buffer.from(proof, "base64url");
    return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
  }

  private signature(party: "asset" | "gateway", input: string): Buffer {
    return createHmac("sha256", this.key)
      .update("atlas-meshtastic-link-join\0")
      .update(party)
      .update("\0")
      .update(input)
      .digest();
  }
}

type PendingJoin = {
  beacon: DiscoveryBeacon;
  challenge: string;
  gatewayProof: string;
  radioNodeID: number;
  expiresAt: number;
};

type CompletedJoin = {
  beacon: DiscoveryBeacon;
  radioNodeID: number;
  acceptance: JoinAcceptance;
  expiresAt: number;
};

export class GatewayJoinService {
  private readonly pending = new Map<string, PendingJoin>();
  private readonly completed = new Map<string, CompletedJoin>();
  private readonly processing = new Set<string>();
  private readonly pendingChallenges = new Set<string>();
  private readonly activeOperations = new Set<Promise<void>>();
  private readonly unsubscribe: () => void;
  private closed = false;

  constructor(
    private readonly radio: LinkRadio,
    private readonly rendezvousChannel: number,
    private readonly membershipStore: GatewayMembershipStore,
    private readonly authentication: GatewayAuthenticationPolicy,
    private readonly onError?: (error: Error) => void,
    private readonly onAdmitted?: (admission: SourceAdmission) => void | Promise<void>
  ) {
    this.unsubscribe = radio.onPacket((packet) => this.run(() => this.receive(packet)));
  }

  async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.unsubscribe();
      this.pending.clear();
      this.completed.clear();
      this.pendingChallenges.clear();
    }
    await Promise.allSettled([...this.activeOperations]);
    this.processing.clear();
  }

  private async receive(packet: RadioPacket): Promise<void> {
    if (this.closed || packet.channel !== this.rendezvousChannel || packet.radio_source === undefined) return;
    const message = decodeJoinMessage(packet.payload);
    if (!message) return;
    this.prunePending(packet.received_at);
    if (message.type === "discovery") {
      this.pruneCompleted(packet.received_at);
      if (message.radio_node_id !== packet.radio_source) return;
      const completed = this.completed.get(message.join_attempt_id);
      if (completed) {
        if (sameJoin(completed.beacon, message, completed.radioNodeID, packet.radio_source)) {
          await this.sendAcceptance(completed.acceptance, packet.radio_source);
        }
        return;
      }
      const existing = this.pending.get(message.join_attempt_id);
      if (existing) {
        if (sameJoin(existing.beacon, message, existing.radioNodeID, packet.radio_source)) {
          await this.sendChallenge(
            message.join_attempt_id,
            existing.challenge,
            existing.gatewayProof,
            packet.radio_source
          );
        }
        return;
      }
      if (this.pendingChallenges.has(message.join_attempt_id)) return;
      if (this.pending.size + this.pendingChallenges.size >= MAX_PENDING_JOINS) return;
      this.pendingChallenges.add(message.join_attempt_id);
      let challenge: string;
      let gatewayProof: string;
      try {
        challenge = await this.authentication.challenge(message);
        if (this.closed) return;
        gatewayProof = await this.authentication.prove(message, challenge);
        if (this.closed) return;
        this.pending.set(message.join_attempt_id, {
          beacon: message,
          challenge,
          gatewayProof,
          radioNodeID: packet.radio_source,
          expiresAt: packet.received_at + PENDING_JOIN_RETENTION_MS
        });
      } finally {
        this.pendingChallenges.delete(message.join_attempt_id);
      }
      while (this.pending.size > MAX_PENDING_JOINS) {
        const oldest = this.pending.keys().next().value as string | undefined;
        if (!oldest) break;
        this.pending.delete(oldest);
      }
      await this.sendChallenge(message.join_attempt_id, challenge, gatewayProof, packet.radio_source);
      return;
    }
    if (message.type !== "response" || !packet.public_key_encrypted) return;
    const pending = this.pending.get(message.join_attempt_id);
    if (!pending || pending.radioNodeID !== packet.radio_source || this.processing.has(message.join_attempt_id)) return;
    this.processing.add(message.join_attempt_id);
    try {
      const accepted = await this.authentication.verify(pending.beacon, pending.challenge, message.response);
      if (!accepted || this.closed) return;
      const admitted = await this.membershipStore.admitAsset(pending.beacon.asset_id);
      if (this.closed) return;
      await this.onAdmitted?.({
        source: { role: "asset", id: pending.beacon.asset_id },
        source_generation: admitted.source_generation,
        service_session: pending.beacon.service_session
      });
      if (this.closed) return;
      const acceptance: JoinAcceptance = {
        type: "accept",
        join_attempt_id: message.join_attempt_id,
        gateway_node_id: admitted.membership.gateway_node_id,
        source_generation: admitted.source_generation,
        radio_contract_revision: RADIO_CONTRACT_REVISION,
        channel_index: admitted.membership.channel_index,
        channel_name: admitted.membership.channel_name,
        channel_key_base64: admitted.membership.channel_key_base64
      };
      this.completed.set(message.join_attempt_id, {
        beacon: pending.beacon,
        radioNodeID: pending.radioNodeID,
        acceptance,
        expiresAt: packet.received_at + COMPLETED_JOIN_RETENTION_MS
      });
      this.pruneCompleted(packet.received_at);
      await this.sendAcceptance(acceptance, packet.radio_source);
    } finally {
      this.pending.delete(message.join_attempt_id);
      this.processing.delete(message.join_attempt_id);
    }
  }

  private async sendChallenge(
    joinAttemptID: string,
    challenge: string,
    gatewayProof: string,
    destination: number
  ): Promise<void> {
    if (this.closed) return;
    await this.radio.send(
      encodeJoinMessage(
        {
          type: "challenge",
          join_attempt_id: joinAttemptID,
          challenge,
          gateway_proof: gatewayProof
        },
        this.radio.max_payload_bytes
      ),
      {
        channel: this.rendezvousChannel,
        destination_radio_node: destination,
        require_public_key: true
      }
    );
  }

  private async sendAcceptance(acceptance: JoinAcceptance, destination: number): Promise<void> {
    if (this.closed) return;
    await this.radio.send(encodeJoinMessage(acceptance, this.radio.max_payload_bytes), {
      channel: this.rendezvousChannel,
      destination_radio_node: destination,
      require_public_key: true
    });
  }

  private pruneCompleted(now = Date.now()): void {
    for (const [attemptID, completed] of this.completed) {
      if (completed.expiresAt <= now) this.completed.delete(attemptID);
    }
    while (this.completed.size > MAX_COMPLETED_JOINS) {
      const oldest = this.completed.keys().next().value as string | undefined;
      if (oldest === undefined) return;
      this.completed.delete(oldest);
    }
  }

  private prunePending(now: number): void {
    for (const [attemptID, pending] of this.pending) {
      if (pending.expiresAt <= now && !this.processing.has(attemptID)) this.pending.delete(attemptID);
    }
  }

  private run(operation: () => Promise<void>): void {
    const active = operation()
      .catch((error: unknown) => {
        if (!this.closed) this.onError?.(asError(error));
      })
      .finally(() => this.activeOperations.delete(active));
    this.activeOperations.add(active);
  }
}

export type AssetJoinStatus =
  | { state: "discovering"; join_attempt_id: string }
  | { state: "authenticating"; join_attempt_id: string }
  | { state: "joined"; join_attempt_id: string; gateway_node_id: string; source_generation: number }
  | { state: "stopped" };

export type AssetJoinOptions = {
  radio: LinkRadio;
  clock: Clock;
  assetID: string;
  radioNodeID: number;
  serviceSession: string;
  rendezvousChannel?: number;
  authentication: AssetAuthenticationPolicy;
  installMembership: (membership: PrivateChannelMembership) => Promise<void>;
  onStatus?: (status: AssetJoinStatus) => void;
  onError?: (error: Error) => void;
  onDisconnect?: (error: Error) => void;
  random?: () => number;
};

export class AssetJoinService {
  private readonly radio: LinkRadio;
  private readonly clock: Clock;
  private readonly assetID: string;
  private readonly radioNodeID: number;
  private readonly serviceSession: string;
  private readonly rendezvousChannel: number;
  private readonly authentication: AssetAuthenticationPolicy;
  private readonly installMembership: (membership: PrivateChannelMembership) => Promise<void>;
  private readonly random: () => number;
  private readonly onStatus: ((status: AssetJoinStatus) => void) | undefined;
  private readonly onError: ((error: Error) => void) | undefined;
  private readonly onDisconnect: ((error: Error) => void) | undefined;
  private readonly activeOperations = new Set<Promise<void>>();
  private readonly startedAt: number;
  private readonly joinAttemptID = compactID();
  private readonly unsubscribe: () => void;
  private readonly unsubscribeDisconnect: () => void;
  private retryTimer: TimerHandle | undefined;
  private gatewayRadioNodeID: number | undefined;
  private installingMembership = false;
  private currentStatus: AssetJoinStatus;

  constructor(options: AssetJoinOptions) {
    if (!options.assetID || !options.serviceSession || !Number.isSafeInteger(options.radioNodeID)) {
      throw new TypeError("Asset joining requires stable Asset, radio, and service session identities");
    }
    this.radio = options.radio;
    this.clock = options.clock;
    this.assetID = options.assetID;
    this.radioNodeID = options.radioNodeID;
    this.serviceSession = options.serviceSession;
    this.rendezvousChannel = options.rendezvousChannel ?? 0;
    this.authentication = options.authentication;
    this.installMembership = options.installMembership;
    this.random = options.random ?? Math.random;
    this.onStatus = options.onStatus;
    this.onError = options.onError;
    this.onDisconnect = options.onDisconnect;
    this.startedAt = this.clock.now();
    this.currentStatus = { state: "discovering", join_attempt_id: this.joinAttemptID };
    this.unsubscribe = this.radio.onPacket((packet) => this.run(() => this.receive(packet)));
    this.unsubscribeDisconnect =
      this.radio.onDisconnect?.((error) => {
        if (!this.isWaitingToJoin()) return;
        this.stop();
        this.onDisconnect?.(error);
      }) ?? (() => undefined);
  }

  start(): void {
    if (this.currentStatus.state === "stopped") throw new Error("cannot restart a stopped join service");
    this.onStatus?.(this.status());
    this.run(() => this.sendDiscovery());
  }

  status(): AssetJoinStatus {
    return { ...this.currentStatus };
  }

  stop(): void {
    if (this.currentStatus.state === "stopped") return;
    if (this.retryTimer) this.clock.cancel(this.retryTimer);
    this.unsubscribe();
    this.unsubscribeDisconnect();
    this.updateStatus({ state: "stopped" });
  }

  async close(): Promise<void> {
    this.stop();
    await Promise.allSettled([...this.activeOperations]);
  }

  private async sendDiscovery(): Promise<void> {
    if (this.currentStatus.state === "joined" || this.currentStatus.state === "stopped") return;
    const beacon = this.beacon();
    const elapsed = this.clock.now() - this.startedAt;
    const baseDelay = elapsed < 30_000 ? 5_000 : 30_000;
    const jitter = elapsed < 30_000 ? Math.round((this.random() - 0.5) * 1_000) : 0;
    try {
      await this.radio.send(encodeJoinMessage(beacon, this.radio.max_payload_bytes), {
        channel: this.rendezvousChannel
      });
    } finally {
      if (this.isWaitingToJoin()) {
        this.retryTimer = this.clock.schedule(baseDelay + jitter, () => this.run(() => this.sendDiscovery()));
      }
    }
  }

  private isWaitingToJoin(): boolean {
    return this.currentStatus.state === "discovering" || this.currentStatus.state === "authenticating";
  }

  private beacon(): DiscoveryBeacon {
    return {
      type: "discovery",
      join_attempt_id: this.joinAttemptID,
      radio_node_id: this.radioNodeID,
      asset_id: this.assetID,
      service_session: this.serviceSession,
      link_revision: LINK_PROTOCOL_REVISION,
      radio_contract_revision: RADIO_CONTRACT_REVISION,
      capabilities: ["json", "fragmentation", "confirmation"]
    };
  }

  private async receive(packet: RadioPacket): Promise<void> {
    if (
      packet.channel !== this.rendezvousChannel ||
      !packet.public_key_encrypted ||
      packet.radio_source === undefined ||
      this.currentStatus.state === "joined" ||
      this.currentStatus.state === "stopped"
    ) {
      return;
    }
    const message = decodeJoinMessage(packet.payload);
    if (!message || message.join_attempt_id !== this.joinAttemptID) return;
    if (message.type === "challenge") {
      if (!(await this.authentication.verifyGateway(this.beacon(), message.challenge, message.gateway_proof))) return;
      if (this.isStopped()) return;
      this.gatewayRadioNodeID = packet.radio_source;
      this.updateStatus({ state: "authenticating", join_attempt_id: this.joinAttemptID });
      const response = await this.authentication.answer(message.challenge);
      if (this.isStopped()) return;
      await this.radio.send(
        encodeJoinMessage(
          { type: "response", join_attempt_id: this.joinAttemptID, response },
          this.radio.max_payload_bytes
        ),
        {
          channel: this.rendezvousChannel,
          destination_radio_node: packet.radio_source,
          require_public_key: true
        }
      );
      return;
    }
    if (message.type !== "accept" || packet.radio_source !== this.gatewayRadioNodeID) return;
    if (message.radio_contract_revision !== RADIO_CONTRACT_REVISION) return;
    if (this.installingMembership) return;
    this.installingMembership = true;
    try {
      await this.installMembership({
        channel_index: message.channel_index,
        channel_name: message.channel_name,
        channel_key_base64: message.channel_key_base64
      });
      if (this.status().state === "stopped") return;
      if (this.retryTimer) this.clock.cancel(this.retryTimer);
      this.updateStatus({
        state: "joined",
        join_attempt_id: this.joinAttemptID,
        gateway_node_id: message.gateway_node_id,
        source_generation: message.source_generation
      });
    } finally {
      this.installingMembership = false;
    }
  }

  private updateStatus(status: AssetJoinStatus): void {
    this.currentStatus = status;
    this.onStatus?.(this.status());
  }

  private isStopped(): boolean {
    return this.currentStatus.state === "stopped";
  }

  private run(operation: () => Promise<void>): void {
    const active = operation()
      .catch((error: unknown) => {
        if (this.currentStatus.state !== "stopped") this.onError?.(asError(error));
      })
      .finally(() => this.activeOperations.delete(active));
    this.activeOperations.add(active);
  }
}

export function encodeJoinMessage(
  message: JoinWireMessage,
  maxPayloadBytes = MESHTASTIC_APPLICATION_PAYLOAD_BYTES
): Uint8Array {
  const compact = compactJoinMessage(message);
  const encoded = encodeCanonicalJSON(compact);
  if (!Number.isSafeInteger(maxPayloadBytes) || maxPayloadBytes < 1) {
    throw new RangeError("join message payload budget must be a positive integer");
  }
  if (encoded.byteLength > maxPayloadBytes) throw new RangeError("join message exceeds one Meshtastic packet");
  return encoded;
}

export function decodeJoinMessage(payload: Uint8Array): JoinWireMessage | undefined {
  let value: unknown;
  try {
    value = decodeJSON(payload);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || value.m !== JOIN_MARKER || typeof value.t !== "string") return undefined;
  if (value.t === "d") {
    if (
      !isNonEmptyString(value.a) ||
      !Number.isSafeInteger(value.n) ||
      !isNonEmptyString(value.e) ||
      !isNonEmptyString(value.s) ||
      value.l !== LINK_PROTOCOL_REVISION ||
      decodeRevision(value.r) !== RADIO_CONTRACT_REVISION ||
      value.c !== REQUIRED_CAPABILITIES
    ) {
      return undefined;
    }
    return {
      type: "discovery",
      join_attempt_id: value.a,
      radio_node_id: Number(value.n),
      asset_id: value.e,
      service_session: value.s,
      link_revision: LINK_PROTOCOL_REVISION,
      radio_contract_revision: RADIO_CONTRACT_REVISION,
      capabilities: ["json", "fragmentation", "confirmation"]
    };
  }
  if (value.t === "c" && isNonEmptyString(value.a) && isNonEmptyString(value.p) && isNonEmptyString(value.g)) {
    return {
      type: "challenge",
      join_attempt_id: value.a,
      challenge: value.p,
      gateway_proof: value.g
    };
  }
  if (value.t === "r" && isNonEmptyString(value.a) && isNonEmptyString(value.p)) {
    return { type: "response", join_attempt_id: value.a, response: value.p };
  }
  if (
    value.t === "a" &&
    isNonEmptyString(value.a) &&
    isNonEmptyString(value.h) &&
    Number.isSafeInteger(value.g) &&
    Number(value.g) > 0 &&
    decodeRevision(value.r) === RADIO_CONTRACT_REVISION &&
    Number.isSafeInteger(value.i) &&
    Number(value.i) > 0 &&
    Number(value.i) <= 7 &&
    value.n === "ATLAS" &&
    isNonEmptyString(value.k)
  ) {
    return {
      type: "accept",
      join_attempt_id: value.a,
      gateway_node_id: value.h,
      source_generation: Number(value.g),
      radio_contract_revision: RADIO_CONTRACT_REVISION,
      channel_index: Number(value.i),
      channel_name: "ATLAS",
      channel_key_base64: value.k
    };
  }
  return undefined;
}

function compactJoinMessage(message: JoinWireMessage): Record<string, string | number> {
  if (message.type === "discovery") {
    return {
      m: JOIN_MARKER,
      t: "d",
      a: message.join_attempt_id,
      n: message.radio_node_id,
      e: message.asset_id,
      s: message.service_session,
      l: message.link_revision,
      r: encodeRevision(message.radio_contract_revision),
      c: REQUIRED_CAPABILITIES
    };
  }
  if (message.type === "challenge") {
    return {
      m: JOIN_MARKER,
      t: "c",
      a: message.join_attempt_id,
      p: message.challenge,
      g: message.gateway_proof
    };
  }
  if (message.type === "response") return { m: JOIN_MARKER, t: "r", a: message.join_attempt_id, p: message.response };
  return {
    m: JOIN_MARKER,
    t: "a",
    a: message.join_attempt_id,
    h: message.gateway_node_id,
    g: message.source_generation,
    r: encodeRevision(message.radio_contract_revision),
    i: message.channel_index,
    n: message.channel_name,
    k: message.channel_key_base64
  };
}

function encodeRevision(revision: string): string {
  const match = /^sha256:([0-9a-f]{64})$/.exec(revision);
  if (!match?.[1]) throw new TypeError("radio contract revision must be a SHA-256 digest");
  return Buffer.from(match[1], "hex").toString("base64url");
}

function decodeRevision(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const bytes = Buffer.from(value, "base64url");
  return bytes.byteLength === 32 ? `sha256:${bytes.toString("hex")}` : undefined;
}

function sameJoin(
  left: DiscoveryBeacon,
  right: DiscoveryBeacon,
  leftRadioNodeID: number,
  rightRadioNodeID: number
): boolean {
  return (
    left.join_attempt_id === right.join_attempt_id &&
    left.asset_id === right.asset_id &&
    left.service_session === right.service_session &&
    left.radio_node_id === right.radio_node_id &&
    leftRadioNodeID === rightRadioNodeID
  );
}

function gatewayProofInput(beacon: DiscoveryBeacon, challenge: string): string {
  return [beacon.join_attempt_id, beacon.radio_node_id, beacon.asset_id, beacon.service_session, challenge].join("\0");
}

function compactID(): string {
  return randomUUID().replaceAll("-", "");
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
