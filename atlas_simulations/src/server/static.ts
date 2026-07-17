import { createReadStream, existsSync, realpathSync, statSync } from "node:fs";
import type { ServerResponse } from "node:http";
import path from "node:path";
import { errorMessage, safeDecodeURIComponent, sendJSON } from "./http-utils.js";

const UI_SECURITY_HEADERS = {
  "Content-Security-Policy": [
    "default-src 'self'",
    "base-uri 'none'",
    "connect-src 'self'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'"
  ].join("; "),
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY"
};

export function serveStatic(
  response: ServerResponse,
  packageRoot: string,
  requestPath: string,
  headOnly = false,
  allowSpaFallback = true
): void {
  const staticRoot = path.join(packageRoot, "dist/client");
  const target = safeStaticPath(staticRoot, requestPath);
  if (target === "invalid-encoding") {
    response.writeHead(400, { ...UI_SECURITY_HEADERS, "Content-Type": "text/plain; charset=utf-8" });
    response.end(headOnly ? undefined : "Request path must use valid URL encoding");
    return;
  }
  if (target === "invalid-path") {
    response.writeHead(400, { ...UI_SECURITY_HEADERS, "Content-Type": "text/plain; charset=utf-8" });
    response.end(headOnly ? undefined : "Request path must stay inside the client root");
    return;
  }
  const file =
    target && existsSync(target) && statSync(target).isFile()
      ? target
      : allowSpaFallback
        ? path.join(staticRoot, "index.html")
        : undefined;
  if (!file) {
    response.writeHead(404, { ...UI_SECURITY_HEADERS, "Content-Type": "text/plain; charset=utf-8" });
    response.end(headOnly ? undefined : "Static asset not found");
    return;
  }
  if (!existsSync(file)) {
    response.writeHead(404, { ...UI_SECURITY_HEADERS, "Content-Type": "text/plain; charset=utf-8" });
    response.end(
      headOnly ? undefined : "Atlas Simulations UI has not been built. Run npm run build or use npm run dev."
    );
    return;
  }
  if (!isRealPathInsideRoot(staticRoot, file)) {
    response.writeHead(404, { ...UI_SECURITY_HEADERS, "Content-Type": "text/plain; charset=utf-8" });
    response.end(headOnly ? undefined : "Static asset not found");
    return;
  }
  if (headOnly) {
    response.writeHead(200, { ...UI_SECURITY_HEADERS, "Content-Type": contentType(file) });
    response.end();
    return;
  }
  const stream = createReadStream(file);
  stream.once("open", () => {
    response.writeHead(200, { ...UI_SECURITY_HEADERS, "Content-Type": contentType(file) });
    stream.pipe(response);
  });
  stream.on("error", (error) => {
    if (!response.headersSent) {
      sendJSON(response, 500, { message: errorMessage(error) });
      return;
    }
    response.destroy(error);
  });
}

export function shouldServeSpaShell(requestPath: string): boolean {
  return !requestPath.startsWith("/assets/") && !/\/[^/]+\.[^/]+$/.test(requestPath);
}

function isRealPathInsideRoot(staticRoot: string, file: string): boolean {
  const realStaticRoot = realpathSync(staticRoot);
  const realFile = realpathSync(file);
  const relative = path.relative(realStaticRoot, realFile);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function safeStaticPath(
  staticRoot: string,
  requestPath: string
): string | "invalid-encoding" | "invalid-path" | undefined {
  const decoded = safeDecodeURIComponent(requestPath);
  if (decoded === undefined) return "invalid-encoding";
  if (decoded.split(/[\\/]+/).includes("..")) return "invalid-path";
  const normalized = path.normalize(decoded).replace(/^(\.\.[/\\])+/, "");
  const target = path.join(staticRoot, normalized === "/" ? "index.html" : normalized);
  return target.startsWith(staticRoot) ? target : undefined;
}

function contentType(file: string): string {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}
