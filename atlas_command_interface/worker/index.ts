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
      const atlasBaseUrl = requiredString(env.ATLAS_CORE_BASE_URL, "ATLAS_CORE_BASE_URL");
      const mapStyleUrl = optionalString(env.MAP_STYLE_URL);
      return jsonResponse({
        atlasBaseUrl: atlasBaseUrl.replace(/\/+$/, ""),
        protocolRevision: ATLAS_PROTOCOL_REVISION,
        ...(mapStyleUrl ? { mapStyleUrl } : {})
      });
    }
    if (url.pathname.startsWith("/api/")) {
      throw new WorkerHTTPError(404, "NOT_FOUND", "API route not found", { path: url.pathname });
    }
    if (url.pathname === "/auth" || url.pathname.startsWith("/auth/") || url.pathname === "/me/settings" || url.pathname === "/atlas" || url.pathname.startsWith("/atlas/")) {
      throw new WorkerHTTPError(404, "NOT_FOUND", "Route is owned by Atlas Core or has been removed", { path: url.pathname });
    }
    return env.ASSETS.fetch(request);
  } catch (error) {
    return errorResponse(error, request);
  }
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
      message: error instanceof Error ? error.message : "Unexpected Worker error"
    } satisfies APIErrorResponse,
    { status: 500 }
  );
}
