import { createServer } from "node:http";

const values = Object.freeze({
  alpha: { label: "Alpha fixture", count: 3 },
  bravo: { label: "Bravo fixture", count: 7 }
});

createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://fixture.invalid");
  if (request.method !== "GET" || url.pathname !== "/fixture") {
    response.writeHead(404).end();
    return;
  }
  const key = url.searchParams.get("key") ?? "";
  const value = values[key];
  if (!value) {
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "fixture_not_found" }));
    return;
  }
  response.writeHead(200, { "Content-Type": "application/json", "X-Fixture": key });
  response.end(JSON.stringify({ value, observed_at: "2026-01-01T00:00:00Z" }));
}).listen(Number(process.env.PORT ?? "8090"), "0.0.0.0");
