import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { maplibreRuntime } = vi.hoisted(() => ({ maplibreRuntime: { Map: class {}, setWorkerUrl: vi.fn() } }));

vi.mock("maplibre-gl", () => maplibreRuntime);
vi.mock("../../runtime-asset-urls.js", () => ({
  maplibreCssUrl: "/assets/maplibre.css",
  maplibreWorkerUrl: "/assets/maplibre-worker.js",
  milsymbolScriptUrl: "/assets/milsymbol.js"
}));

let getSidcRuntime: typeof import("../../symbols/sidc-runtime.js").getSidcRuntime;
let loadSidcRuntime: typeof import("../../symbols/sidc-runtime.js").loadSidcRuntime;
let getMapLibreRuntime: typeof import("./maplibre-runtime.js").getMapLibreRuntime;
let loadMapLibre: typeof import("./maplibre-runtime.js").loadMapLibre;

beforeEach(async () => {
  vi.resetModules();
  maplibreRuntime.setWorkerUrl.mockClear();
  ({ getSidcRuntime, loadSidcRuntime } = await import("../../symbols/sidc-runtime.js"));
  ({ getMapLibreRuntime, loadMapLibre } = await import("./maplibre-runtime.js"));
});

afterEach(() => {
  document.head.replaceChildren();
  vi.unstubAllGlobals();
});

describe("map runtime loaders", () => {
  it("removes a failed milsymbol script and retries from a fresh request", async () => {
    const firstAttempt = loadSidcRuntime();
    const firstScript = document.querySelector<HTMLScriptElement>("script[data-atlas-milsymbol]");
    expect(firstScript?.src).toContain("/assets/milsymbol.js");
    firstScript?.dispatchEvent(new Event("error"));
    await expect(firstAttempt).rejects.toThrow("SIDC symbol runtime failed to load");
    expect(document.querySelector("script[data-atlas-milsymbol]")).toBeNull();

    const runtime = { Symbol: class {} } as unknown as ReturnType<typeof getSidcRuntime>;
    vi.stubGlobal("ms", runtime);
    const secondAttempt = loadSidcRuntime();
    await expect(secondAttempt).resolves.toBe(runtime);
  });

  it("rejects on MapLibre stylesheet failure and retries with a fresh stylesheet", async () => {
    const firstAttempt = loadMapLibre();
    const firstStylesheet = document.querySelector<HTMLLinkElement>("link[data-atlas-maplibre-style]");
    expect(firstStylesheet).not.toBeNull();

    firstStylesheet?.dispatchEvent(new Event("error"));
    await expect(firstAttempt).rejects.toThrow("MapLibre stylesheet failed to load");
    expect(document.querySelector("link[data-atlas-maplibre-style]")).toBeNull();

    const secondAttempt = loadMapLibre();
    const secondStylesheet = document.querySelector<HTMLLinkElement>("link[data-atlas-maplibre-style]");
    expect(secondStylesheet).not.toBeNull();
    expect(secondStylesheet).not.toBe(firstStylesheet);
    expect(document.querySelectorAll("link[data-atlas-maplibre-style]")).toHaveLength(1);

    secondStylesheet?.dispatchEvent(new Event("load"));
    const runtime = await secondAttempt;
    expect(runtime.Map).toBe(maplibreRuntime.Map);
    expect(getMapLibreRuntime()).toBe(runtime);
  });

  it("does not expose the MapLibre module before stylesheet readiness", async () => {
    expect(getMapLibreRuntime()).toBeUndefined();

    const attempt = loadMapLibre();
    const stylesheet = document.querySelector<HTMLLinkElement>("link[data-atlas-maplibre-style]");
    expect(stylesheet).not.toBeNull();

    let resolved = false;
    void attempt.then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);

    stylesheet?.dispatchEvent(new Event("load"));
    const runtime = await attempt;
    expect(runtime.Map).toBe(maplibreRuntime.Map);
    expect(maplibreRuntime.setWorkerUrl).toHaveBeenCalledOnce();
    expect(maplibreRuntime.setWorkerUrl).toHaveBeenCalledWith("/assets/maplibre-worker.js");
    expect(getMapLibreRuntime()).toBe(runtime);
  });

  it("removes a milsymbol script with no global and retries with one fresh script", async () => {
    const firstAttempt = loadSidcRuntime();
    const firstScript = document.querySelector<HTMLScriptElement>("script[data-atlas-milsymbol]");
    expect(firstScript).not.toBeNull();

    firstScript?.dispatchEvent(new Event("load"));
    await expect(firstAttempt).rejects.toThrow("SIDC symbol runtime did not initialize");
    expect(document.querySelector("script[data-atlas-milsymbol]")).toBeNull();

    const secondAttempt = loadSidcRuntime();
    const secondScript = document.querySelector<HTMLScriptElement>("script[data-atlas-milsymbol]");
    expect(secondScript).not.toBeNull();
    expect(secondScript).not.toBe(firstScript);

    const runtime = { Symbol: class {} } as unknown as ReturnType<typeof getSidcRuntime>;
    vi.stubGlobal("ms", runtime);
    secondScript?.dispatchEvent(new Event("load"));
    await expect(secondAttempt).resolves.toBe(runtime);
  });

  it("reuses an already-loaded stylesheet without adding another link", async () => {
    const stylesheet = document.createElement("link");
    stylesheet.rel = "stylesheet";
    stylesheet.dataset.atlasMaplibreStyle = "true";
    Object.defineProperty(stylesheet, "sheet", { configurable: true, value: {} });
    document.head.append(stylesheet);

    const attempt = loadMapLibre();
    expect(document.querySelectorAll("link[data-atlas-maplibre-style]")).toHaveLength(1);

    const runtime = await attempt;
    expect(runtime.Map).toBe(maplibreRuntime.Map);
    expect(document.querySelectorAll("link[data-atlas-maplibre-style]")).toHaveLength(1);
  });

  it("shares one MapLibre module load across concurrent requests", async () => {
    const attempt = loadMapLibre();
    const concurrentAttempt = loadMapLibre();
    const stylesheet = document.querySelector<HTMLLinkElement>("link[data-atlas-maplibre-style]");
    expect(document.querySelectorAll("link[data-atlas-maplibre-style]")).toHaveLength(1);
    expect(concurrentAttempt).toBe(attempt);
    stylesheet?.dispatchEvent(new Event("load"));

    const runtime = await attempt;
    await expect(concurrentAttempt).resolves.toBe(runtime);
    await expect(loadMapLibre()).resolves.toBe(runtime);
    expect(getMapLibreRuntime()).toBe(runtime);
    expect(document.querySelectorAll("link[data-atlas-maplibre-style]")).toHaveLength(1);
  });

  it("resolves milsymbol when the injected script initializes the global", async () => {
    const runtime = { Symbol: class {} } as unknown as ReturnType<typeof getSidcRuntime>;
    const attempt = loadSidcRuntime();
    const script = document.querySelector<HTMLScriptElement>("script[data-atlas-milsymbol]");
    vi.stubGlobal("ms", runtime);
    script?.dispatchEvent(new Event("load"));

    await expect(attempt).resolves.toBe(runtime);
    expect(getSidcRuntime()).toBe(runtime);
  });
});
