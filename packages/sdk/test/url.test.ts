import { describe, expect, it } from "vitest";
import { ATLAS_PROTOCOL_REVISION, AtlasClient, joinAtlasUrl, normalizeAtlasBaseUrl } from "../src";
import { AtlasAdminClient } from "../src/admin.js";
import { pathWithQuery } from "../src/url.js";

describe("Atlas URL handling", () => {
  it.each([
    "ftp://core.test",
    "javascript:alert(1)",
    "//core.test",
    "https://user:secret@core.test",
    "https://core.test?token=secret",
    "https://core.test#fragment",
    "/\\core.test",
    "/atlas\tignored",
    "/atlas/../admin",
    "/../admin",
    "/%2e%2e/admin",
    "/%2e%2e%2fadmin",
    "core.test"
  ])("rejects unsafe base URL %s", (value) => {
    expect(() => normalizeAtlasBaseUrl(value)).toThrow();
  });

  it.each([
    ["https://core.test/atlas/", "https://core.test/atlas"],
    ["http://127.0.0.1:8000/", "http://127.0.0.1:8000"],
    ["/atlas/", "/atlas"],
    ["/", "/"]
  ])("normalizes %s", (value, expected) => {
    expect(normalizeAtlasBaseUrl(value)).toBe(expected);
  });

  it("preserves base paths and endpoint queries", () => {
    expect(joinAtlasUrl("https://core.test/atlas/", "/queries/changed-since?since_version=4")).toBe(
      "https://core.test/atlas/queries/changed-since?since_version=4"
    );
    expect(joinAtlasUrl("/atlas", "/feed")).toBe("/atlas/feed");
  });

  it("builds encoded query paths while omitting unset values", () => {
    expect(pathWithQuery("/queries/full", { cursor: "next page/+", omitted: undefined, limit: "25" })).toBe(
      "/queries/full?cursor=next+page%2F%2B&limit=25"
    );
    expect(pathWithQuery("/queries/full", { cursor: undefined })).toBe("/queries/full");
  });

  it.each([
    "feed",
    "//feed",
    "/feed#fragment",
    "/\\evil.test",
    "/feed\nignored",
    "/atlas/../admin",
    "/../admin",
    "/%2e%2e/admin",
    "/%2E%2E%5Cadmin"
  ])("rejects unsafe endpoint %s", (endpoint) => {
    expect(() => joinAtlasUrl("/", endpoint)).toThrow(
      "Atlas endpoint must be a safe root-relative path without a fragment"
    );
  });

  it("handles long runs of trailing slashes without a regular expression", () => {
    expect(normalizeAtlasBaseUrl(`/atlas${"/".repeat(10_000)}`)).toBe("/atlas");
  });

  it("uses the same base path for resource and admin HTTP", async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      calls.push(String(input));
      if (String(input).endsWith("/admin/auth/me")) {
        return Response.json({ user: { username: "admin" } });
      }
      return Response.json({
        entities: [],
        tasks: [],
        objects: [],
        version: 0,
        has_more_entities: false,
        has_more_tasks: false,
        has_more_objects: false
      });
    };
    const client = new AtlasClient({ baseUrl: "https://core.test/atlas/", fetch: fetchImpl });
    const admin = new AtlasAdminClient({ baseUrl: "https://core.test/atlas/", fetch: fetchImpl });

    await client.queries.full();
    await admin.auth.me();

    expect(calls).toEqual(["https://core.test/atlas/queries/full", "https://core.test/atlas/admin/auth/me"]);
  });

  it("preserves the base path when opening the websocket feed", async () => {
    const urls: string[] = [];
    const Socket = recordingSocket(urls);
    const client = new AtlasClient({
      baseUrl: "https://core.test/atlas/",
      fetch: async () => Response.json({ protocol_revision: ATLAS_PROTOCOL_REVISION }),
      WebSocket: Socket
    });

    await client.connectFeed();

    expect(urls).toEqual(["wss://core.test/atlas/feed"]);
  });

  it("keeps root-relative websocket feeds on the current origin", async () => {
    const urls: string[] = [];
    const Socket = recordingSocket(urls);
    const client = new AtlasClient({
      baseUrl: "/atlas/",
      fetch: async () => Response.json({ protocol_revision: ATLAS_PROTOCOL_REVISION }),
      WebSocket: Socket
    });

    await client.connectFeed();

    expect(urls).toEqual(["/atlas/feed"]);
  });
});

function recordingSocket(urls: string[]) {
  return class Socket {
    readonly readyState = 1;
    private readonly listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();

    constructor(url: string) {
      urls.push(url);
      queueMicrotask(() => {
        this.dispatch("open", {});
        this.dispatch("message", {
          data: JSON.stringify({ type: "hello", protocol_revision: ATLAS_PROTOCOL_REVISION })
        });
      });
    }
    send(data: string) {
      const message = JSON.parse(data) as { action?: string };
      if (message.action === "subscription_barrier") {
        this.dispatch("message", { data: JSON.stringify({ type: "subscriptions_ready", version: 0 }) });
      }
    }
    close() {
      this.dispatch("close", {});
    }
    addEventListener(type: string, listener: (event: { data?: unknown }) => void) {
      const listeners = this.listeners.get(type) ?? [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }
    removeEventListener(type: string, listener: (event: { data?: unknown }) => void) {
      this.listeners.set(
        type,
        (this.listeners.get(type) ?? []).filter((candidate) => candidate !== listener)
      );
    }
    private dispatch(type: string, event: { data?: unknown }) {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }
  };
}
