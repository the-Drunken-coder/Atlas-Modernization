import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../runtime-asset-urls.js", () => ({
  maplibreCssUrl: "/assets/maplibre.css",
  maplibreScriptUrl: "/assets/maplibre.js",
  milsymbolScriptUrl: "/assets/milsymbol.js"
}));

import { getSidcRuntime, loadSidcRuntime } from "../symbols/sidc-runtime.js";
import { getMapLibreRuntime, loadMapLibre } from "./maplibre-runtime.js";

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
