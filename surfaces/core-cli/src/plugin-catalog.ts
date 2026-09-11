export type PluginCatalogEntry = {
  pluginId: string;
  displayName: string;
  lifecycle: "query_only";
  service: string;
  image: string | null;
  assets: {
    compose: string;
    core_endpoint: string;
    source_connector: string;
  };
};

// Legacy type surface retained while independent catalog loading is migrated into PluginCatalogStore.
export const PLUGIN_CATALOG: readonly PluginCatalogEntry[] = [];
