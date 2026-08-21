import { describe, expect, it, vi } from "vitest";
import { establishSafetyBarrier, SafetyBarrierError } from "../src/index.js";

describe("establishSafetyBarrier", () => {
  it("runs every execution module and reports all failures", async () => {
    const first = vi.fn(async () => Promise.reject(new Error("first failed")));
    const second = vi.fn(async () => Promise.reject(new Error("second failed")));

    await expect(
      establishSafetyBarrier(
        [
          { id: "first", establishSafeState: first },
          { id: "second", establishSafeState: second }
        ],
        new AbortController().signal
      )
    ).rejects.toEqual(new SafetyBarrierError(["first", "second"]));
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
  });
});
