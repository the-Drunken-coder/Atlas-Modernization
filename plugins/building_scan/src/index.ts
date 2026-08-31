import { definePlugin, SourceGatewayClient, servePlugin } from "@the-drunken-coder/atlas-plugin-runtime";
import { createBuildingSearchOperation } from "./operation.js";

const gateway = new SourceGatewayClient(process.env.ATLAS_SOURCE_GATEWAY_ORIGIN ?? "http://source-gateway:8080");

const plugin = definePlugin({
  pluginId: "building_scan",
  displayName: "Building Scan",
  operations: {
    search_buildings: createBuildingSearchOperation(gateway)
  }
});

await servePlugin(plugin, { port: Number(process.env.PORT ?? "8080") });
