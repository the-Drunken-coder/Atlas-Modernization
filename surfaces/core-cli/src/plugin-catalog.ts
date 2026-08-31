import { PACKAGE_PLUGIN_CATALOG } from "./plugin-catalog.generated.js";

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

export const PLUGIN_CATALOG: readonly PluginCatalogEntry[] = PACKAGE_PLUGIN_CATALOG;
