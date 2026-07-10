import type { EntityResource } from "@the-drunken-coder/atlas-sdk";
import {
  entityClassification,
  entityDisplayName,
  entityGeometry,
  entityHeading,
  entityKind,
  entityLinkState,
  entityPosition
} from "../../atlas/entities.js";
import { displayGeometry, type UiRawGeometry } from "../../atlas/geometry.js";

export type MapFeatureProperties = {
  entityId: string;
  entityType: string;
  kind: "asset" | "track" | "geofeature";
  name: string;
  selected: boolean;
  classification?: string;
  linkState?: string;
  heading?: number;
  subtype?: string;
  modelId?: string;
  assetType?: string;
  symbolType?: string;
};

export type MapFeature = {
  type: "Feature";
  id: string;
  geometry: UiRawGeometry;
  properties: MapFeatureProperties;
};

export type MapFeatureCollection = {
  type: "FeatureCollection";
  features: MapFeature[];
};

export type MapSources = {
  assets: MapFeatureCollection;
  tracks: MapFeatureCollection;
  geofeatures: MapFeatureCollection;
};

export function emptyFeatureCollection(): MapFeatureCollection {
  return { type: "FeatureCollection", features: [] };
}

/**
 * Turn the entity snapshot into one GeoJSON source per kind. Assets/tracks
 * render as points (telemetry preferred); geofeatures render their geometry.
 */
export function buildMapSources(entities: EntityResource[], selectedId: string | undefined): MapSources {
  const sources: MapSources = { assets: emptyFeatureCollection(), tracks: emptyFeatureCollection(), geofeatures: emptyFeatureCollection() };

  for (const entity of entities) {
    const kind = entityKind(entity);
    if (kind === "other") continue;

    const geometry = kind === "geofeature" ? entityGeometry(entity) : pointGeometry(entity);
    if (!geometry) continue;
    const mapGeometry = displayGeometry(geometry);

    const feature: MapFeature = {
      type: "Feature",
      id: entity.entity_id,
      geometry: mapGeometry,
      properties: {
        entityId: entity.entity_id,
        entityType: entity.entity_type,
        kind,
        name: entityDisplayName(entity),
        selected: entity.entity_id === selectedId,
        classification: entityClassification(entity),
        linkState: entityLinkState(entity),
        heading: kind === "asset" ? entityHeading(entity) : undefined,
        subtype: entity.subtype ?? undefined,
        ...entitySymbolHints(entity)
      }
    };

    sources[kindToSource(kind)].features.push(feature);
  }

  return sources;
}

function pointGeometry(entity: EntityResource): UiRawGeometry | undefined {
  const position = entityPosition(entity);
  return position ? { type: "Point", coordinates: position } : undefined;
}

function kindToSource(kind: "asset" | "track" | "geofeature"): keyof MapSources {
  return kind === "asset" ? "assets" : kind === "track" ? "tracks" : "geofeatures";
}

function entitySymbolHints(entity: EntityResource): Pick<MapFeatureProperties, "modelId" | "assetType" | "symbolType"> {
  const customSymbol = recordValue(entity.components.custom_symbol);
  return {
    modelId: firstString(customSymbol?.model_id),
    assetType: firstString(customSymbol?.asset_type),
    symbolType: firstString(customSymbol?.symbol_type)
  };
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
