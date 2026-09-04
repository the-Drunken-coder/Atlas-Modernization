import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendMilsymbolSourceMapReference, relocateAnalysisManifest, sanitizeManifestPaths } from "../vite.config.js";

describe("Milsymbol source-map output", () => {
  it("adds a relative source-map reference to the hashed runtime asset", () => {
    const source = "window.ms = {};";

    expect(appendMilsymbolSourceMapReference(source, "assets/milsymbol-C66lyuqP.js")).toBe(
      `${source}\n//# sourceMappingURL=milsymbol.js.map\n`
    );
  });

  it("does not add the reference to unrelated or already-mapped output", () => {
    const source = "window.ms = {};";
    const mappedSource = `${source}\n//# sourceMappingURL=existing.js.map`;

    expect(appendMilsymbolSourceMapReference(source, "assets/other.js")).toBe(source);
    expect(appendMilsymbolSourceMapReference(mappedSource, "assets/milsymbol-C66lyuqP.js")).toBe(mappedSource);
  });
});

describe("analysis manifest output", () => {
  it("removes absolute local source paths from the relocated manifest", () => {
    const root = "/workspace/atlas/surfaces/command-interface";

    expect(
      sanitizeManifestPaths(
        {
          "/workspace/atlas/node_modules/maplibre-gl/dist/maplibre-gl.css": {
            file: "assets/maplibre-gl.css",
            src: "/workspace/atlas/node_modules/maplibre-gl/dist/maplibre-gl.css"
          },
          "src/app/main.tsx": { file: "assets/main.js", src: "src/app/main.tsx" }
        },
        root
      )
    ).toEqual({
      "../../node_modules/maplibre-gl/dist/maplibre-gl.css": {
        file: "assets/maplibre-gl.css",
        src: "../../node_modules/maplibre-gl/dist/maplibre-gl.css"
      },
      "src/app/main.tsx": { file: "assets/main.js", src: "src/app/main.tsx" }
    });
  });

  it("relocates the analysis manifest outside the deployed client directory", () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "atlas-command-manifest-"));
    const outputDirectory = join(temporaryRoot, "client");
    mkdirSync(outputDirectory);
    writeFileSync(
      join(outputDirectory, "manifest.json"),
      JSON.stringify({ "/workspace/atlas/src/main.tsx": { file: "assets/main.js" } })
    );

    try {
      relocateAnalysisManifest().writeBundle({ dir: outputDirectory });

      expect(existsSync(join(outputDirectory, "manifest.json"))).toBe(false);
      const relocated = JSON.parse(readFileSync(join(temporaryRoot, "bundle-manifest.json"), "utf8")) as Record<
        string,
        unknown
      >;
      const [sourcePath] = Object.keys(relocated);
      if (!sourcePath) throw new Error("Relocated manifest is empty");
      expect(sourcePath).not.toMatch(/^(?:[/\\]|[A-Za-z]:)/);
      expect(relocated[sourcePath]).toEqual({ file: "assets/main.js" });
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });
});
