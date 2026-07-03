/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ATLAS_CORE_BASE_URL?: string;
  readonly VITE_AZURE_MAPS_SUBSCRIPTION_KEY?: string;
  readonly VITE_BING_MAPS_KEY?: string;
  readonly VITE_GOOGLE_MAPS_API_KEY?: string;
  readonly VITE_GOOGLE_MAPS_TILE_SESSION?: string;
  readonly VITE_MAPBOX_ACCESS_TOKEN?: string;
  readonly VITE_MAPTILER_API_KEY?: string;
  readonly VITE_MICROSOFT_MAPS_KEY?: string;
  readonly VITE_THUNDERFOREST_API_KEY?: string;
}
