import { afterEach, describe, expect, it, vi } from "vitest";
import { createAtlasClientFactory, isResourceInstanceTokenPreconditionFailure } from "../../src/server/atlas.js";

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
      id: "local",
      label: "Local Core",
      baseUrl: "http://127.0.0.1:8000"
    })();

    const request = expect(client.queries.full()).rejects.toThrow("Atlas request timed out after 10000ms");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(10_000);

    await request;
  });

  it("recognizes instance-token failures produced by the real HTTP transport", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            success: false,
            message: "Resource instance token precondition failed for entity",
            error_code: "PRECONDITION_FAILED"
          },
          { status: 412 }
        )
      )
    );
    const client = createAtlasClientFactory({
      id: "local",
      label: "Local Core",
      baseUrl: "http://127.0.0.1:8000"
    })();

    const failure = await client.entities.delete("asset-recreated", { instanceToken: "owned-instance" }).then(
      () => undefined,
      (error: unknown) => error
    );

    expect(failure).toBeDefined();
    expect(isResourceInstanceTokenPreconditionFailure(failure)).toBe(true);
  });

  it("does not classify a stale If-Match failure as an instance-token failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            success: false,
            message: "If-Match precondition failed for entity",
            error_code: "PRECONDITION_FAILED"
          },
          { status: 412 }
        )
      )
    );
    const client = createAtlasClientFactory({
      id: "local",
      label: "Local Core",
      baseUrl: "http://127.0.0.1:8000"
    })();

    const failure = await client.entities.delete("asset-recreated", { instanceToken: "owned-instance" }).then(
      () => undefined,
      (error: unknown) => error
    );

    expect(failure).toBeDefined();
    expect(isResourceInstanceTokenPreconditionFailure(failure)).toBe(false);
  });
});
