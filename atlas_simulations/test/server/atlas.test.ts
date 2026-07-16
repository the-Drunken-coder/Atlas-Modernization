import { afterEach, describe, expect, it, vi } from "vitest";
import { createAtlasClientFactory } from "../../src/server/atlas.js";

describe("Atlas client factory", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("keeps request timeouts active until the response body settles", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const signal = init?.signal;
        let bodyController: ReadableStreamDefaultController<Uint8Array>;
        signal?.addEventListener("abort", () => {
          bodyController.error(signal.reason);
        });
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              bodyController = controller;
            }
          }),
          { status: 200 }
        );
      })
    );
    const client = createAtlasClientFactory({
      atlasBaseUrl: "http://127.0.0.1:8000",
      port: 0,
      packageRoot: process.cwd()
    })();

    const request = expect(client.queries.full()).rejects.toThrow("Atlas request timed out after 10000ms");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(10_000);

    await request;
  });
});
