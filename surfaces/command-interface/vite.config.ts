import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { renderSecurityHeaders } from "./src/app/security-headers.js";

const milsymbolRuntimeSource = "atlas-milsymbol-runtime?url";
const milsymbolRuntimePath = fileURLToPath(new URL("../../node_modules/milsymbol/dist/milsymbol.js", import.meta.url));
const runtimeSourceMaps = [{ path: `${milsymbolRuntimePath}.map`, fileName: "assets/milsymbol.js.map" }];
const milsymbolAssetPattern = /^assets\/milsymbol-[^/]+\.js$/;
let emitRuntimeMaps = false;

export function sanitizeManifestPaths(manifest: Record<string, unknown>, root: string): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(manifest).map(([key, value]) => [
      toRelativeManifestPath(key, root),
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(
            Object.entries(value).map(([entryKey, entryValue]) => [
              entryKey,
              entryKey === "src" && typeof entryValue === "string"
                ? toRelativeManifestPath(entryValue, root)
                : entryValue
            ])
          )
        : value
    ])
  );
}

function toRelativeManifestPath(value: string, root: string): string {
  if (!isAbsolute(value)) return value;
  return relative(root, value).replaceAll("\\", "/") || ".";
}

export function relocateAnalysisManifest() {
  return {
    name: "atlas-analysis-manifest",
    apply: "build" as const,
    writeBundle(options: { dir?: string }) {
      if (!options.dir) throw new Error("Atlas analysis manifest requires a directory build output");
      const deployedManifestPath = resolve(options.dir, "manifest.json");
      if (!existsSync(deployedManifestPath)) throw new Error("Vite did not emit the expected analysis manifest");
      const analysisManifestPath = resolve(options.dir, "..", "bundle-manifest.json");
      const manifest = JSON.parse(readFileSync(deployedManifestPath, "utf8")) as Record<string, unknown>;
      mkdirSync(dirname(analysisManifestPath), { recursive: true });
      writeFileSync(
        analysisManifestPath,
        `${JSON.stringify(sanitizeManifestPaths(manifest, fileURLToPath(new URL(".", import.meta.url))), null, 2)}\n`
      );
      rmSync(deployedManifestPath);
    }
  };
}

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
    },
    relocateAnalysisManifest()
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
