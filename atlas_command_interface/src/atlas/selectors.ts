import type { EntityResource, ObjectResource, TaskResource } from "../../../atlas_sdk/src/index.js";

export type Position = [longitude: number, latitude: number];

export type MapFeature = {
  id: string;
  kind: "asset" | "track" | "geofeature";
  entity: EntityResource;
  geometry:
    | { type: "Point"; coordinates: Position }
    | { type: "LineString"; coordinates: Position[] }
    | { type: "Polygon"; coordinates: Position[][] };
};

export function entitiesByType(entities: EntityResource[], type: string): EntityResource[] {
  return entities.filter((entity) => entity.entity_type === type);
}

export function assetEntities(entities: EntityResource[]): EntityResource[] {
  return entitiesByType(entities, "asset");
}

export function trackEntities(entities: EntityResource[]): EntityResource[] {
  return entitiesByType(entities, "track");
}

export function geofeatureEntities(entities: EntityResource[]): EntityResource[] {
  return entitiesByType(entities, "geofeature");
}

export function entityDisplayName(entity: EntityResource): string {
  return entity.alias ?? entity.entity_id;
}

export function entityStatus(entity: EntityResource): string {
  return entity.components.status?.value ?? entity.components.communications?.link_state ?? "unknown";
}

export function entityTasks(entity: EntityResource | undefined, tasks: TaskResource[]): TaskResource[] {
  if (!entity) return [];
  return tasks
    .filter((task) => task.entity_id === entity.entity_id)
    .sort((left, right) => right.metadata.version - left.metadata.version);
}

export function objectSummary(object: ObjectResource): string {
  const parts = [object.type, object.content_type, object.size_bytes === null ? undefined : `${object.size_bytes} bytes`].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "object";
}

export function mapFeatures(entities: EntityResource[]): MapFeature[] {
  return entities.flatMap((entity) => {
    const feature = featureForEntity(entity);
    return feature ? [feature] : [];
  });
}

export function featureForEntity(entity: EntityResource): MapFeature | undefined {
  const kind = featureKind(entity);
  if (!kind) return undefined;
  const geometry = geometryForEntity(entity);
  return geometry ? { id: entity.entity_id, kind, entity, geometry } : undefined;
}

function featureKind(entity: EntityResource): MapFeature["kind"] | undefined {
  if (entity.entity_type === "asset") return "asset";
  if (entity.entity_type === "track") return "track";
  if (entity.entity_type === "geofeature") return "geofeature";
  return undefined;
}

function geometryForEntity(entity: EntityResource): MapFeature["geometry"] | undefined {
  const telemetry = entity.components.telemetry;
  const telemetryPosition = positionFromCoordinates(telemetry?.longitude, telemetry?.latitude);
  if (telemetryPosition) {
    return { type: "Point", coordinates: telemetryPosition };
  }

  const geometry = entity.components.geometry;
  if (!geometry || typeof geometry !== "object") return undefined;
  if ("type" in geometry && geometry.type === "Point" && Array.isArray(geometry.coordinates)) {
    const point = positionFromCoordinates(geometry.coordinates[0], geometry.coordinates[1]);
    return point ? { type: "Point", coordinates: point } : undefined;
  }
  if ("type" in geometry && geometry.type === "LineString" && Array.isArray(geometry.coordinates)) {
    const line = geometry.coordinates.filter(isPosition);
    return line.length >= 2 ? { type: "LineString", coordinates: line } : undefined;
  }
  if ("type" in geometry && geometry.type === "Polygon" && Array.isArray(geometry.coordinates)) {
    const polygon = geometry.coordinates.map((ring) => (Array.isArray(ring) ? ring.filter(isPosition) : [])).filter((ring) => ring.length >= 4);
    return polygon.length > 0 ? { type: "Polygon", coordinates: polygon } : undefined;
  }
  if ("point_lat" in geometry && "point_lng" in geometry) {
    const point = positionFromCoordinates(geometry.point_lng, geometry.point_lat);
    return point ? { type: "Point", coordinates: point } : undefined;
  }
  if ("line" in geometry && Array.isArray(geometry.line)) {
    const line = geometry.line
      .filter((value): value is [number, number] => Array.isArray(value) && positionFromCoordinates(value[1], value[0]) !== undefined)
      .map((value): Position => [value[1], value[0]]);
    return line.length >= 2 ? { type: "LineString", coordinates: line } : undefined;
  }
  if ("polygon" in geometry && Array.isArray(geometry.polygon)) {
    const ring = geometry.polygon
      .filter((value): value is [number, number] => Array.isArray(value) && positionFromCoordinates(value[1], value[0]) !== undefined)
      .map((value): Position => [value[1], value[0]]);
    return ring.length >= 3 ? { type: "Polygon", coordinates: [closeRing(ring)] } : undefined;
  }
  return undefined;
}

function closeRing(ring: Position[]): Position[] {
  const first = ring[0];
  const last = ring[ring.length - 1];
  return first && last && first[0] === last[0] && first[1] === last[1] ? ring : [...ring, first];
}

function isPosition(value: unknown): value is Position {
  return Array.isArray(value) && positionFromCoordinates(value[0], value[1]) !== undefined;
}

function positionFromCoordinates(longitude: unknown, latitude: unknown): Position | undefined {
  if (typeof longitude === "number" && Number.isFinite(longitude) && typeof latitude === "number" && Number.isFinite(latitude)) {
    return [longitude, latitude];
  }
  return undefined;
}
