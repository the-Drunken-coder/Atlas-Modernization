const ABSOLUTE_HTTP_URL = /^https?:\/\//i;

export function normalizeAtlasBaseUrl(baseUrl: string): string {
  const value = baseUrl.trim();
  if (!value || value.startsWith("//")) {
    throw new TypeError("Atlas base URL must be an absolute HTTP(S) URL or a root-relative path");
  }

  if (value.startsWith("/")) {
    if (value.includes("?") || value.includes("#")) {
      throw new TypeError("Atlas base URL must not contain a query string or fragment");
    }
    return stripTrailingSlashes(value);
  }

  if (!ABSOLUTE_HTTP_URL.test(value)) {
    throw new TypeError("Atlas base URL must be an absolute HTTP(S) URL or a root-relative path");
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError("Atlas base URL is invalid");
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) {
    throw new TypeError("Atlas base URL must use HTTP(S) without credentials");
  }
  if (parsed.search || parsed.hash) {
    throw new TypeError("Atlas base URL must not contain a query string or fragment");
  }

  const path = stripTrailingSlashes(parsed.pathname);
  return `${parsed.protocol}//${parsed.host}${path === "/" ? "" : path}`;
}

export function joinAtlasUrl(baseUrl: string, endpoint: string): string {
  const base = normalizeAtlasBaseUrl(baseUrl);
  if (!endpoint.startsWith("/") || endpoint.startsWith("//") || endpoint.includes("#")) {
    throw new TypeError("Atlas endpoint must be a root-relative path without a fragment");
  }
  return base === "/" ? endpoint : `${base}${endpoint}`;
}

function stripTrailingSlashes(value: string): string {
  const stripped = value.replace(/\/+$/, "");
  return stripped || "/";
}
