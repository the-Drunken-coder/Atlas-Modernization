import { appConfigFromEnv, MAP_PROVIDER_MANIFEST } from "./config.js";

const tileOrigins = [
  ...new Set(MAP_PROVIDER_MANIFEST.flatMap((provider) => provider.tiles.map((template) => new URL(template).origin)))
];

export function renderSecurityHeaders(env: Record<string, string | boolean | undefined>): string {
  const coreBaseUrl = appConfigFromEnv({ DEV: false, MODE: "production", ...env }).atlasBaseUrl;
  const coreSources = coreBaseUrl.startsWith("/")
    ? []
    : [new URL(coreBaseUrl).origin, new URL(coreBaseUrl).origin.replace(/^http/, "ws")];
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
    `connect-src 'self' ${coreSources.join(" ")} ${tileOrigins.join(" ")}`,
    "worker-src 'self' blob:",
    "child-src blob:"
  ].join("; ");

  return `/*\n  Content-Security-Policy: ${csp}\n  X-Content-Type-Options: nosniff\n  X-Frame-Options: DENY\n  Referrer-Policy: strict-origin-when-cross-origin\n  Permissions-Policy: camera=(), geolocation=(), microphone=()\n`;
}
