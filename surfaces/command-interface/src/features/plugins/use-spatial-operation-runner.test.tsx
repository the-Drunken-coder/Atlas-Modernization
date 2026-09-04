import { act, renderHook } from "@testing-library/react";
import type { SpatialOperationResult } from "@the-drunken-coder/atlas-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type SpatialOperationExecutor, useSpatialOperationRunner } from "./use-spatial-operation-runner.js";

const area = { west: -71.001, south: 42, east: -71, north: 42.001 };
const changedArea = { west: -71.002, south: 42, east: -71.001, north: 42.001 };
const response: SpatialOperationResult = {
  features: [
    {
      id: "fixture",
      title: "Fixture",
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [-71.001, 42.001],
            [-71, 42.001],
            [-71, 42],
            [-71.001, 42.001]
          ]
        ]
      },
      fields: [{ label: "Kind", value: "Fixture" }]
    }
  ],
  provenance: { connector_id: "fixture", source: "Fixture" },
  attribution: { text: "Fixture", url: "https://example.test/fixture" },
  retrieved_at: "2026-08-30T12:00:00Z",
  truncation: null
};

describe("useSpatialOperationRunner", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("loads the SDK client when the first spatial search runs", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(response), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const hook = renderHook(() => useSpatialOperationRunner({ baseUrl: "https://core.test" }));

    act(() => {
      hook.result.current.selectTarget({
        pluginId: "fixture",
        pluginName: "Fixture",
        operationId: "inspect",
        operationName: "Inspect"
      });
      hook.result.current.setArea(area);
    });
    await act(async () => hook.result.current.search());

    expect(hook.result.current.result).toEqual(response);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://core.test/plugins/fixture/operations/inspect",
      expect.objectContaining({ method: "POST", credentials: "include" })
    );
  });

  it("rejects invalid areas without replacing the last valid selection", () => {
    const hook = renderHook(() => useSpatialOperationRunner({ executor: { invokeSpatial: vi.fn() } }));

    act(() => hook.result.current.setArea(area));
    act(() =>
      hook.result.current.setArea({
        west: -72,
        south: 41,
        east: -71,
        north: 42
      })
    );

    expect(hook.result.current.area).toEqual(area);
    expect(hook.result.current.status).toBe("error");
    expect(hook.result.current.error).toContain("no larger than 5 km²");
  });

  it("aborts an active request and marks retained results stale when the area changes", async () => {
    const signals: AbortSignal[] = [];
    const executor: SpatialOperationExecutor = {
      invokeSpatial: vi
        .fn<SpatialOperationExecutor["invokeSpatial"]>()
        .mockResolvedValueOnce(response)
        .mockImplementationOnce((_pluginId, _operationId, _area, options) => {
          if (options?.signal) signals.push(options.signal);
          return new Promise((_resolve, reject) => {
            options?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
          });
        })
    };
    const hook = renderHook(() => useSpatialOperationRunner({ executor }));

    act(() => {
      hook.result.current.selectTarget({
        pluginId: "fixture",
        pluginName: "Fixture",
        operationId: "inspect",
        operationName: "Inspect"
      });
      hook.result.current.setArea(area);
    });
    await act(async () => hook.result.current.search());
    expect(hook.result.current.result).toBe(response);

    let refresh: Promise<void> | undefined;
    act(() => {
      refresh = hook.result.current.search();
    });
    expect(hook.result.current.status).toBe("loading");

    act(() => hook.result.current.setArea(changedArea));
    await act(async () => refresh);

    expect(signals[0]?.aborted).toBe(true);
    expect(hook.result.current.area).toEqual(changedArea);
    expect(hook.result.current.result).toBe(response);
    expect(hook.result.current.status).toBe("idle");
    expect(hook.result.current.stale).toBe(true);
  });
});
