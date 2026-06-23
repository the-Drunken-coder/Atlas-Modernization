import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchAppConfig } from "./config.js";

afterEach(() => vi.unstubAllGlobals());

describe("fetchAppConfig", () => {
  it("normalises configured URLs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            atlasBaseUrl: "https://command.test/atlas/",
            protocolRevision: "rev",
            mapStyleUrl: " /styles/dark.json "
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      )
    );
    vi.stubGlobal("location", { origin: "https://command.test" });

    await expect(fetchAppConfig()).resolves.toEqual({
      atlasBaseUrl: "https://command.test/atlas",
      protocolRevision: "rev",
      mapStyleUrl: "https://command.test/styles/dark.json"
    });
  });

  it("omits optional mapStyleUrl when absent or blank", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ atlasBaseUrl: "https://command.test/atlas", protocolRevision: "rev" }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ atlasBaseUrl: "https://command.test/atlas", protocolRevision: "rev", mapStyleUrl: "   " }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })
      );
    vi.stubGlobal("fetch", fetch);

    await expect(fetchAppConfig()).resolves.toStrictEqual({ atlasBaseUrl: "https://command.test/atlas", protocolRevision: "rev" });
    await expect(fetchAppConfig()).resolves.toStrictEqual({ atlasBaseUrl: "https://command.test/atlas", protocolRevision: "rev" });
  });

  it("rejects invalid URL fields", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ atlasBaseUrl: "atlas", protocolRevision: "rev", mapStyleUrl: "http://[bad" }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })
      )
    );

    await expect(fetchAppConfig()).rejects.toThrow("/api/config returned invalid atlasBaseUrl");
  });

  it("rejects invalid mapStyleUrl when atlasBaseUrl is valid", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ atlasBaseUrl: "https://command.test/atlas", protocolRevision: "rev", mapStyleUrl: "http://[bad" }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })
      )
    );

    await expect(fetchAppConfig()).rejects.toThrow("/api/config returned invalid mapStyleUrl");
  });

  it("rejects non-string mapStyleUrl values", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ atlasBaseUrl: "https://command.test/atlas", protocolRevision: "rev", mapStyleUrl: 42 }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })
      )
    );

    await expect(fetchAppConfig()).rejects.toThrow("/api/config returned invalid mapStyleUrl");
  });

  it("rejects empty protocol revisions", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ atlasBaseUrl: "https://command.test/atlas", protocolRevision: "   " }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })
      )
    );

    await expect(fetchAppConfig()).rejects.toThrow("/api/config returned empty protocolRevision");
  });
});
