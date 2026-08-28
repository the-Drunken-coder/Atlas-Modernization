import {
  type AtlasClient,
  type ChangedSinceResponse,
  type Classification,
  type EntityCheckInFullResponse,
  type EntityCheckInMinimalResponse,
  type EntityCheckInOptions,
  type EntityCheckInRequest,
  type EntityCheckInResponse,
  type FullDatasetResponse,
  type GeoJSONCircleFeature,
  type GeoJSONLineString,
  type GeoJSONPoint,
  type GeoJSONPolygon,
  type GeoJSONPosition,
  type GeometryComponent,
  isGeometryComponent,
  isResourceType,
  type LinkState,
  type ProtocolRevisionResponse,
  RESOURCE_TYPE_VALUES,
  type ResourceType
} from "../../src/index.js";

declare const client: AtlasClient;
declare const unresolvedOptions: EntityCheckInOptions;
declare const unknownValue: unknown;

const minimal: Promise<EntityCheckInMinimalResponse> = client.entities.checkIn("asset-1", { fields: "minimal" });
const full: Promise<EntityCheckInFullResponse> = client.entities.checkIn("asset-1");
const explicitFull: Promise<EntityCheckInFullResponse> = client.entities.checkIn("asset-1", { fields: "full" });
const unresolved: Promise<EntityCheckInResponse> = client.entities.checkIn("asset-1", unresolvedOptions);
const resourceTypes: readonly ResourceType[] = RESOURCE_TYPE_VALUES;

const publicTypes = undefined as unknown as {
  changed: ChangedSinceResponse;
  classification: Classification;
  checkInRequest: EntityCheckInRequest;
  circle: GeoJSONCircleFeature;
  fullDataset: FullDatasetResponse;
  geometry: GeometryComponent;
  line: GeoJSONLineString;
  linkState: LinkState;
  point: GeoJSONPoint;
  polygon: GeoJSONPolygon;
  position: GeoJSONPosition;
  revision: ProtocolRevisionResponse;
};

if (isGeometryComponent(unknownValue)) {
  const geometry: GeometryComponent = unknownValue;
  void geometry;
}
if (isResourceType(unknownValue)) {
  const resourceType: ResourceType = unknownValue;
  void resourceType;
}

void [minimal, full, explicitFull, unresolved, resourceTypes, publicTypes];
