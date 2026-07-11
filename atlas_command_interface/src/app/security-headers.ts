import { appConfigFromEnv } from "./config.js";

const tileOrigins = [
  "https://tile.googleapis.com",
  "https://tile.openstreetmap.org",
  "https://basemap.nationalmap.gov",
  "https://api.mapbox.com",
  "https://api.thunderforest.com",
  "https://api.maptiler.com",
  "https://a.basemaps.cartocdn.com",
  "https://b.basemaps.cartocdn.com",
  "https://c.basemaps.cartocdn.com",
  "https://d.basemaps.cartocdn.com"
];

export function renderSecurityHeaders(env: Record<string, string | boolean | undefined>): string {
  const coreOrigin = new URL(appConfigFromEnv({ DEV: false, MODE: "production", ...env }).atlasBaseUrl).origin;
  const websocketOrigin = coreOrigin.replace(/^http/, "ws");
  const csp = [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: ${tileOrigins.join(" ")}`,
    `connect-src 'self' ${coreOrigin} ${websocketOrigin} ${tileOrigins.join(" ")}`,
    "worker-src 'self' blob:",
    "child-src blob:"
  ].join("; ");

  return `/*\n  Content-Security-Policy: ${csp}\n  X-Content-Type-Options: nosniff\n  X-Frame-Options: DENY\n  Referrer-Policy: strict-origin-when-cross-origin\n  Permissions-Policy: camera=(), geolocation=(), microphone=()\n`;
}
