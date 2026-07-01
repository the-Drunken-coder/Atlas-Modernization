import { describe, expect, it, vi } from "vitest";
import { handleCommandRequest } from "./index.js";

describe("thin Worker", () => {
  it("serves browser config without secrets", async () => {
    const response = await handleCommandRequest(new Request("https://command.test/api/config"), env());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      atlasBaseUrl: "/atlas",
      protocolRevision: expect.any(String)
    });
  });

  it("omits empty optional map style URLs", async () => {
    const response = await handleCommandRequest(new Request("https://command.test/api/config"), env({ MAP_STYLE_URL: "   " }));
    const config = (await response.json()) as Record<string, unknown>;

    expect(config).not.toHaveProperty("mapStyleUrl");
  });

  it("proxies Atlas routes to configured Core", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("proxied", { status: 202 }));

    try {
      const response = await handleCommandRequest(
        new Request("https://command.test/atlas/entities?limit=1", {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: "https://command.test" },
          body: JSON.stringify({ entity_id: "asset-1" })
        }),
        env()
      );

      expect(response.status).toBe(202);
      expect(await response.text()).toBe("proxied");
      expect(fetchSpy).toHaveBeenCalledOnce();
      const proxied = fetchSpy.mock.calls[0]?.[0] as Request;
      expect(proxied.url).toBe("https://core.test/entities?limit=1");
      expect(proxied.method).toBe("POST");
      expect(proxied.headers.get("Content-Type")).toBe("application/json");
      expect(proxied.headers.get("Origin")).toBe("https://command.test");
      await expect(proxied.text()).resolves.toBe(JSON.stringify({ entity_id: "asset-1" }));
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("maps missing Core session to a clean signed-out response", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ success: false, error_code: "UNAUTHORIZED", message: "unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" }
      })
    );

    try {
      const response = await handleCommandRequest(new Request("https://command.test/api/auth/me", { headers: { Cookie: "atlas_session=old" } }), env());

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ authenticated: false });
      const proxied = fetchSpy.mock.calls[0]?.[0] as Request;
      expect(proxied.url).toBe("https://core.test/admin/auth/me");
      expect(proxied.headers.get("Cookie")).toBe("atlas_session=old");
      expect(proxied.headers.get("Origin")).toBe("https://command.test");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("does not own legacy direct auth or settings routes", async () => {
    for (const path of ["/auth/login", "/admin/auth/login", "/me/settings"]) {
      const response = await handleCommandRequest(new Request(`https://command.test${path}`), env());
      expect(response.status).toBe(404);
    }
  });

  it("returns JSON 404 for unknown API routes", async () => {
    for (const path of ["/api", "/api/missing"]) {
      const response = await handleCommandRequest(new Request(`https://command.test${path}`), env());
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toMatchObject({ success: false, error_code: "NOT_FOUND" });
    }
  });

  it("falls through to static assets", async () => {
    const assets = vi.fn(async () => new Response("asset"));
    const response = await handleCommandRequest(new Request("https://command.test/"), env({ ASSETS: { fetch: assets } }));

    expect(await response.text()).toBe("asset");
    expect(assets).toHaveBeenCalledOnce();
  });

  it("logs 5xx worker errors", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const response = await handleCommandRequest(new Request("https://command.test/api/config"), env({ ATLAS_CORE_BASE_URL: "" }));

      expect(response.status).toBe(500);
      expect(log).toHaveBeenCalledWith(
        "Atlas command interface Worker error",
        expect.objectContaining({ code: "CONFIGURATION_ERROR", path: "/api/config" })
      );
    } finally {
      log.mockRestore();
    }
  });

  it("does not expose unexpected exception messages in 500 responses", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const response = await handleCommandRequest(
        new Request("https://command.test/static"),
        env({
          ASSETS: {
            fetch: async () => {
              throw new Error("internal secret detail");
            }
          }
        })
      );

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toMatchObject({
        success: false,
        error_code: "INTERNAL_ERROR",
        message: "Unexpected Worker error"
      });
    } finally {
      log.mockRestore();
    }
  });
});

function env(overrides: Partial<Env> = {}): Env {
  return {
    ASSETS: { fetch: async () => new Response("asset") },
    ATLAS_CORE_BASE_URL: "https://core.test/",
    ...overrides
  };
}
