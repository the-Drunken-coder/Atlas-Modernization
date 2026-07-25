import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { renderSecurityHeaders } from "./src/app/security-headers.js";

const milsymbolRuntimeSource = "atlas-milsymbol-runtime?url";
const milsymbolRuntimePath = fileURLToPath(new URL("../node_modules/milsymbol/dist/milsymbol.js", import.meta.url));
const runtimeSourceMaps = [
  { path: `${milsymbolRuntimePath}.map`, fileName: "assets/milsymbol.js.map" },
  {
    path: `${fileURLToPath(new URL("../node_modules/maplibre-gl/dist/maplibre-gl.js", import.meta.url))}.map`,
    fileName: "assets/maplibre-gl.js.map"
  }
];
const milsymbolAssetPattern = /^assets\/milsymbol-[^/]+\.js$/;
let emitRuntimeMaps = false;

export function appendMilsymbolSourceMapReference(source: string, fileName: string): string {
  if (!milsymbolAssetPattern.test(fileName) || source.includes("sourceMappingURL=")) return source;
  return `${source.replace(/\s*$/, "")}\n//# sourceMappingURL=milsymbol.js.map\n`;
}

export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    {
      name: "atlas-milsymbol-runtime-url",
      resolveId(source: string) {
        return source === milsymbolRuntimeSource ? `${milsymbolRuntimePath}?url` : undefined;
      }
    },
    {
      name: "atlas-security-headers",
      generateBundle() {
        this.emitFile({
          type: "asset",
          fileName: "_headers",
          source: renderSecurityHeaders(loadEnv(mode, process.cwd(), ""))
        });
      }
    },
    {
      name: "atlas-runtime-source-maps",
      configResolved(config) {
        emitRuntimeMaps = config.build.sourcemap !== false;
      },
      generateBundle(_options, bundle) {
        if (!emitRuntimeMaps) return;
        for (const sourceMap of runtimeSourceMaps) {
          if (existsSync(sourceMap.path)) {
            this.emitFile({ type: "asset", fileName: sourceMap.fileName, source: readFileSync(sourceMap.path) });
          }
        }
        for (const output of Object.values(bundle)) {
          if (output.type !== "asset" || !milsymbolAssetPattern.test(output.fileName)) continue;
          const source = typeof output.source === "string" ? output.source : new TextDecoder().decode(output.source);
          output.source = appendMilsymbolSourceMapReference(source, output.fileName);
        }
      }
    }
  ],
  build: {
    manifest: "manifest.json",
    outDir: "dist/client",
    emptyOutDir: true
  },
  server: {
    port: 5173
  }
}));
