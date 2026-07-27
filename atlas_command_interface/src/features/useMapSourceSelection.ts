import { useCallback, useEffect, useState } from "react";
import type { AppConfig, MapSourceConfig } from "../app/config.js";

export type AvailableMapSourceConfig = MapSourceConfig & { style: NonNullable<MapSourceConfig["style"]> };

export function availableMapSource(source: MapSourceConfig | undefined): AvailableMapSourceConfig | undefined {
  return source?.style ? (source as AvailableMapSourceConfig) : undefined;
}

export type MapSourceSelection = {
  selectedMapSourceId?: string;
  selectedMapSource?: AvailableMapSourceConfig;
  setSelectedMapSourceId: (id: string) => void;
  handleMapStyleSwitchError: (error: { failedStyleId: string; activeStyleId: string }) => void;
};

/**
 * Owns the active map-source choice. Follows the configured default until the
 * user picks another available source, re-clamps when the config changes, and
 * reverts to the still-active source when a style switch fails.
 */
export function useMapSourceSelection(config: AppConfig | undefined): MapSourceSelection {
  const [selectedMapSourceId, setSelectedMapSourceId] = useState<string>();

  useEffect(() => {
    if (!config) return;
    setSelectedMapSourceId((current) =>
      current && config.mapSources.some((source) => source.id === current && source.style)
        ? current
        : config.defaultMapSourceId
    );
  }, [config]);

  const handleMapStyleSwitchError = useCallback(
    ({ activeStyleId }: { failedStyleId: string; activeStyleId: string }) => {
      const activeSource = config?.mapSources.find((source) => source.id === activeStyleId);
      if (activeSource) setSelectedMapSourceId(activeSource.id);
    },
    [config]
  );

  const selectedMapSource = config
    ? (availableMapSource(config.mapSources.find((source) => source.id === selectedMapSourceId)) ??
      availableMapSource(config.mapSources.find((source) => source.id === config.defaultMapSourceId)))
    : undefined;

  return { selectedMapSourceId, selectedMapSource, setSelectedMapSourceId, handleMapStyleSwitchError };
}
