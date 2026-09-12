import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vite";
import commandInterfaceConfig from "../../../../surfaces/command-interface/vite.config.ts";

const repositoryRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const applicationRoot = resolve(repositoryRoot, "surfaces/command-interface");
const productionRegistry = resolve(applicationRoot, "src/features/commands/command-input-registry.js");
const fixtureRegistry = fileURLToPath(new URL("./command-input-registry.fixture.ts", import.meta.url));

export default defineConfig(async (environment) => {
  const outputDirectory = process.env.ATLAS_BROWSER_COMMANDS_BUILD_DIR;
  if (!outputDirectory) throw new Error("ATLAS_BROWSER_COMMANDS_BUILD_DIR is required");
  const base =
    typeof commandInterfaceConfig === "function"
      ? await commandInterfaceConfig(environment)
      : await commandInterfaceConfig;

  return mergeConfig(
    base,
    defineConfig({
      root: applicationRoot,
      plugins: [
        {
          name: "atlas-browser-command-input-fixture",
          enforce: "pre",
          resolveId(source, importer) {
            if (!importer || importer === fixtureRegistry || !source.endsWith("command-input-registry.js")) {
              return undefined;
            }
            const resolvedImport = resolve(dirname(importer.split("?", 1)[0]), source);
            return resolvedImport === productionRegistry ? fixtureRegistry : undefined;
          }
        }
      ],
      build: {
        outDir: outputDirectory,
        emptyOutDir: true
      }
    })
  );
});
