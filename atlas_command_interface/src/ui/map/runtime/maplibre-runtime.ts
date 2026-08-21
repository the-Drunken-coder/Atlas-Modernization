import { maplibreCssUrl, maplibreWorkerUrl } from "../../runtime-asset-urls.js";

export type MapLibreRuntime = typeof import("maplibre-gl");

type MapLibreStylesheet = HTMLLinkElement;

let runtime: MapLibreRuntime | undefined;
let runtimePromise: Promise<MapLibreRuntime> | undefined;

export function getMapLibreRuntime(): MapLibreRuntime | undefined {
  return runtime && hasReadyStylesheet() ? runtime : undefined;
}

export function loadMapLibre(): Promise<MapLibreRuntime> {
  if (runtime && hasReadyStylesheet()) return Promise.resolve(runtime);
  if (runtimePromise !== undefined) return runtimePromise;
  runtimePromise = loadRuntime().catch((error: unknown) => {
    runtimePromise = undefined;
    throw error;
  });
  return runtimePromise;
}

function loadRuntime(): Promise<MapLibreRuntime> {
  const stylesheet = getOrCreateStylesheet();
  return Promise.all([loadStylesheet(stylesheet), import("maplibre-gl")]).then(([, loadedRuntime]) => {
    loadedRuntime.setWorkerUrl(maplibreWorkerUrl);
    runtime = loadedRuntime;
    return loadedRuntime;
  });
}

function hasReadyStylesheet(): boolean {
  const stylesheet = document.querySelector<MapLibreStylesheet>("link[data-atlas-maplibre-style]");
  return stylesheet !== null && (stylesheet.dataset.atlasMaplibreStyleState === "loaded" || stylesheet.sheet !== null);
}

function getOrCreateStylesheet(): MapLibreStylesheet {
  let stylesheet = document.querySelector<MapLibreStylesheet>("link[data-atlas-maplibre-style]");
  if (stylesheet?.dataset.atlasMaplibreStyleState === "failed") {
    stylesheet.remove();
    stylesheet = null;
  }
  if (stylesheet) return stylesheet;

  stylesheet = document.createElement("link");
  stylesheet.rel = "stylesheet";
  stylesheet.href = maplibreCssUrl;
  stylesheet.dataset.atlasMaplibreStyle = "true";
  stylesheet.dataset.atlasMaplibreStyleState = "loading";
  document.head.append(stylesheet);
  return stylesheet;
}

function loadStylesheet(stylesheet: MapLibreStylesheet): Promise<void> {
  if (stylesheet.dataset.atlasMaplibreStyleState === "loaded" || stylesheet.sheet !== null) {
    stylesheet.dataset.atlasMaplibreStyleState = "loaded";
    return Promise.resolve();
  }
  if (stylesheet.dataset.atlasMaplibreStyleState === "failed") {
    stylesheet.remove();
    return Promise.reject(new Error("MapLibre stylesheet failed to load"));
  }

  return new Promise<void>((resolve, reject) => {
    stylesheet.addEventListener(
      "load",
      () => {
        stylesheet.dataset.atlasMaplibreStyleState = "loaded";
        resolve();
      },
      { once: true }
    );
    stylesheet.addEventListener(
      "error",
      () => {
        stylesheet.dataset.atlasMaplibreStyleState = "failed";
        stylesheet.remove();
        reject(new Error("MapLibre stylesheet failed to load"));
      },
      { once: true }
    );
  });
}
