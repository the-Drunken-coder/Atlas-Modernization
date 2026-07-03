interface Env {
  ASSETS: {
    fetch(request: Request): Promise<Response>;
  };
  ATLAS_CORE_BASE_URL: string;
  MAPTILER_API_KEY?: string;
  MAPBOX_ACCESS_TOKEN?: string;
}
