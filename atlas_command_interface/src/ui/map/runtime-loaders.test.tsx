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
    secondScript?.dispatchEvent(new Event("load"));
    await expect(secondAttempt).resolves.toBe(runtime);
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

  it("resolves MapLibre when the injected script initializes the global", async () => {
    const runtime = { Map: class {} } as unknown as ReturnType<typeof getMapLibreRuntime>;
    const attempt = loadMapLibre();
    const script = document.querySelector<HTMLScriptElement>("script[data-atlas-maplibre]");
    vi.stubGlobal("maplibregl", runtime);
    script?.dispatchEvent(new Event("load"));

    await expect(attempt).resolves.toBe(runtime);
    expect(getMapLibreRuntime()).toBe(runtime);
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
