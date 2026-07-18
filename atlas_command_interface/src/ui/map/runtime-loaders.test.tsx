import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../runtime-asset-urls.js", () => ({
  maplibreCssUrl: "/assets/maplibre.css",
  maplibreScriptUrl: "/assets/maplibre.js",
  milsymbolScriptUrl: "/assets/milsymbol.js"
}));

let getSidcRuntime: typeof import("../symbols/sidc-runtime.js").getSidcRuntime;
let loadSidcRuntime: typeof import("../symbols/sidc-runtime.js").loadSidcRuntime;
let getMapLibreRuntime: typeof import("./maplibre-runtime.js").getMapLibreRuntime;
let loadMapLibre: typeof import("./maplibre-runtime.js").loadMapLibre;

beforeEach(async () => {
  vi.resetModules();
  ({ getSidcRuntime, loadSidcRuntime } = await import("../symbols/sidc-runtime.js"));
  ({ getMapLibreRuntime, loadMapLibre } = await import("./maplibre-runtime.js"));
});

afterEach(() => {
  document.head.replaceChildren();
  vi.unstubAllGlobals();
});

describe("map runtime loaders", () => {
  it("removes a failed MapLibre script and retries from a fresh request", async () => {
    const firstAttempt = loadMapLibre();
    const firstScript = document.querySelector<HTMLScriptElement>("script[data-atlas-maplibre]");
    expect(firstScript?.src).toContain("/assets/maplibre.js");
    firstScript?.dispatchEvent(new Event("error"));
    await expect(firstAttempt).rejects.toThrow("MapLibre runtime failed to load");
    expect(document.querySelector("script[data-atlas-maplibre]")).toBeNull();

    const runtime = { Map: class {} } as unknown as ReturnType<typeof getMapLibreRuntime>;
    document.querySelector<HTMLLinkElement>("link[data-atlas-maplibre-style]")?.dispatchEvent(new Event("load"));
    vi.stubGlobal("maplibregl", runtime);
    const secondAttempt = loadMapLibre();
    await expect(secondAttempt).resolves.toBe(runtime);
  });

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

  it("removes a MapLibre script with no global and retries with one fresh script", async () => {
    const firstAttempt = loadMapLibre();
    const firstScript = document.querySelector<HTMLScriptElement>("script[data-atlas-maplibre]");
    const stylesheetSelector = "link[data-atlas-maplibre-style]";
    expect(firstScript).not.toBeNull();
    expect(document.querySelectorAll(stylesheetSelector)).toHaveLength(1);

    firstScript?.dispatchEvent(new Event("load"));
    await expect(firstAttempt).rejects.toThrow("MapLibre runtime did not initialize");
    expect(document.querySelector("script[data-atlas-maplibre]")).toBeNull();
    expect(document.querySelectorAll(stylesheetSelector)).toHaveLength(1);

    const secondAttempt = loadMapLibre();
    const secondScript = document.querySelector<HTMLScriptElement>("script[data-atlas-maplibre]");
    expect(secondScript).not.toBeNull();
    expect(secondScript).not.toBe(firstScript);
    expect(document.querySelectorAll(stylesheetSelector)).toHaveLength(1);

    const runtime = { Map: class {} } as unknown as ReturnType<typeof getMapLibreRuntime>;
    vi.stubGlobal("maplibregl", runtime);
    document.querySelector<HTMLLinkElement>(stylesheetSelector)?.dispatchEvent(new Event("load"));
    secondScript?.dispatchEvent(new Event("load"));
    await expect(secondAttempt).resolves.toBe(runtime);
  });

  it("rejects on MapLibre stylesheet failure and retries with fresh assets", async () => {
    const firstAttempt = loadMapLibre();
    const firstStylesheet = document.querySelector<HTMLLinkElement>("link[data-atlas-maplibre-style]");
    const firstScript = document.querySelector<HTMLScriptElement>("script[data-atlas-maplibre]");
    expect(firstStylesheet).not.toBeNull();
    expect(firstScript).not.toBeNull();

    firstStylesheet?.dispatchEvent(new Event("error"));
    await expect(firstAttempt).rejects.toThrow("MapLibre stylesheet failed to load");
    expect(document.querySelector("link[data-atlas-maplibre-style]")).toBeNull();
    expect(document.querySelector("script[data-atlas-maplibre]")).toBeNull();

    const secondAttempt = loadMapLibre();
    const secondStylesheet = document.querySelector<HTMLLinkElement>("link[data-atlas-maplibre-style]");
    const secondScript = document.querySelector<HTMLScriptElement>("script[data-atlas-maplibre]");
    expect(secondStylesheet).not.toBeNull();
    expect(secondScript).not.toBeNull();
    expect(secondStylesheet).not.toBe(firstStylesheet);
    expect(secondScript).not.toBe(firstScript);
    expect(document.querySelectorAll("link[data-atlas-maplibre-style]")).toHaveLength(1);
    expect(document.querySelectorAll("script[data-atlas-maplibre]")).toHaveLength(1);

    const runtime = { Map: class {} } as unknown as ReturnType<typeof getMapLibreRuntime>;
    vi.stubGlobal("maplibregl", runtime);
    secondStylesheet?.dispatchEvent(new Event("load"));
    secondScript?.dispatchEvent(new Event("load"));
    await expect(secondAttempt).resolves.toBe(runtime);
  });

  it("does not reuse a global MapLibre runtime before stylesheet readiness", async () => {
    const runtime = { Map: class {} } as unknown as ReturnType<typeof getMapLibreRuntime>;
    vi.stubGlobal("maplibregl", runtime);
    expect(getMapLibreRuntime()).toBeUndefined();

    const attempt = loadMapLibre();
    const stylesheet = document.querySelector<HTMLLinkElement>("link[data-atlas-maplibre-style]");
    expect(stylesheet).not.toBeNull();
    expect(document.querySelector("script[data-atlas-maplibre]")).toBeNull();

    let resolved = false;
    void attempt.then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);

    stylesheet?.dispatchEvent(new Event("load"));
    await expect(attempt).resolves.toBe(runtime);
    expect(getMapLibreRuntime()).toBe(runtime);
  });

  it("removes the script when the stylesheet fails after script readiness", async () => {
    const attempt = loadMapLibre();
    const stylesheet = document.querySelector<HTMLLinkElement>("link[data-atlas-maplibre-style]");
    const script = document.querySelector<HTMLScriptElement>("script[data-atlas-maplibre]");
    const runtime = { Map: class {} } as unknown as ReturnType<typeof getMapLibreRuntime>;
    vi.stubGlobal("maplibregl", runtime);
    script?.dispatchEvent(new Event("load"));
    stylesheet?.dispatchEvent(new Event("error"));

    await expect(attempt).rejects.toThrow("MapLibre stylesheet failed to load");
    expect(document.querySelector("link[data-atlas-maplibre-style]")).toBeNull();
    expect(document.querySelector("script[data-atlas-maplibre]")).toBeNull();
    expect(getMapLibreRuntime()).toBeUndefined();

    const retry = loadMapLibre();
    const retryStylesheet = document.querySelector<HTMLLinkElement>("link[data-atlas-maplibre-style]");
    expect(retryStylesheet).not.toBe(stylesheet);
    expect(document.querySelector("script[data-atlas-maplibre]")).toBeNull();
    retryStylesheet?.dispatchEvent(new Event("load"));
    await expect(retry).resolves.toBe(runtime);
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
    const script = document.querySelector<HTMLScriptElement>("script[data-atlas-maplibre]");
    const runtime = { Map: class {} } as unknown as ReturnType<typeof getMapLibreRuntime>;
    expect(document.querySelectorAll("link[data-atlas-maplibre-style]")).toHaveLength(1);
    vi.stubGlobal("maplibregl", runtime);
    script?.dispatchEvent(new Event("load"));

    await expect(attempt).resolves.toBe(runtime);
    expect(document.querySelectorAll("link[data-atlas-maplibre-style]")).toHaveLength(1);
  });

  it("resolves MapLibre when the injected script initializes the global", async () => {
    const runtime = { Map: class {} } as unknown as ReturnType<typeof getMapLibreRuntime>;
    const attempt = loadMapLibre();
    const concurrentAttempt = loadMapLibre();
    const stylesheet = document.querySelector<HTMLLinkElement>("link[data-atlas-maplibre-style]");
    const script = document.querySelector<HTMLScriptElement>("script[data-atlas-maplibre]");
    expect(document.querySelectorAll("link[data-atlas-maplibre-style]")).toHaveLength(1);
    expect(document.querySelectorAll("script[data-atlas-maplibre]")).toHaveLength(1);
    vi.stubGlobal("maplibregl", runtime);
    stylesheet?.dispatchEvent(new Event("load"));
    script?.dispatchEvent(new Event("load"));

    await expect(attempt).resolves.toBe(runtime);
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
