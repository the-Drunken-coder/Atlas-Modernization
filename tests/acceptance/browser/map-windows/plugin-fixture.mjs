import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const fixture = JSON.parse(readFileSync(new URL("./fixture.json", import.meta.url), "utf8"));

const server = createServer((request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    writeJSON(response, 200, { status: "ok" });
    return;
  }
  if (request.method === "GET" && request.url === "/manifest") {
    writeJSON(response, 200, fixture.manifest);
    return;
  }
  if (request.method === "POST" && request.url === "/operations/inspect_map_windows") {
    writeJSON(response, 200, fixture.result);
    return;
  }
  writeJSON(response, 404, { code: "route_not_found" });
});

server.listen(8080, "0.0.0.0");

function writeJSON(response, status, body) {
  const serialized = `${JSON.stringify(body)}\n`;
  response.writeHead(status, {
    "Content-Length": Buffer.byteLength(serialized),
    "Content-Type": "application/json; charset=utf-8"
  });
  response.end(serialized);
}
