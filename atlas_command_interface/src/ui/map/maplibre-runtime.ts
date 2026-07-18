import { maplibreCssUrl, maplibreScriptUrl } from "../runtime-asset-urls.js";

export type MapLibreRuntime = typeof import("maplibre-gl");

type MapLibreGlobal = typeof globalThis & { maplibregl?: MapLibreRuntime };

let runtimePromise: Promise<MapLibreRuntime> | undefined;

export function getMapLibreRuntime(): MapLibreRuntime | undefined {
  return (globalThis as MapLibreGlobal).maplibregl;
}

export function loadMapLibre(): Promise<MapLibreRuntime> {
  const global = globalThis as MapLibreGlobal;
  if (global.maplibregl) return Promise.resolve(global.maplibregl);
  if (runtimePromise !== undefined) return runtimePromise;
  runtimePromise = loadRuntime(global).catch((error: unknown) => {
    runtimePromise = undefined;
    throw error;
  });
  return runtimePromise;
}

function loadRuntime(global: MapLibreGlobal): Promise<MapLibreRuntime> {
  return new Promise<MapLibreRuntime>((resolve, reject) => {
    const existingScript = document.querySelector<HTMLScriptElement>("script[data-atlas-maplibre]");
    let script: HTMLScriptElement | undefined;
    const fail = () => {
      (existingScript ?? script)?.remove();
      reject(new Error("MapLibre runtime failed to load"));
    };
    const finish = () => {
      if (global.maplibregl) {
        resolve(global.maplibregl);
      } else {
        reject(new Error("MapLibre runtime did not initialize"));
      }
    };

    if (existingScript) {
      existingScript.addEventListener("load", finish, { once: true });
      existingScript.addEventListener("error", fail, { once: true });
      return;
    }

    if (!document.querySelector("link[data-atlas-maplibre-style]")) {
      const stylesheet = document.createElement("link");
      stylesheet.rel = "stylesheet";
      stylesheet.href = maplibreCssUrl;
      stylesheet.dataset.atlasMaplibreStyle = "true";
      document.head.append(stylesheet);
    }

    script = document.createElement("script");
    script.src = maplibreScriptUrl;
    script.dataset.atlasMaplibre = "true";
    script.addEventListener("load", finish, { once: true });
    script.addEventListener("error", fail, { once: true });
    document.head.append(script);
  });
}
