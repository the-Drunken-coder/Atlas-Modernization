import { maplibreCssUrl, maplibreScriptUrl } from "../../runtime-asset-urls.js";

export type MapLibreRuntime = typeof import("maplibre-gl");

type MapLibreGlobal = typeof globalThis & { maplibregl?: MapLibreRuntime };
type MapLibreStylesheet = HTMLLinkElement;

let runtimePromise: Promise<MapLibreRuntime> | undefined;

export function getMapLibreRuntime(): MapLibreRuntime | undefined {
  const global = globalThis as MapLibreGlobal;
  return global.maplibregl && hasReadyStylesheet() ? global.maplibregl : undefined;
}

export function loadMapLibre(): Promise<MapLibreRuntime> {
  const global = globalThis as MapLibreGlobal;
  if (global.maplibregl && hasReadyStylesheet()) return Promise.resolve(global.maplibregl);
  if (runtimePromise !== undefined) return runtimePromise;
  runtimePromise = loadRuntime(global).catch((error: unknown) => {
    runtimePromise = undefined;
    throw error;
  });
  return runtimePromise;
}

function loadRuntime(global: MapLibreGlobal): Promise<MapLibreRuntime> {
  const stylesheet = getOrCreateStylesheet();
  let script: HTMLScriptElement | undefined;
  const stylesheetPromise = loadStylesheet(stylesheet);
  const scriptPromise = loadScript(global, (loadedScript) => {
    script = loadedScript;
  });

  return Promise.all([stylesheetPromise, scriptPromise])
    .then(([, runtime]) => runtime)
    .catch((error: unknown) => {
      if (stylesheet.dataset.atlasMaplibreStyleState === "failed") script?.remove();
      throw error;
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

function loadScript(global: MapLibreGlobal, setScript: (script: HTMLScriptElement) => void): Promise<MapLibreRuntime> {
  if (global.maplibregl) return Promise.resolve(global.maplibregl);

  const existingScript = document.querySelector<HTMLScriptElement>("script[data-atlas-maplibre]");
  const script = existingScript ?? document.createElement("script");
  setScript(script);

  return new Promise<MapLibreRuntime>((resolve, reject) => {
    const fail = () => {
      script.remove();
      reject(new Error("MapLibre runtime failed to load"));
    };
    const finish = () => {
      if (global.maplibregl) {
        resolve(global.maplibregl);
      } else {
        script.remove();
        reject(new Error("MapLibre runtime did not initialize"));
      }
    };

    script.addEventListener("load", finish, { once: true });
    script.addEventListener("error", fail, { once: true });
    if (!existingScript) {
      script.src = maplibreScriptUrl;
      script.dataset.atlasMaplibre = "true";
      document.head.append(script);
    }
  });
}
