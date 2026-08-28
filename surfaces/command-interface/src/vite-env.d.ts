/// <reference types="vite/client" />

declare module "atlas-milsymbol-runtime?url" {
  const url: string;
  export default url;
}

interface ImportMetaEnv {
  readonly VITE_ATLAS_CORE_BASE_URL?: string;
  readonly VITE_GOOGLE_MAPS_API_KEY?: string;
  readonly VITE_MAPBOX_ACCESS_TOKEN?: string;
  readonly VITE_MAPTILER_API_KEY?: string;
  readonly VITE_THUNDERFOREST_API_KEY?: string;
}
