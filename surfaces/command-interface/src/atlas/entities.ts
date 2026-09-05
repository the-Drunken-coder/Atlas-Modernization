import type { Classification, EntityResource, LinkState } from "@the-drunken-coder/atlas-sdk";
import { type Position, representativePoint, type UiGeometry } from "./geometry.js";

export type { Classification, LinkState } from "@the-drunken-coder/atlas-sdk";

export const ENTITY_DESCRIPTORS = {
  asset: { list: "assets", label: "Assets", title: "Asset" },
  track: { list: "tracks", label: "Tracks", title: "Track" },
  geofeature: { list: "geofeatures", label: "Geo Features", title: "Geo Feature" }
} as const;

export type EntityKind = keyof typeof ENTITY_DESCRIPTORS;
export type EntityListKind = (typeof ENTITY_DESCRIPTORS)[EntityKind]["list"];

export const ENTITY_KINDS = Object.keys(ENTITY_DESCRIPTORS) as EntityKind[];
export const ENTITY_KIND_BY_LIST = Object.fromEntries(
  ENTITY_KINDS.map((kind) => [ENTITY_DESCRIPTORS[kind].list, kind])
) as Record<EntityListKind, EntityKind>;

export type HeartbeatLevel = "fresh" | "stale" | "offline";
export type HeartbeatStatus = HeartbeatLevel | "clock-error";
export type ConnectionFreshness = HeartbeatStatus | "missing";
export type EntityConnectionStatus = { reported: LinkState; freshness: ConnectionFreshness };

// Heartbeat freshness thresholds (seconds). Beyond OFFLINE the asset is treated
// as offline; between the two it is stale.
export const HEARTBEAT_STALE_SECONDS = 30;
export const HEARTBEAT_OFFLINE_SECONDS = 120;

export function entityKind(entity: EntityResource): EntityKind | "other" {
  return Object.hasOwn(ENTITY_DESCRIPTORS, entity.entity_type) ? (entity.entity_type as EntityKind) : "other";
}

export function isSelectableKind(entity: EntityResource): entity is EntityResource & { entity_type: EntityKind } {
  return entityKind(entity) !== "other";
}

export function entityDisplayName(entity: EntityResource): string {
  return entity.alias ?? entity.entity_id;
}

/** Protocol-validated GeoJSON geometry for the entity, if any. */
export function entityGeometry(entity: EntityResource): UiGeometry | undefined {
  return entity.components.geometry;
}

/**
 * Map position as [lng, lat]. Assets prefer telemetry location; everything falls
 * back to a representative point of the geometry component.
 */
export function entityPosition(entity: EntityResource): Position | undefined {
  const telemetry = entity.components.telemetry;
  const latitude = telemetry?.latitude;
  const longitude = telemetry?.longitude;
  if (
    typeof latitude === "number" &&
    Number.isFinite(latitude) &&
    typeof longitude === "number" &&
    Number.isFinite(longitude)
  ) {
    return [longitude, latitude];
  }
  const geometry = entityGeometry(entity);
  return geometry ? representativePoint(geometry) : undefined;
}

export function entityHeading(entity: EntityResource): number | undefined {
  return numberOrUndefined(entity.components.telemetry?.heading_deg);
}

export function entitySpeed(entity: EntityResource): number | undefined {
  return numberOrUndefined(entity.components.telemetry?.speed_m_s);
}

export function entityAltitude(entity: EntityResource): number | undefined {
  return numberOrUndefined(entity.components.telemetry?.altitude_m);
}

export function entityLinkState(entity: EntityResource): LinkState | undefined {
  return entity.components.communications?.link_state;
}

export function entityBattery(entity: EntityResource): number | undefined {
  return numberOrUndefined(entity.components.health?.battery_percent);
}

export function entityStatusValue(entity: EntityResource): string | undefined {
  return entity.components.status?.value;
}

export function entityClassification(entity: EntityResource): Classification | undefined {
  return entity.components.mil_view?.classification;
}

export function entityLastSeen(entity: EntityResource): string | undefined {
  return (
    entity.components.heartbeat?.last_seen ??
    entity.components.telemetry?.last_update ??
    entity.components.status?.last_update
  );
}

export function entityHeartbeatLastSeen(entity: EntityResource): string | undefined {
  return entity.components.heartbeat?.last_seen;
}

export function heartbeatLevel(lastSeen: string | undefined, now: number = Date.now()): HeartbeatStatus | undefined {
  if (!lastSeen) return undefined;
  const timestamp = Date.parse(lastSeen);
  if (!Number.isFinite(timestamp)) return undefined;
  const seconds = (now - timestamp) / 1000;
  if (seconds < -HEARTBEAT_STALE_SECONDS) return "clock-error";
  if (seconds >= HEARTBEAT_OFFLINE_SECONDS) return "offline";
  if (seconds >= HEARTBEAT_STALE_SECONDS) return "stale";
  return "fresh";
}

export function entityConnectionStatus(
  entity: EntityResource,
  now: number = Date.now()
): EntityConnectionStatus | undefined {
  const reported = entityLinkState(entity);
  return reported
    ? { reported, freshness: heartbeatLevel(entityHeartbeatLastSeen(entity), now) ?? "missing" }
    : undefined;
}

function numberOrUndefined(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
