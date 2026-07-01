import { ATLAS_PROTOCOL_REVISION } from "../../atlas_sdk/src/index.js";

type APIErrorResponse = {
  success: false;
  error_code: string;
  message: string;
  details?: Record<string, string | number | boolean | null>;
};

class WorkerHTTPError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, string | number | boolean | null>;

  constructor(status: number, code: string, message: string, details: Record<string, string | number | boolean | null> = {}) {
    super(message);
    this.name = "WorkerHTTPError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleCommandRequest(request, env);
  }
} satisfies ExportedHandler<Env>;

export async function handleCommandRequest(request: Request, env: Env): Promise<Response> {
  try {
    const url = new URL(request.url);
    if (url.pathname === "/api/config" && request.method === "GET") {
      requiredString(env.ATLAS_CORE_BASE_URL, "ATLAS_CORE_BASE_URL");
      const mapStyleUrl = optionalString(env.MAP_STYLE_URL);
      return jsonResponse({
        atlasBaseUrl: new URL("/atlas", url.origin).toString(),
        protocolRevision: ATLAS_PROTOCOL_REVISION,
        ...(mapStyleUrl ? { mapStyleUrl } : {})
      });
    }
    if (url.pathname === "/api/auth/me" && request.method === "GET") {
      return authSessionResponse(request, requiredString(env.ATLAS_CORE_BASE_URL, "ATLAS_CORE_BASE_URL"));
    }
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      throw new WorkerHTTPError(404, "NOT_FOUND", "API route not found", { path: url.pathname });
    }
    if (url.pathname === "/atlas" || url.pathname.startsWith("/atlas/")) {
      return proxyAtlasCore(request, url, requiredString(env.ATLAS_CORE_BASE_URL, "ATLAS_CORE_BASE_URL"));
    }
    if (
      url.pathname === "/auth" ||
      url.pathname.startsWith("/auth/") ||
      url.pathname === "/admin/auth" ||
      url.pathname.startsWith("/admin/auth/") ||
      url.pathname === "/admin/api-keys" ||
      url.pathname.startsWith("/admin/api-keys/") ||
      url.pathname === "/me/settings"
    ) {
      throw new WorkerHTTPError(404, "NOT_FOUND", "Route is owned by Atlas Core or has been removed", { path: url.pathname });
    }
    return await env.ASSETS.fetch(request);
  } catch (error) {
    return errorResponse(error, request);
  }
}

async function authSessionResponse(request: Request, atlasBaseUrl: string): Promise<Response> {
  const response = await fetchAtlasCore(request, atlasBaseUrl, "/admin/auth/me", "");
  if (response.status === 401) {
    return jsonResponse({ authenticated: false });
  }
  if (!response.ok) {
    return response;
  }
  const body = (await response.json()) as { user?: unknown };
  return jsonResponse({ authenticated: true, user: body.user });
}

async function proxyAtlasCore(request: Request, url: URL, atlasBaseUrl: string): Promise<Response> {
  return fetchAtlasCore(request, atlasBaseUrl, url.pathname.slice("/atlas".length) || "/", url.search);
}

async function fetchAtlasCore(request: Request, atlasBaseUrl: string, path: string, search: string): Promise<Response> {
  const target = new URL(atlasBaseUrl.replace(/\/+$/, ""));
  target.pathname = proxyPath(target.pathname, path);
  target.search = search;
  return fetch(await coreRequest(request, target));
}

async function coreRequest(request: Request, target: URL): Promise<Request> {
  const headers = new Headers(request.headers);
  const browserOrigin = headers.get("Origin")?.trim() || new URL(request.url).origin;
  headers.set("Origin", browserOrigin);
  if (!headers.has("Referer")) headers.set("Referer", `${browserOrigin}/`);
  const init: RequestInit = {
    headers,
    method: request.method,
    redirect: "manual"
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = await request.arrayBuffer();
  }
  return new Request(target, init);
}

function proxyPath(basePath: string, suffix: string): string {
  const normalizedBase = basePath.replace(/\/+$/, "");
  return `${normalizedBase}${suffix}` || "/";
}

function requiredString(value: unknown, name: string): string {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  throw new WorkerHTTPError(500, "CONFIGURATION_ERROR", `${name} is not configured`);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(body), { ...init, headers });
}

function errorResponse(error: unknown, request: Request): Response {
  if (error instanceof WorkerHTTPError) {
    if (error.status >= 500) {
      console.error("Atlas command interface Worker error", {
        code: error.code,
        message: error.message,
        path: new URL(request.url).pathname
      });
    }
    const body: APIErrorResponse = {
      success: false,
      error_code: error.code,
      message: error.message,
      ...(Object.keys(error.details).length > 0 ? { details: error.details } : {})
    };
    return jsonResponse(body, { status: error.status });
  }
  console.error("Atlas command interface Worker unhandled error", {
    message: error instanceof Error ? error.message : String(error),
    path: new URL(request.url).pathname
  });
  return jsonResponse(
    {
      success: false,
      error_code: "INTERNAL_ERROR",
      message: "Unexpected Worker error"
    } satisfies APIErrorResponse,
    { status: 500 }
  );
}
