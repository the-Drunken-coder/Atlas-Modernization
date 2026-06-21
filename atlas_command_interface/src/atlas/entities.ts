import type { EntityResource } from "../../../atlas_sdk/src/index.js";
import { representativePoint, toUiGeometry, type Position, type UiGeometry } from "./geometry.js";

export type EntityKind = "asset" | "track" | "geofeature";
export type LinkState = "connected" | "disconnected" | "degraded" | "unknown";
export type Classification = "friendly" | "hostile" | "neutral" | "unknown" | "civilian";

export type HeartbeatLevel = "fresh" | "stale" | "offline";

// Heartbeat freshness thresholds (seconds). Beyond OFFLINE the asset is treated
// as offline; between the two it is stale.
export const HEARTBEAT_STALE_SECONDS = 30;
export const HEARTBEAT_OFFLINE_SECONDS = 120;

const ENTITY_KINDS: EntityKind[] = ["asset", "track", "geofeature"];

export function entityKind(entity: EntityResource): EntityKind | "other" {
  return (ENTITY_KINDS as string[]).includes(entity.entity_type) ? (entity.entity_type as EntityKind) : "other";
}

export function isSelectableKind(entity: EntityResource): entity is EntityResource & { entity_type: EntityKind } {
  return entityKind(entity) !== "other";
}

export function entityDisplayName(entity: EntityResource): string {
  return entity.alias ?? entity.entity_id;
}

/** Normalised GeoJSON geometry for the entity, if any. */
export function entityGeometry(entity: EntityResource): UiGeometry | undefined {
  return toUiGeometry(entity.components.geometry);
}

/**
 * Map position as [lng, lat]. Assets prefer telemetry location; everything falls
 * back to a representative point of the geometry component.
 */
export function entityPosition(entity: EntityResource): Position | undefined {
  const telemetry = entity.components.telemetry;
  if (telemetry && typeof telemetry.latitude === "number" && typeof telemetry.longitude === "number") {
    return [telemetry.longitude, telemetry.latitude];
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
  return entity.components.heartbeat?.last_seen ?? entity.components.telemetry?.last_update ?? entity.components.status?.last_update;
}

export function entityCurrentTaskId(entity: EntityResource): string | undefined {
  return entity.components.task_queue?.current_task_id ?? undefined;
}

export function entityQueuedTaskIds(entity: EntityResource): string[] {
  return entity.components.task_queue?.queued_task_ids ?? [];
}

export function heartbeatLevel(lastSeen: string | undefined, now: number = Date.now()): HeartbeatLevel | undefined {
  if (!lastSeen) return undefined;
  const timestamp = Date.parse(lastSeen);
  if (!Number.isFinite(timestamp)) return undefined;
  const seconds = (now - timestamp) / 1000;
  if (seconds < 0) return undefined;
  if (seconds >= HEARTBEAT_OFFLINE_SECONDS) return "offline";
  if (seconds >= HEARTBEAT_STALE_SECONDS) return "stale";
  return "fresh";
}

function numberOrUndefined(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
