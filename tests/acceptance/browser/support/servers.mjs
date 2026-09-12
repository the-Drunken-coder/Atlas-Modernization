import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, statSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer as createHTTPSServer } from "node:https";
import { connect as connectTCP } from "node:net";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const fixtureRoot = fileURLToPath(new URL("../fixtures/", import.meta.url));
const loopbackTLS = {
  cert: readFileSync(join(fixtureRoot, "loopback-cert.pem")),
  key: readFileSync(join(fixtureRoot, "loopback-key.pem"))
};
const mapTile = Buffer.from(readFileSync(join(fixtureRoot, "map-tile.base64"), "utf8").trim(), "base64");
const fixtureTilePath = "/__atlas_fixture__/map-tile.png";
const commandTimeoutMs = 10 * 60_000;

export async function prepareBrowserServers({ artifacts }) {
  const transportLog = join(artifacts, "browser-transport.jsonl");
  const observations = [];
  const sockets = new Set();
  let appRoot;
  let coreTarget;
  let mapTileRequests = 0;

  const appServer = createHTTPSServer(loopbackTLS, (request, response) => {
    const url = requestURL(request);
    if (!url) {
      respond(response, 400, "text/plain; charset=utf-8", "Bad request\n");
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      respond(response, 405, "text/plain; charset=utf-8", "Method not allowed\n");
      return;
    }
    if (url.pathname === fixtureTilePath) {
      mapTileRequests += 1;
      response.writeHead(200, {
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
        "Content-Length": mapTile.length,
        "Content-Type": "image/png"
      });
      if (request.method === "HEAD") response.end();
      else response.end(mapTile);
      return;
    }
    if (!appRoot) {
      respond(response, 503, "text/plain; charset=utf-8", "Command Interface build is not ready\n");
      return;
    }
    serveBuiltAsset(request, response, appRoot, url.pathname);
  });

  const coreProxy = createHTTPSServer(loopbackTLS, (request, response) => {
    const observation = transportObservation("request", request);
    observations.push(observation);
    appendJSON(transportLog, observation);
    if (!coreTarget) {
      respond(response, 503, "application/json", '{"message":"Core proxy target is not ready"}\n');
      return;
    }
    proxyHTTPRequest(request, response, coreTarget, transportLog, sockets);
  });
  coreProxy.on("upgrade", (request, socket, head) => {
    const observation = transportObservation("upgrade", request);
    observations.push(observation);
    appendJSON(transportLog, observation);
    if (!coreTarget) {
      socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      return;
    }
    proxyWebSocket(request, socket, head, coreTarget, transportLog, sockets);
  });

  trackSockets(appServer, sockets);
  trackSockets(coreProxy, sockets);
  let appPort;
  let coreProxyPort;
  try {
    [appPort, coreProxyPort] = await Promise.all([listen(appServer), listen(coreProxy)]);
  } catch (error) {
    for (const socket of sockets) socket.destroy();
    await Promise.allSettled([close(appServer), close(coreProxy)]);
    throw error;
  }
  const appOrigin = `https://127.0.0.1:${appPort}`;
  const coreOrigin = `https://127.0.0.1:${coreProxyPort}`;
  let closed = false;

  return {
    appOrigin,
    coreOrigin,
    fixtureTileUrl: `${appOrigin}${fixtureTilePath}`,
    metadata: {
      app_origin: appOrigin,
      core_proxy_origin: coreOrigin,
      map_fixture: fixtureTilePath,
      tls: "self-signed loopback certificate"
    },
    pointCoreAt(baseUrl) {
      coreTarget = new URL(baseUrl);
    },
    serveAppFrom(path) {
      appRoot = resolve(path);
    },
    mapTileRequestCount() {
      return mapTileRequests;
    },
    transportObservations() {
      return [...observations];
    },
    async cleanup() {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      await Promise.allSettled([close(appServer), close(coreProxy)]);
    }
  };
}

export async function buildCommandInterface({ coreOrigin, artifacts, signal }) {
  const logPath = join(artifacts, "browser-build.log");
  await runLoggedCommand("npm", ["run", "build:command-interface"], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      VITE_ATLAS_CORE_BASE_URL: coreOrigin,
      VITE_MAPTILER_API_KEY: "atlas-local-map-fixture"
    },
    logPath,
    signal,
    timeoutMs: commandTimeoutMs
  });
  return join(repositoryRoot, "surfaces", "command-interface", "dist", "client");
}

function proxyHTTPRequest(request, response, target, transportLog, sockets) {
  const upstream = httpRequest(
    {
      hostname: target.hostname,
      port: target.port,
      method: request.method,
      path: request.url,
      headers: { ...request.headers, host: target.host }
    },
    (upstreamResponse) => {
      appendJSON(transportLog, {
        timestamp: new Date().toISOString(),
        event: "response",
        method: request.method,
        path: request.url,
        status: upstreamResponse.statusCode
      });
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    }
  );
  upstream.once("socket", (socket) => trackSocket(socket, sockets));
  upstream.once("error", (error) => {
    appendJSON(transportLog, {
      timestamp: new Date().toISOString(),
      event: "proxy-error",
      method: request.method,
      path: request.url,
      message: error.message
    });
    if (!response.headersSent) respond(response, 502, "text/plain; charset=utf-8", "Core proxy failed\n");
    else response.destroy(error);
  });
  request.pipe(upstream);
}

function proxyWebSocket(request, socket, head, target, transportLog, sockets) {
  const upstream = connectTCP(Number(target.port), target.hostname);
  trackSocket(upstream, sockets);
  upstream.once("connect", () => {
    const headers = { ...request.headers, host: target.host };
    const serializedHeaders = Object.entries(headers)
      .flatMap(([name, value]) => {
        if (Array.isArray(value)) return value.map((entry) => `${name}: ${entry}`);
        return value === undefined ? [] : [`${name}: ${value}`];
      })
      .join("\r\n");
    upstream.write(`${request.method} ${request.url} HTTP/${request.httpVersion}\r\n${serializedHeaders}\r\n\r\n`);
    if (head.length > 0) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.once("error", (error) => {
    appendJSON(transportLog, {
      timestamp: new Date().toISOString(),
      event: "proxy-upgrade-error",
      method: request.method,
      path: request.url,
      message: error.message
    });
    socket.destroy(error);
  });
}

function serveBuiltAsset(request, response, root, pathname) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    respond(response, 400, "text/plain; charset=utf-8", "Bad request\n");
    return;
  }
  const relativePath = normalize(decodedPath).replace(/^[/\\]+/u, "");
  const candidate = resolve(root, relativePath || "index.html");
  const withinRoot = candidate === root || candidate.startsWith(`${root}${sep}`);
  const path = withinRoot && isFile(candidate) ? candidate : join(root, "index.html");
  if (!isFile(path)) {
    respond(response, 404, "text/plain; charset=utf-8", "Not found\n");
    return;
  }
  const body = readFileSync(path);
  response.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Length": body.length,
    "Content-Type": contentType(path)
  });
  if (request.method === "HEAD") response.end();
  else response.end(body);
}

function requestURL(request) {
  try {
    return new URL(request.url ?? "/", "https://127.0.0.1");
  } catch {
    return undefined;
  }
}

function transportObservation(event, request) {
  return {
    timestamp: new Date().toISOString(),
    event,
    method: request.method,
    path: request.url,
    origin: request.headers.origin ?? null,
    cookie_names: cookieNames(request.headers.cookie)
  };
}

function trackSockets(server, sockets) {
  server.on("connection", (socket) => {
    trackSocket(socket, sockets);
  });
}

function trackSocket(socket, sockets) {
  if (sockets.has(socket)) return;
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
}

function listen(server) {
  return new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      server.off("error", rejectPromise);
      const address = server.address();
      if (!address || typeof address === "string") {
        rejectPromise(new Error("browser fixture server did not obtain a loopback port"));
        return;
      }
      resolvePromise(address.port);
    });
  });
}

function close(server) {
  return new Promise((resolvePromise, rejectPromise) => {
    if (!server.listening) {
      resolvePromise();
      return;
    }
    server.close((error) => (error ? rejectPromise(error) : resolvePromise()));
  });
}

function runLoggedCommand(command, args, { cwd, env, logPath, signal, timeoutMs }) {
  appendFileSync(logPath, `$ ${[command, ...args].join(" ")}\n`);
  return new Promise((resolvePromise, rejectPromise) => {
    const grouped = process.platform !== "win32";
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: grouped });
    let settled = false;
    let timedOut = false;
    const append = (stream, chunk) => {
      const value = String(chunk);
      appendFileSync(logPath, value);
      (stream === "stdout" ? process.stdout : process.stderr).write(value);
    };
    child.stdout.on("data", (chunk) => append("stdout", chunk));
    child.stderr.on("data", (chunk) => append("stderr", chunk));
    const stop = () => terminateChild(child, grouped, "SIGTERM");
    signal.addEventListener("abort", stop, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      terminateChild(child, grouped, "SIGTERM");
      setTimeout(() => terminateChild(child, grouped, "SIGKILL"), 5_000).unref();
    }, timeoutMs);
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", stop);
      if (error) rejectPromise(error);
      else resolvePromise();
    };
    child.once("error", (error) => finish(new Error(`failed to run ${command}: ${error.message}`)));
    child.once("close", (code, childSignal) => {
      if (signal.aborted) {
        finish(signal.reason);
        return;
      }
      if (timedOut) {
        finish(new Error(`${command} ${args.join(" ")} exceeded ${timeoutMs} ms`));
        return;
      }
      if (code !== 0) {
        finish(new Error(`${command} ${args.join(" ")} exited ${code ?? childSignal ?? "without a status"}`));
        return;
      }
      finish();
    });
  });
}

function terminateChild(child, grouped, signal) {
  try {
    if (grouped && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function cookieNames(header) {
  if (typeof header !== "string") return [];
  return header
    .split(";")
    .map((cookie) => {
      const separator = cookie.indexOf("=");
      return separator > 0 ? cookie.slice(0, separator).trim() : "";
    })
    .filter(Boolean);
}

function contentType(path) {
  switch (extname(path)) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".map":
      return "application/json; charset=utf-8";
    case ".png":
      return "image/png";
    case ".svg":
      return "image/svg+xml";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function respond(response, status, type, body) {
  response.writeHead(status, { "Content-Type": type });
  response.end(body);
}

function appendJSON(path, value) {
  appendFileSync(path, `${JSON.stringify(value)}\n`);
}
