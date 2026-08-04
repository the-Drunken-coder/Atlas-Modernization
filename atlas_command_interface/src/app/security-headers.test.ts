import { describe, expect, it } from "vitest";
import { type AppConfig, appConfigFromEnv } from "./config.js";
import { renderSecurityHeaders } from "./security-headers.js";

const headers = renderSecurityHeaders({});

describe("Cloudflare Pages security headers", () => {
  it("locks down executable content and framing", () => {
    expect(headers.split(/\r?\n/).find((line) => line.trim())).toBe("/*");
    expect(headers.split(/\r?\n/).every((line) => line.length <= 2_000)).toBe(true);
    expect(headerValue("X-Content-Type-Options")).toBe("nosniff");
    expect(headerValue("X-Frame-Options")).toBe("DENY");
    expect(headerValue("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(headerValue("Permissions-Policy")).toBe("camera=(), geolocation=(), microphone=()");

    expect(cspDirective("default-src")).toEqual(["'self'"]);
    expect(cspDirective("base-uri")).toEqual(["'none'"]);
    expect(cspDirective("object-src")).toEqual(["'none'"]);
    expect(cspDirective("frame-src")).toEqual(["'none'"]);
    expect(cspDirective("frame-ancestors")).toEqual(["'none'"]);
    expect(cspDirective("form-action")).toEqual(["'self'"]);
    expect(cspDirective("script-src")).toEqual(["'self'"]);
    expect(cspDirective("style-src")).toEqual(["'self'", "'unsafe-inline'"]);
    expect(cspDirective("worker-src")).toEqual(["'self'", "blob:"]);
    expect(cspDirective("child-src")).toEqual(["blob:"]);
  });

  it("allows the production Core transports and every configured raster provider origin", () => {
    const config = appConfigFromEnv({
      DEV: false,
      MODE: "production",
      googleMapsTileSession: "google-session",
      VITE_GOOGLE_MAPS_API_KEY: "google-key",
      VITE_MAPBOX_ACCESS_TOKEN: "mapbox-token",
      VITE_MAPTILER_API_KEY: "maptiler-key",
      VITE_THUNDERFOREST_API_KEY: "thunderforest-key"
    });
    const providerOrigins = rasterTileOrigins(config);
    const coreOrigin = new URL(config.atlasBaseUrl).origin;
    const websocketOrigin = coreOrigin.replace(/^http/, "ws");
    const connectSources = cspDirective("connect-src");
    const imageSources = cspDirective("img-src");

    expect(connectSources).toEqual(expect.arrayContaining(["'self'", coreOrigin, websocketOrigin, ...providerOrigins]));
    expect(connectSources).not.toContain("*");
    expect(connectSources).not.toContain("https:");
    expect(connectSources).not.toContain("wss:");
    expect(imageSources).toEqual(expect.arrayContaining(["'self'", "data:", "blob:", ...providerOrigins]));
  });

  it("allows the Core origin selected for a custom Pages build", () => {
    const customHeaders = renderSecurityHeaders({ VITE_ATLAS_CORE_BASE_URL: "https://staging-core.example.test/path" });

    expect(cspDirective("connect-src", customHeaders)).toEqual(
      expect.arrayContaining(["https://staging-core.example.test", "wss://staging-core.example.test"])
    );
    expect(cspDirective("script-src", customHeaders)).toEqual(["'self'"]);
    expect(cspDirective("frame-ancestors", customHeaders)).toEqual(["'none'"]);
  });

  it("uses self without inventing an origin for a root-relative Core base path", () => {
    const relativeHeaders = renderSecurityHeaders({ VITE_ATLAS_CORE_BASE_URL: "/atlas" });
    const connectSources = cspDirective("connect-src", relativeHeaders);

    expect(connectSources).toContain("'self'");
    expect(connectSources).not.toContain("http://localhost");
    expect(connectSources).not.toContain("ws://localhost");
  });
});

function headerValue(name: string, source = headers): string {
  const prefix = `${name.toLowerCase()}:`;
  const line = source
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find((value) => value.toLowerCase().startsWith(prefix));
  if (!line) throw new Error(`Missing ${name} header`);
  return line.slice(line.indexOf(":") + 1).trim();
}

function cspDirective(name: string, source = headers): string[] {
  const directive = headerValue("Content-Security-Policy", source)
    .split(";")
    .map((value) => value.trim())
    .find((value) => value === name || value.startsWith(`${name} `));
  if (!directive) throw new Error(`Missing ${name} CSP directive`);
  return directive.split(/\s+/).slice(1);
}

function rasterTileOrigins(config: AppConfig): string[] {
  return [
    ...new Set(
      config.mapSources.flatMap((source) => {
        const rasterSource = source.style?.sources[source.id] as { tiles?: string[] } | undefined;
        return rasterSource?.tiles?.map((tile) => new URL(tile).origin) ?? [];
      })
    )
  ].sort();
}
