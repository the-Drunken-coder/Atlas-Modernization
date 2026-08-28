const ABSOLUTE_HTTP_URL = /^https?:\/\//i;

export function normalizeAtlasBaseUrl(baseUrl: string): string {
  const value = baseUrl.trim();
  if (!value || hasUnsafeUrlCharacters(value) || value.startsWith("//")) {
    throw new TypeError("Atlas base URL must be an absolute HTTP(S) URL or a root-relative path");
  }
  if (hasPathTraversal(value)) {
    throw new TypeError("Atlas base URL must not contain path traversal");
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
  if (
    hasUnsafeUrlCharacters(endpoint) ||
    hasPathTraversal(endpoint) ||
    !endpoint.startsWith("/") ||
    endpoint.startsWith("//") ||
    endpoint.includes("#")
  ) {
    throw new TypeError("Atlas endpoint must be a safe root-relative path without a fragment");
  }
  return base === "/" ? endpoint : `${base}${endpoint}`;
}

export function pathWithQuery(path: string, params: Record<string, string | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) query.set(key, value);
  }
  const encoded = query.toString();
  return encoded ? `${path}?${encoded}` : path;
}

function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") {
    end -= 1;
  }
  return end === 0 ? "/" : value.slice(0, end);
}

function hasUnsafeUrlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (value[index] === "\\" || code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function hasPathTraversal(value: string): boolean {
  const queryStart = value.indexOf("?");
  const path = queryStart === -1 ? value : value.slice(0, queryStart);
  const normalizedPath = path.toLowerCase().replaceAll("%2f", "/").replaceAll("%5c", "/");
  return normalizedPath.split("/").some((segment) => {
    const decodedDots = segment.replaceAll("%2e", ".");
    return decodedDots === "." || decodedDots === "..";
  });
}
