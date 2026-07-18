import type { Map as MlMap } from "maplibre-gl";
import type { RefObject } from "react";
import type { MapSources } from "./map-sources.js";
import type { MapReticleTarget } from "./map-targets.js";

export type MapReticleInteractionOptions = {
  mapCanvasRef: RefObject<HTMLDivElement | null>;
  mapRef: RefObject<MlMap | undefined>;
  mapReady: boolean;
  sources: MapSources;
  selectedEntityId?: string;
  focusTarget?: MapReticleTarget | null;
  notifyUserGesture: () => void;
  onSelectEntity: (id: string) => void;
  onBackgroundClick?: () => void;
};
