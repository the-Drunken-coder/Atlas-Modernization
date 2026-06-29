interface Env {
  ASSETS: {
    fetch(request: Request): Promise<Response>;
  };
  ATLAS_CORE_BASE_URL: string;
  MAP_STYLE_URL?: string;
}
