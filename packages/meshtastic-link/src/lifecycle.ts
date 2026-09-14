import { RealClock } from "./clock.js";
import { RADIO_CONTRACT_REVISION } from "./contract.js";
import type { FrameEncoding } from "./frame.js";
import {
  type AssetAuthenticationPolicy,
  AssetJoinService,
  encodeJoinMessage,
  type GatewayAuthenticationPolicy,
  GatewayJoinService
} from "./joining.js";
import { type GatewayMembership, GatewayMembershipStore } from "./membership.js";
import type { RadioProfile } from "./profile.js";
import { RadioProfileManager } from "./profile.js";
import { LinkRadioGate, MESHTASTIC_NATIVE_PKI_PAYLOAD_BYTES, type MeshtasticSerialRadio } from "./radio.js";
import { LinkHTTPServer, LinkService } from "./service.js";
import { LinkTransport } from "./transport.js";

type CommonStartLinkServiceOptions = {
  nodeID: string;
  profile: RadioProfile;
  openRadio: () => Promise<MeshtasticSerialRadio>;
  port?: number;
  frameEncoding?: FrameEncoding;
  adaptiveRetries?: boolean;
  stateDeltas?: boolean;
};

export type StartLinkServiceOptions =
  | (CommonStartLinkServiceOptions & {
      mode: "asset";
      authentication: AssetAuthenticationPolicy;
    })
  | (CommonStartLinkServiceOptions & {
      mode: "gateway";
      authentication: GatewayAuthenticationPolicy;
      membershipPath?: string;
    });

export type RunningLinkService = {
  readonly address: { host: string; port: number };
  close(): Promise<void>;
};

/** Assemble one Link service and own its cleanup after the existing constructor window. */
export async function startLinkService(options: StartLinkServiceOptions): Promise<RunningLinkService> {
  const clock = new RealClock();
  const rawRadio = await options.openRadio();
  const radio = new LinkRadioGate(rawRadio);
  const profileManager = new RadioProfileManager(options.profile, rawRadio);
  const service = new LinkService({
    mode: options.mode,
    nodeID: options.nodeID,
    clock,
    profileManager,
    radioGate: radio
  });
  const http = new LinkHTTPServer(service);
  let listening = false;
  let gatewayJoin: GatewayJoinService | undefined;
  let assetJoin: AssetJoinService | undefined;

  const close = async (): Promise<void> => {
    const cleanupErrors: unknown[] = [];
    for (const cleanup of [() => service.stop(), () => assetJoin?.close(), () => gatewayJoin?.close()]) {
      try {
        await cleanup();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (listening) {
      try {
        await http.close();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      await radio.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "Link service cleanup failed");
  };

  try {
    const address = await http.listen(options.port ?? 7331);
    listening = true;
    if (options.mode === "gateway") {
      if (!options.membershipPath) throw new Error("--membership is required");
      const store = new GatewayMembershipStore(options.membershipPath);
      const membership = await store.load();
      if (membership.gateway_node_id !== options.nodeID)
        throw new Error("Gateway membership identity does not match --node-id");
      preflightGatewayAcceptance(membership);
      await profileManager.prepareGateway(membership);
      const active = await store.activateGateway();
      const transport = new LinkTransport({
        node: service.node,
        frameEncoding: options.frameEncoding ?? "canonical-json",
        retryJitterMs: 1000,
        adaptiveRetries: options.adaptiveRetries ?? false,
        stateDeltas: options.stateDeltas ?? false,
        sourceGeneration: active.gateway_generation,
        serviceSession: service.serviceSession,
        radio,
        clock,
        picture: service.picture,
        privateChannel: active.channel_index
      });
      service.attachTransport(transport);
      gatewayJoin = new GatewayJoinService(
        radio,
        options.profile.public_channel.index,
        store,
        options.authentication,
        (error) => service.setJoiningLifecycle("active", `join attempt deferred: ${error.message}`),
        (admission): void => {
          // Source-fence rejection throws; a queue result must not roll back local membership admission.
          transport.announceSourceActivation(admission.source, admission.source_generation, admission.service_session);
        }
      );
    } else {
      await profileManager.prepareAssetForJoin();
      service.setJoiningLifecycle("discovering", "waiting for authenticated Gateway admission");
      let attached = false;
      assetJoin = new AssetJoinService({
        radio,
        clock,
        assetID: options.nodeID,
        radioNodeID: rawRadio.nodeNumber(),
        serviceSession: service.serviceSession,
        rendezvousChannel: options.profile.public_channel.index,
        authentication: options.authentication,
        installMembership: async (membership) => {
          if (service.isRadioProfileApplying()) throw new Error("radio profile apply is in progress");
          await profileManager.installAssetMembership(membership);
        },
        onStatus: (status) => {
          service.setJoiningStatus(status);
          if (status.state === "discovering" || status.state === "authenticating") {
            service.setJoiningLifecycle("discovering", status.state);
          } else if (status.state === "joined" && !attached) {
            attached = true;
            const transport = new LinkTransport({
              node: service.node,
              frameEncoding: options.frameEncoding ?? "canonical-json",
              retryJitterMs: 1000,
              adaptiveRetries: options.adaptiveRetries ?? false,
              stateDeltas: options.stateDeltas ?? false,
              sourceGeneration: status.source_generation,
              serviceSession: service.serviceSession,
              radio,
              clock,
              picture: service.picture,
              privateChannel: options.profile.private_channel.index
            });
            service.attachTransport(transport, { role: "gateway", id: status.gateway_node_id });
          }
        },
        onError: (error) => service.setJoiningLifecycle("discovering", `join attempt deferred: ${error.message}`),
        onDisconnect: (error) => service.setLifecycle("error", error.message)
      });
      assetJoin.start();
    }
    return { address, close };
  } catch (error) {
    try {
      service.setLifecycle("error", error instanceof Error ? error.message : String(error));
    } catch {
      // Preserve the operation failure even if a local event listener is faulty.
    }
    try {
      await close();
    } catch {
      // Preserve the startup failure when cleanup also fails.
    }
    throw error;
  }
}

export function preflightGatewayAcceptance(
  membership: Omit<GatewayMembership, "gateway_generation" | "asset_generations">
): void {
  encodeJoinMessage(
    {
      type: "accept",
      join_attempt_id: "0".repeat(32),
      gateway_node_id: membership.gateway_node_id,
      source_generation: 1,
      radio_contract_revision: RADIO_CONTRACT_REVISION,
      channel_index: membership.channel_index,
      channel_name: membership.channel_name,
      channel_key_base64: membership.channel_key_base64
    },
    MESHTASTIC_NATIVE_PKI_PAYLOAD_BYTES
  );
}
