import { describe, expect, it } from "vitest";
import { RealClock } from "./clock.js";

describe("real clock", () => {
  it("reports rejected scheduled callbacks", async () => {
    const error = new Error("scheduled failure");
    const reported = new Promise<unknown>((resolve) => {
      new RealClock(resolve).schedule(0, async () => {
        throw error;
      });
    });
    await expect(reported).resolves.toBe(error);
  });
});
